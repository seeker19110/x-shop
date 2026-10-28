import type { MedusaContainer } from "@medusajs/framework/types";
import { decideIdempotency, ledgerTotals, payloadHash } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type { OrderCancelRow } from "../../modules/returns/service";
import { ReturnsError } from "../../workflows/returns/errors";
import { returnsOf } from "../../workflows/returns/order-context";
import { AUDIT_MODULE } from "../../modules/audit";
import type AuditModuleService from "../../modules/audit/service";
import type { AuditEntry } from "../../modules/audit/service";
import type { AuditCtx } from "../../workflows/returns/refunds";
import { emitSecurityLog } from "../audit/record";
import { CheckoutError } from "../checkout/errors";
import { cancelNativeOrder } from "../checkout/jobs";
import { queryAndProcess } from "../checkout/recheck";
import { pgCode, withCancelLock } from "./cancel";

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

/** Tiền tố khóa chống trùng trong `x_order_cancel` — tách không gian khóa với `/cancel` (`staff:`). */
const KEY_PREFIX = "unverified:";
const OPEN_PAYMENT_STATES = ["created", "pending", "unknown"] as const;

export interface UnverifiedCancelInput {
  order_id: string;
  actor_id: string;
  /** Lý do (10–500 ký tự): đã đối chiếu gì, ở đâu — ghi `x_order_cancel` và audit (audit che PII trong văn tự do). */
  reason: string;
  /** Mã đối chiếu trên cổng merchant VNPAY (định dạng: `MERCHANT_REF_PATTERN`). */
  merchant_ref: string;
  idempotency_key: string;
}

export interface UnverifiedCancelResult {
  outcome: "cancelled";
  from: "awaiting_payment";
  replayed: boolean;
}

/** Vì sao thanh toán của đơn KHÔNG ở diện "chưa xác minh" (409 `PAYMENT_NOT_UNVERIFIED`, trường `reason`). */
export type NotUnverifiedReason = "payment_received" | "no_open_payment" | "hold_active";

/**
 * Diện "chưa xác minh" (T-165, D-118) — đơn `awaiting_payment` (người gọi đã kiểm) mà:
 *  - chưa thu đồng nào (`paid` = ledger ròng ≤ 0; đã thu → hủy thường qua `/cancel` để mở hoàn tiền), và
 *  - attempt mở `unknown` (cổng/querydr không trả lời rõ), hoặc `created|pending` đã quá `hold_expires_at` (biên: đúng
 *    mốc là quá hạn — DATA04).
 * Không còn attempt mở (đã có kết quả thất bại) → job hết hạn hủy bình thường; còn hạn → khách vẫn đang trả.
 */
export function notUnverifiedReason(
  fin: { hold_expires_at: Date | string | null },
  open: { state: string } | undefined,
  paid: number,
  now: Date,
): NotUnverifiedReason | null {
  if (paid > 0) return "payment_received";
  if (!open || !(OPEN_PAYMENT_STATES as readonly string[]).includes(open.state)) return "no_open_payment";
  if (open.state === "unknown") return null;
  if (fin.hold_expires_at !== null && new Date(fin.hold_expires_at).getTime() <= now.getTime()) return null;
  return "hold_active";
}

const NOT_UNVERIFIED_MESSAGES: Record<NotUnverifiedReason, string> = {
  payment_received: "Đơn đã ghi nhận tiền — dùng hủy đơn thường để mở hoàn tiền",
  no_open_payment:
    "Đơn không còn thanh toán đang chờ xác minh — job hết hạn sẽ hủy, hoặc dùng hủy đơn thường",
  hold_active: "Thanh toán còn trong hạn giữ hàng — khách có thể đang trả, chưa được ghi đè",
};

function notAwaiting(state: string): ReturnsError {
  return new ReturnsError(
    "NOT_AWAITING_PAYMENT",
    "Chỉ hủy chưa xác minh được đơn đang chờ thanh toán (đơn đã xác nhận/đã hủy/COD dùng luồng khác)",
    { state },
  );
}

function notUnverified(reason: NotUnverifiedReason): ReturnsError {
  return new ReturnsError("PAYMENT_NOT_UNVERIFIED", NOT_UNVERIFIED_MESSAGES[reason], { reason });
}

function replay(row: OrderCancelRow, hash: string): UnverifiedCancelResult {
  if (decideIdempotency({ payloadHash: row.payload_hash }, hash) === "conflict") {
    throw new ReturnsError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã dùng cho một lệnh hủy khác");
  }
  return { outcome: "cancelled", from: "awaiting_payment", replayed: true };
}

/**
 * Nhân viên `payment.override` hủy đơn có thanh toán CHƯA XÁC MINH sau khi đối chiếu tay trên cổng merchant VNPAY
 * (T-165, D-118; thay hướng dẫn sửa tay ở RUNBOOK §1). Dưới khóa `order:<id>` (cùng khóa với IPN, job hết hạn, hủy
 * thường, hoàn tiền) — kiểm lại mọi điều kiện SAU khi có khóa:
 *
 *  1. Lệnh cùng `Idempotency-Key` (bảng `x_order_cancel`, tiền tố `unverified:`) đã có → trả lại kết quả cũ; khác nội dung
 *     (đơn/lý do/mã đối chiếu) → 409 IDEMPOTENCY_CONFLICT.
 *  2. Đơn không `awaiting_payment` (đã xác nhận do IPN thắng, đã hủy bởi lệnh khác/job, COD…) → 409 NOT_AWAITING_PAYMENT.
 *  3. Không ở diện chưa xác minh (`notUnverifiedReason`) → 409 PAYMENT_NOT_UNVERIFIED.
 *  4. Hỏi cổng lần cuối (querydr, cùng đường IPN — không qua breaker, như hủy thường): cổng báo đã trả → đơn được xác nhận
 *     như IPN và lệnh hủy trả 409 NOT_AWAITING_PAYMENT; không rõ/không hỏi được (VNPAY tắt) → tiếp tục ghi đè.
 *  5. Hủy native (nhả reservation, idempotent) → MỘT transaction module: `cancelled`, attempt mở → failed, mã → released,
 *     outbox `order.cancelled` (`SHOP_CANCELLED`), đóng `payment_unknown`, ghi lệnh hủy (`x_order_cancel`) và audit
 *     `order.cancelled_unverified` (người, lý do, mã đối chiếu, attempt; không PII khách) — cùng commit/rollback.
 *
 * Tiền đến SAU (IPN/querydr thành công) đi AT09 sẵn có: ghi capture + ngoại lệ `late_payment` → kế toán hoàn (RUNBOOK §7);
 * đơn không phục hồi.
 */
export async function cancelUnverified(
  container: MedusaContainer,
  input: UnverifiedCancelInput,
  auditCtx: AuditCtx,
  now: Date = new Date(),
): Promise<UnverifiedCancelResult> {
  const svc = returnsOf(container);
  const key = `${KEY_PREFIX}${input.idempotency_key}`;
  const hash = payloadHash({
    kind: "cancel_unverified",
    order_id: input.order_id,
    reason: input.reason,
    merchant_ref: input.merchant_ref,
  });
  const prior = await svc.findOrderCancelByKey(key);
  if (prior) return replay(prior, hash);
  try {
    return await withCancelLock(container, input.order_id, async () => {
      const again = await svc.findOrderCancelByKey(key);
      if (again) return replay(again, hash);
      const s = service(container);
      const read = async () => {
        const [row] = await s.listOrderFinances({ order_id: input.order_id });
        if (!row) throw new CheckoutError("NOT_FOUND", "Không tìm thấy đơn hàng");
        return row;
      };
      const paidOf = async () => Math.max(0, ledgerTotals(await s.ledgerEntriesOf(input.order_id)).net);

      const fin = await read();
      if (fin.state !== "awaiting_payment") throw notAwaiting(fin.state);
      const [attempt] = await s.listPaymentAttempts(
        { order_id: input.order_id, state: [...OPEN_PAYMENT_STATES] },
        { order: { created_at: "DESC" } },
      );
      const why = notUnverifiedReason(fin, attempt, await paidOf(), now);
      if (why !== null) throw notUnverified(why);
      if (!attempt) throw notUnverified("no_open_payment");

      const q = await queryAndProcess(container, input.order_id, { orderLockHeld: true });
      const after = await read();
      if (after.state !== "awaiting_payment") throw notAwaiting(after.state);
      // Cổng báo ĐÃ TRẢ mà đơn vẫn chờ (vd. `processVerified` trả sớm vì inbox đã có kết quả khác cho cùng sự kiện), hoặc
      // đã có tiền mà thiếu (`record_only`) → tiền có thể đã trừ: không ghi đè (review T-165 🟢2).
      if (q.outcome === "paid" || (await paidOf()) > 0) throw notUnverified("payment_received");

      // Native trước (idempotent), rồi chốt module: lỗi/chết giữa chừng thì lần gọi sau thấy đơn còn chờ và làm lại an toàn.
      await cancelNativeOrder(container, input.order_id);
      // Hủy + lệnh hủy theo Idempotency-Key + audit trong MỘT transaction (review T-165 🟠1): không có trạng thái "đã hủy mà
      // mất dấu" — chết trước commit thì không có gì, gửi lại làm lại; sau commit thì gửi lại được kết quả cũ. Ghi audit
      // trực tiếp (không qua `audit()` nuốt lỗi): audit lỗi → rollback, nhân viên nhận lỗi và gửi lại cùng khóa.
      const written: { audit?: AuditEntry } = {};
      const done = await s.cancelUnverifiedOrder(
        {
          order_id: input.order_id,
          display_ref: after.display_ref,
          now,
          actor_id: input.actor_id,
          merchant_ref: input.merchant_ref,
        },
        async (trx, paymentUnknownClosed) => {
          await svc.insertOrderCancel(
            {
              order_id: input.order_id,
              idempotency_key: key,
              payload_hash: hash,
              actor_id: input.actor_id,
              reason: input.reason,
              outcome: "cancelled",
              from_state: "awaiting_payment",
              refund_requested: false,
              refund_id: null,
            },
            trx,
          );
          written.audit = await container.resolve<AuditModuleService>(AUDIT_MODULE).record(
            {
              ...auditCtx,
              action: "order.cancelled_unverified",
              resource_type: "order",
              resource_id: input.order_id,
              reason: input.reason,
              changes: {
                by: "staff",
                from: "awaiting_payment",
                to: "cancelled",
                merchant_ref: input.merchant_ref,
                payment_attempt_id: attempt.id,
                txn_ref: attempt.txn_ref,
                payment_state: attempt.state,
                querydr: q.outcome,
                payment_unknown_closed: paymentUnknownClosed,
              },
            },
            trx,
          );
        },
      );
      if (!done.cancelled) throw new CheckoutError("BUSY_RETRY");
      if (written.audit !== undefined) emitSecurityLog(container, written.audit);
      return { outcome: "cancelled", from: "awaiting_payment", replayed: false } as const;
    });
  } catch (e) {
    // Khóa đơn hết hạn giữa chừng và một request cùng khóa đã ghi trước → trả kết quả của nó.
    if (pgCode(e) === "23505") {
      const winner = await svc.findOrderCancelByKey(key);
      if (winner) return replay(winner, hash);
    }
    throw e;
  }
}
