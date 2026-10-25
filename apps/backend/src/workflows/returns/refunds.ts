import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  can,
  canApproveRefund,
  checkRefundAllowed,
  decideIdempotency,
  ledgerTotals,
  payloadHash,
  sumVnd,
  type LedgerEntry,
} from "@x-shop/domain";
import { recordAudit } from "../../lib/audit/record";
import type { AuditEntryInput } from "../../modules/audit/service";
import { cancelNativeOrder } from "../../lib/checkout/jobs";
import { RETURNS_CONFIG, type RefundMethod, type RefundReason } from "../../modules/returns/constants";
import type { RefundRow } from "../../modules/returns/service";
import type ReturnsModuleService from "../../modules/returns/service";
import { ReturnsError } from "./errors";
import { checkoutOf, loadOrderContext, returnsOf, withOrderLock, type OrderContext } from "./order-context";
import { getRefundGateway, type ProviderRefundRequest, type ProviderRefundResult } from "./refund-gateway";

type Scope = Pick<MedusaContainer, "resolve">;

/** Người thao tác (đã qua RBAC ở route) — `roles` dùng cho quy tắc duyệt hai người (S-403). */
export interface Actor {
  id: string;
  roles: readonly string[];
}

/** Ngữ cảnh audit (actor, request id, IP băm) — `auditContextOf(req)` ở route, hoặc hệ thống. */
export type AuditCtx = Pick<AuditEntryInput, "actor_type" | "actor_id" | "request_id" | "ip_hash">;

export const SYSTEM_AUDIT: AuditCtx = {
  actor_type: "system",
  actor_id: null,
  request_id: null,
  ip_hash: null,
};

export async function audit(
  container: Scope,
  ctx: AuditCtx,
  entry: Omit<AuditEntryInput, "actor_type" | "actor_id" | "request_id" | "ip_hash">,
): Promise<void> {
  try {
    await recordAudit(container, { ...ctx, ...entry });
  } catch (e) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .error(`[returns] Không ghi được audit ${entry.action}: ${(e as Error).message}`);
  }
}

/** Khoản đã thu hợp lệ của đơn. COD đã giao: tiền hãng thu hộ là khoản thu (chứng từ COD đối soát riêng ở T-028). */
export interface CaptureInfo {
  provider: string;
  provider_txn_id: string;
  amount: number;
}

export async function capturesOf(container: Scope, ctx: OrderContext): Promise<CaptureInfo[]> {
  const rows = await checkoutOf(container).listPaymentLedgers(
    { order_id: ctx.fin.order_id, kind: "capture" },
    { order: { created_at: "ASC" } },
  );
  const caps: CaptureInfo[] = rows.map((r) => ({
    provider: r.provider,
    provider_txn_id: r.provider_txn_id,
    amount: Number(r.amount),
  }));
  const s = ctx.shipment;
  if (s && s.state === "delivered" && s.cod_amount > 0) {
    caps.push({ provider: "cod", provider_txn_id: `cod:${s.client_order_code}`, amount: s.cod_amount });
  }
  return caps;
}

/**
 * Bút toán cho bất biến S-108: khoản thu từ ledger (+ COD đã giao) và hoàn tiền từ bảng `x_refund` (nguồn sự thật của
 * hoàn tiền, MỌI trạng thái — domain tính "đang giữ" gồm requested/approved/processing/unknown/failed). Dòng refund trong
 * payment_ledger chỉ là bản ghi tiền đã hoàn xong, không đếm lại ở đây.
 */
function entriesOf(captures: readonly CaptureInfo[], refunds: readonly RefundRow[]): LedgerEntry[] {
  return [
    ...captures.map((c) => ({
      kind: "capture" as const,
      amount: c.amount,
      providerTxnId: c.provider_txn_id,
    })),
    ...refunds.map((r) => ({ kind: "refund" as const, amount: r.amount, refundId: r.id, state: r.state })),
  ];
}

export function refundableOf(captures: readonly CaptureInfo[], refunds: readonly RefundRow[]): number {
  const t = ledgerTotals(entriesOf(captures, refunds));
  return Math.max(0, t.captured - t.refundSucceeded - t.refundHeld);
}

/** Khoản thu VNPAY còn đủ chỗ cho một lần hoàn qua cổng (mỗi refund cổng gắn MỘT giao dịch gốc). */
function pickProviderCapture(
  captures: readonly CaptureInfo[],
  refunds: readonly RefundRow[],
  amount: number,
): CaptureInfo | null {
  for (const c of captures.filter((x) => x.provider === "vnpay")) {
    const used = sumVnd(
      refunds
        .filter(
          (r) => r.method === "provider" && r.capture_ref === c.provider_txn_id && r.state !== "rejected",
        )
        .map((r) => r.amount),
    );
    if (c.amount - used >= amount) return c;
  }
  return null;
}

interface RefundDraft {
  reason: RefundReason;
  amount: number;
  return_id: string | null;
  method: RefundMethod | "auto";
  requested_by: string;
  requester_can_approve: boolean;
  note: string | null;
  idempotency_key: string;
  payload_hash: string;
}

/**
 * Ghi MỘT yêu cầu hoàn tiền — gọi trong transaction đã giữ `lockOrder` (Postgres advisory) nên hai yêu cầu song song
 * không cùng vượt: Σ hoàn thành công + Σ đang giữ + yêu cầu mới ≤ Σ đã thu (S-108, AT16). Khoản thu chỉ tăng (ledger
 * không xoá) nên đọc trước transaction là an toàn.
 *
 * Duyệt (S-403): người tạo có `refund.approve` và số tiền KHÔNG vượt ngưỡng → duyệt luôn; còn lại `requested` chờ người
 * thứ hai (khác người tạo).
 */
export async function insertRefundLocked(
  svc: ReturnsModuleService,
  trx: Knex.Transaction,
  ctx: OrderContext,
  captures: readonly CaptureInfo[],
  d: RefundDraft,
): Promise<RefundRow> {
  const refunds = await svc.listRefundsOfOrder(ctx.fin.order_id, trx);
  const allowed = checkRefundAllowed(entriesOf(captures, refunds), d.amount);
  if (!allowed.ok) {
    throw allowed.code === "VALIDATION"
      ? new ReturnsError("VALIDATION", allowed.message, { field: "amount" })
      : new ReturnsError("REFUND_EXCEEDS_CAPTURED", allowed.message, {
          refundable: refundableOf(captures, refunds),
        });
  }
  const pick = pickProviderCapture(captures, refunds, d.amount);
  let method: RefundMethod;
  if (d.method === "provider") {
    if (!pick) {
      const hasVnpay = captures.some((c) => c.provider === "vnpay");
      throw hasVnpay
        ? new ReturnsError(
            "REFUND_SPLIT_REQUIRED",
            "Số tiền vượt một giao dịch gốc — chia thành nhiều lần hoàn",
          )
        : new ReturnsError("REFUND_METHOD_UNAVAILABLE", "Đơn không có giao dịch cổng để hoàn — dùng manual");
    }
    method = "provider";
  } else if (d.method === "manual") method = "manual";
  else method = pick ? "provider" : "manual";
  const capture = method === "provider" ? pick : null;
  const approvalRequired = d.amount > RETURNS_CONFIG.refundApprovalThresholdVnd;
  const autoApprove = d.requester_can_approve && !approvalRequired;
  return svc.insertRefund(trx, {
    order_id: ctx.fin.order_id,
    return_id: d.return_id,
    reason: d.reason,
    amount: d.amount,
    method,
    provider: capture ? capture.provider : "manual",
    capture_ref: capture ? capture.provider_txn_id : null,
    state: autoApprove ? "approved" : "requested",
    approval_required: approvalRequired,
    requested_by: d.requested_by,
    approved_by: autoApprove ? d.requested_by : null,
    approved_at: autoApprove ? new Date() : null,
    note: d.note,
    idempotency_key: d.idempotency_key,
    payload_hash: d.payload_hash,
  });
}

const pgCode = (e: unknown) =>
  typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
const pgConstraint = (e: unknown) =>
  typeof e === "object" && e !== null ? (e as { constraint?: string }).constraint : undefined;

function replayOrConflict(existing: RefundRow, hash: string): RefundRow {
  if (decideIdempotency({ payloadHash: existing.payload_hash }, hash) === "conflict") {
    throw new ReturnsError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã dùng cho một yêu cầu hoàn tiền khác");
  }
  return existing;
}

export interface CreateRefundInput {
  order_id: string;
  reason: Exclude<RefundReason, "return">;
  /** null → (chỉ với `cancellation`) toàn bộ số còn hoàn được. */
  amount: number | null;
  method: RefundMethod | "auto";
  note: string | null;
  idempotency_key: string;
}

/**
 * Tạo yêu cầu hoàn tiền từ Admin (S-108, S-403). Hoàn theo trả hàng KHÔNG đi đường này — nó được tạo khi kiểm định với
 * số tiền tính theo giá thực trả (AT15). `cancellation` chỉ cho đơn đã hủy; lý do khác cần `amount` và ghi chú.
 */
export async function createRefund(
  container: Scope,
  input: CreateRefundInput,
  actor: Actor,
  auditCtx: AuditCtx,
): Promise<{ refund: RefundRow; replayed: boolean }> {
  const svc = returnsOf(container);
  const key = `adm:${input.idempotency_key}`;
  const hash = payloadHash({
    order_id: input.order_id,
    reason: input.reason,
    amount: input.amount,
    method: input.method,
    note: input.note,
  });
  const prior = await svc.findRefundByKey(key);
  if (prior) return { refund: replayOrConflict(prior, hash), replayed: true };

  const ctx = await loadOrderContext(container, input.order_id);
  if (input.reason === "cancellation" && ctx.fin.state !== "cancelled") {
    throw new ReturnsError("INVALID_STATE", "Hoàn tiền hủy đơn chỉ áp dụng cho đơn đã hủy", {
      order_state: ctx.fin.state,
    });
  }
  if (input.reason !== "cancellation" && input.amount === null) {
    throw new ReturnsError("VALIDATION", "Cần số tiền hoàn", { field: "amount" });
  }
  const captures = await capturesOf(container, ctx);
  try {
    const refund = await svc.transaction(async (trx) => {
      await svc.lockOrder(trx, input.order_id);
      const again = await svc.findRefundByKey(key, trx);
      if (again) return { row: replayOrConflict(again, hash), replayed: true };
      const amount =
        input.amount ?? refundableOf(captures, await svc.listRefundsOfOrder(input.order_id, trx));
      const row = await insertRefundLocked(svc, trx, ctx, captures, {
        reason: input.reason,
        amount,
        return_id: null,
        method: input.method,
        requested_by: actor.id,
        requester_can_approve: can(actor.roles, "refund.approve"),
        note: input.note,
        idempotency_key: key,
        payload_hash: hash,
      });
      return { row, replayed: false };
    });
    if (!refund.replayed) {
      await audit(container, auditCtx, {
        action: "refund.requested",
        resource_type: "refund",
        resource_id: refund.row.id,
        reason: input.note,
        changes: refundChanges(refund.row),
      });
    }
    return { refund: refund.row, replayed: refund.replayed };
  } catch (e) {
    if (pgCode(e) === "23505") {
      const winner = await svc.findRefundByKey(key);
      if (winner) return { refund: replayOrConflict(winner, hash), replayed: true };
      if (pgConstraint(e) === "IDX_x_refund_cancellation_unique") {
        throw new ReturnsError("INVALID_STATE", "Đơn đã có yêu cầu hoàn tiền hủy đơn");
      }
    }
    throw e;
  }
}

/**
 * Hủy đơn đã thu tiền (POST02, D-012): mở yêu cầu hoàn toàn bộ số còn hoàn được — KHÔNG chờ hàng trả/kiểm định. Khóa
 * `cancel:<order>` cố định nên gọi lặp không tạo thêm. Người tạo là "customer" → mọi người có `refund.approve` duyệt được.
 */
export async function openCancellationRefund(
  container: Scope,
  orderId: string,
  auditCtx: AuditCtx = SYSTEM_AUDIT,
): Promise<RefundRow | null> {
  const svc = returnsOf(container);
  const key = `cancel:${orderId}`;
  const prior = await svc.findRefundByKey(key);
  if (prior) return prior;
  const ctx = await loadOrderContext(container, orderId);
  if (ctx.fin.state !== "cancelled") return null;
  const captures = await capturesOf(container, ctx);
  try {
    const row = await svc.transaction(async (trx) => {
      await svc.lockOrder(trx, orderId);
      const again = await svc.findRefundByKey(key, trx);
      if (again) return again;
      const amount = refundableOf(captures, await svc.listRefundsOfOrder(orderId, trx));
      if (amount <= 0) return null;
      return insertRefundLocked(svc, trx, ctx, captures, {
        reason: "cancellation",
        amount,
        return_id: null,
        method: "auto",
        requested_by: "customer",
        requester_can_approve: false,
        note: "Khách hủy đơn đã thanh toán",
        idempotency_key: key,
        payload_hash: payloadHash({ order_id: orderId, reason: "cancellation" }),
      });
    });
    if (row) {
      await audit(container, auditCtx, {
        action: "refund.requested",
        resource_type: "refund",
        resource_id: row.id,
        reason: "CUSTOMER_CANCELLED",
        changes: refundChanges(row),
      });
    }
    return row;
  } catch (e) {
    if (pgCode(e) === "23505") return (await svc.findRefundByKey(key)) ?? null;
    throw e;
  }
}

export function refundChanges(r: RefundRow): Record<string, unknown> {
  return {
    order_id: r.order_id,
    return_id: r.return_id,
    reason: r.reason,
    amount: r.amount,
    method: r.method,
    state: r.state,
    approval_required: r.approval_required,
  };
}

/** Duyệt (S-403): cần `refund.approve`, KHÁC người tạo. Đã duyệt → trả nguyên (idempotent). */
export async function approveRefund(
  container: Scope,
  id: string,
  approver: Actor,
  auditCtx: AuditCtx,
): Promise<{ refund: RefundRow; changed: boolean }> {
  const svc = returnsOf(container);
  const r = await svc.getRefund(id);
  if (!r) throw new ReturnsError("NOT_FOUND", "Không tìm thấy yêu cầu hoàn tiền");
  const check = canApproveRefund(approver, r.requested_by);
  if (!check.ok) {
    throw check.reason === "SELF_APPROVAL"
      ? new ReturnsError("SELF_APPROVAL", "Người tạo yêu cầu không tự duyệt được — cần người thứ hai")
      : new ReturnsError("FORBIDDEN", "Cần quyền refund.approve");
  }
  if (r.state !== "requested") {
    if (r.state === "rejected") throw new ReturnsError("INVALID_STATE", "Yêu cầu đã bị từ chối");
    return { refund: r, changed: false };
  }
  const moved = await svc.updateRefund(null, id, ["requested"], {
    state: "approved",
    approved_by: approver.id,
    approved_at: new Date(),
  });
  if (!moved) return { refund: (await svc.getRefund(id)) as RefundRow, changed: false };
  await audit(container, auditCtx, {
    action: "refund.approved",
    resource_type: "refund",
    resource_id: id,
    changes: { ...refundChanges(moved), requested_by: moved.requested_by },
  });
  return { refund: moved, changed: true };
}

export async function rejectRefund(
  container: Scope,
  id: string,
  actor: Actor,
  reason: string,
  auditCtx: AuditCtx,
): Promise<RefundRow> {
  const svc = returnsOf(container);
  const r = await svc.getRefund(id);
  if (!r) throw new ReturnsError("NOT_FOUND", "Không tìm thấy yêu cầu hoàn tiền");
  if (r.state === "rejected") return r;
  const moved = await svc.updateRefund(null, id, ["requested"], {
    state: "rejected",
    rejected_by: actor.id,
    rejected_at: new Date(),
    reject_reason: reason,
  });
  if (!moved)
    throw new ReturnsError("INVALID_STATE", "Chỉ từ chối được yêu cầu chưa duyệt", { state: r.state });
  await audit(container, auditCtx, {
    action: "refund.rejected",
    resource_type: "refund",
    resource_id: id,
    reason,
    changes: refundChanges(moved),
  });
  return moved;
}

async function providerRequestOf(
  container: Scope,
  r: RefundRow,
  actor: Actor,
): Promise<ProviderRefundRequest> {
  const capture = r.capture_ref as string;
  const svc = checkoutOf(container);
  const attempts = capture.startsWith("ref:")
    ? await svc.listPaymentAttempts({ order_id: r.order_id, txn_ref: capture.slice(4) })
    : await svc.listPaymentAttempts({ order_id: r.order_id, provider_txn_no: capture });
  const pa = attempts[0];
  if (!pa)
    throw new ReturnsError("REFUND_METHOD_UNAVAILABLE", "Không tìm thấy giao dịch gốc để hoàn qua cổng");
  const [ledger] = await svc.listPaymentLedgers({
    order_id: r.order_id,
    kind: "capture",
    provider_txn_id: capture,
  });
  const others = (await returnsOf(container).listRefundsOfOrder(r.order_id)).filter(
    (x) => x.id !== r.id && x.method === "provider" && x.capture_ref === capture && x.state !== "rejected",
  );
  return {
    requestId: r.provider_request_id,
    txnRef: pa.txn_ref,
    transactionNo: capture.startsWith("ref:") ? "" : capture,
    transactionDate: new Date(pa.created_at),
    amount: r.amount,
    full: others.length === 0 && Number(ledger?.amount ?? 0) === r.amount,
    createdBy: actor.id.slice(0, 64),
    orderInfo: `Hoan tien ${r.id}`,
  };
}

/** Ghi bút toán `refund` (đã hoàn xong) vào payment_ledger MỘT lần — UNIQUE(provider, provider_txn_id, kind). */
async function syncLedger(container: Scope, r: RefundRow): Promise<void> {
  if (r.state !== "succeeded") return;
  const svc = checkoutOf(container);
  const existing = await svc.listPaymentLedgers({ kind: "refund", refund_id: r.id });
  if (existing.length > 0) return;
  try {
    await svc.createPaymentLedgers({
      order_id: r.order_id,
      kind: "refund",
      amount: r.amount,
      provider: r.provider,
      provider_txn_id: r.id,
      refund_id: r.id,
      state: "succeeded",
    });
  } catch (e) {
    if ((await svc.listPaymentLedgers({ kind: "refund", refund_id: r.id })).length === 0) throw e;
  }
}

/**
 * Sau khi tiền đã hoàn thật: bút toán ledger; yêu cầu trả liên quan → closed; hoàn do hủy đơn → hủy đơn native (D-012:
 * hủy native cùng lúc tiền đã hoàn) + đóng ngoại lệ `refund_request`. Idempotent — gọi lại an toàn.
 */
async function afterRefundSucceeded(container: Scope, r: RefundRow): Promise<void> {
  await syncLedger(container, r);
  const svc = returnsOf(container);
  if (r.return_id) {
    await svc.updateReturn(null, r.return_id, ["inspected"], { state: "closed", closed_at: new Date() });
  }
  if (r.reason === "cancellation") {
    try {
      await cancelNativeOrder(container as MedusaContainer, r.order_id);
    } catch (e) {
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .error(`[returns] Hủy đơn native ${r.order_id} sau hoàn tiền lỗi: ${(e as Error).message}`);
      return;
    }
    const checkout = checkoutOf(container);
    const open = await checkout.listOpsExceptions({
      order_id: r.order_id,
      kind: "refund_request",
      state: ["open", "in_progress"],
    });
    for (const ex of open) await checkout.updateOpsExceptions({ id: ex.id, state: "resolved" });
  }
}

export interface ExecuteResult {
  refund: RefundRow;
  outcome: "succeeded" | "failed" | "unknown" | "already_succeeded";
}

/**
 * Thực hiện hoàn tiền (quyền `refund.execute`) dưới khóa `order:<id>`:
 *  - `manual`: cần `evidence_ref` (mã chứng từ chuyển khoản/COD) → succeeded;
 *  - `provider`: approved|failed → processing → gọi cổng với `provider_request_id` cố định. Timeout → `unknown` + ngoại lệ
 *    `refund_unknown`; gọi lại → HỎI cổng cùng mã trước, chỉ gửi lại khi cổng chưa từng nhận (AT16 — không hoàn trùng).
 * Đã succeeded → trả nguyên (idempotent).
 */
export async function executeRefund(
  container: Scope,
  id: string,
  actor: Actor,
  opts: { evidence_ref: string | null },
  auditCtx: AuditCtx,
): Promise<ExecuteResult> {
  const svc = returnsOf(container);
  const first = await svc.getRefund(id);
  if (!first) throw new ReturnsError("NOT_FOUND", "Không tìm thấy yêu cầu hoàn tiền");
  return withOrderLock(container, first.order_id, async () => {
    let r = (await svc.getRefund(id)) as RefundRow;
    if (r.state === "succeeded") {
      await afterRefundSucceeded(container, r);
      return { refund: r, outcome: "already_succeeded" as const };
    }
    if (r.state === "requested") {
      throw new ReturnsError("REFUND_NOT_APPROVED", "Yêu cầu hoàn tiền chưa được duyệt", {
        approval_required: r.approval_required,
      });
    }
    if (r.state === "rejected") throw new ReturnsError("INVALID_STATE", "Yêu cầu hoàn tiền đã bị từ chối");

    let result: ProviderRefundResult;
    if (r.method === "manual") {
      const evidence = opts.evidence_ref?.trim() ?? "";
      if (!evidence) {
        throw new ReturnsError("VALIDATION", "Hoàn ngoài hệ thống cần mã chứng từ (evidence_ref)", {
          field: "evidence_ref",
        });
      }
      // Hoàn ngoài hệ thống không có trạng thái "chưa rõ": approved|failed → processing → succeeded; processing còn sót
      // (sập giữa chừng) → chốt luôn với chứng từ.
      if (r.state === "approved" || r.state === "failed") {
        const p = await svc.updateRefund(null, id, [r.state], {
          state: "processing",
          executed_by: actor.id,
          attempts_increment: true,
          evidence_ref: evidence,
        });
        if (!p) throw new ReturnsError("REFUND_IN_PROGRESS", "Yêu cầu đang được xử lý");
        r = p;
      }
      result = { outcome: "succeeded", providerRef: evidence, reason: "manual_evidence" };
    } else {
      const gateway = getRefundGateway();
      if (!gateway.enabled) {
        throw new ReturnsError(
          "REFUND_PROVIDER_DISABLED",
          "Hoàn qua cổng chưa được bật ở môi trường này — dùng hoàn ngoài hệ thống có chứng từ",
        );
      }
      const req = await providerRequestOf(container, r, actor);
      let known: ProviderRefundResult | null = null;
      if (r.state === "unknown" || r.state === "processing") {
        // Lần trước chưa rõ kết quả (timeout/sập giữa chừng) → hỏi CÙNG mã trước khi gửi lại.
        const q = await gateway.query(req).catch((): ProviderRefundResult => ({
          outcome: "unknown",
          providerRef: null,
          reason: "query_error",
        }));
        if (q.outcome === "not_found") {
          if (r.state === "unknown") {
            r = (await svc.updateRefund(null, id, ["unknown"], {
              state: "failed",
              last_error: "not_found_at_provider",
            })) as RefundRow;
          }
        } else known = q;
      }
      if (known) {
        result = known;
      } else {
        if (r.state === "approved" || r.state === "failed") {
          const p = await svc.updateRefund(null, id, [r.state], {
            state: "processing",
            executed_by: actor.id,
            attempts_increment: true,
          });
          if (!p) throw new ReturnsError("REFUND_IN_PROGRESS", "Yêu cầu đang được xử lý");
          r = p;
        }
        result = await gateway
          .refund(req)
          .catch(() => ({ outcome: "unknown" as const, providerRef: null, reason: "network" }));
      }
    }

    const from = r.state === "unknown" ? (["unknown"] as const) : (["processing"] as const);
    let after = r;
    if (!(r.state === "unknown" && result.outcome === "unknown")) {
      const moved = await svc.updateRefund(null, id, from, {
        state: result.outcome,
        provider_ref: result.providerRef ?? r.provider_ref,
        last_error: result.outcome === "succeeded" ? null : result.reason.slice(0, 200),
        ...(result.outcome === "succeeded" && { succeeded_at: new Date() }),
      });
      after = moved ?? ((await svc.getRefund(id)) as RefundRow);
    }
    if (after.state === "unknown") {
      await checkoutOf(container).openOpsException({
        kind: "refund_unknown",
        dedupe_key: `refund_unknown:${id}`,
        order_id: after.order_id,
        amount: after.amount,
        priority: "high",
        due_at: new Date(Date.now() + 30 * 60_000),
        detail: { refund_id: id, reason: result.reason },
      });
    }
    if (after.state === "succeeded") await afterRefundSucceeded(container, after);
    await audit(container, auditCtx, {
      action: `refund.${after.state === "succeeded" ? "succeeded" : after.state === "failed" ? "failed" : "unknown"}`,
      resource_type: "refund",
      resource_id: id,
      changes: { ...refundChanges(after), attempts: after.attempts, provider_reason: result.reason },
    });
    const outcome =
      after.state === "succeeded" ? "succeeded" : after.state === "failed" ? "failed" : "unknown";
    return { refund: after, outcome };
  });
}

export function presentRefund(r: RefundRow) {
  return {
    id: r.id,
    order_id: r.order_id,
    return_id: r.return_id,
    reason: r.reason,
    amount: r.amount,
    method: r.method,
    provider: r.provider,
    state: r.state,
    approval_required: r.approval_required,
    requested_by: r.requested_by,
    approved_by: r.approved_by,
    approved_at: r.approved_at ? new Date(r.approved_at).toISOString() : null,
    rejected_by: r.rejected_by,
    reject_reason: r.reject_reason,
    executed_by: r.executed_by,
    provider_ref: r.provider_ref,
    evidence_ref: r.evidence_ref,
    attempts: r.attempts,
    last_error: r.last_error,
    note: r.note,
    succeeded_at: r.succeeded_at ? new Date(r.succeeded_at).toISOString() : null,
    created_at: new Date(r.created_at).toISOString(),
  };
}

/** Tổng hợp tiền của đơn cho Admin: đã thu, đã hoàn, đang giữ, còn hoàn được. */
export async function refundSummary(container: Scope, orderId: string) {
  const ctx = await loadOrderContext(container, orderId);
  const captures = await capturesOf(container, ctx);
  const refunds = await returnsOf(container).listRefundsOfOrder(orderId);
  const t = ledgerTotals(entriesOf(captures, refunds));
  return {
    order_id: orderId,
    captured: t.captured,
    refunded: t.refundSucceeded,
    held: t.refundHeld,
    refundable: Math.max(0, t.captured - t.refundSucceeded - t.refundHeld),
    refunds: refunds.map(presentRefund),
  };
}
