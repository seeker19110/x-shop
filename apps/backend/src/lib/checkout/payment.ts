import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createOrderPaymentCollectionWorkflow,
  markPaymentCollectionAsPaid,
} from "@medusajs/medusa/core-flows";
import { payloadHash, vnpay, isNonEmpty } from "@x-shop/domain";
import { randomUUID } from "node:crypto";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import { verifyNotificationWithRotation, type SecretUsed } from "../payment/vnpay-secrets";
import type CheckoutModuleService from "../../modules/checkout/service";
import { CHECKOUT_CONFIG, getVnpayIpnKeys } from "./config";
import { readCheckoutError } from "./errors";
import { acquireOrdered, lockKeys, releaseOwnedOrWarn } from "./locks";

/**
 * Xử lý thông báo thanh toán VNPAY (docs/design/checkout-flow.md §4) — DÙNG CHUNG cho IPN (`source: "ipn"`) và kết quả
 * querydr (`source: "query"`, từ nút "Kiểm tra lại" hoặc job hết hạn). Không bao giờ đi qua webhook payment native
 * hay processPaymentWorkflow (chúng tự hoàn tất giỏ — AT35).
 */
export type IpnResponse = vnpay.IpnResponse;
export type NotificationSource = "ipn" | "query";

const R = vnpay.IPN_RESPONSES;
const PROVIDER = "vnpay";

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

/** Chỉ giữ tham số `vnp_*` (không PII của khách — VNPAY không gửi tên/SĐT), giới hạn độ dài. */
function sanitize(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([k]) => k.startsWith("vnp_"))
      .slice(0, 64)
      .map(([k, v]) => [k.slice(0, 64), String(v).slice(0, 1024)]),
  );
}

/** Query IPN thô (Express) → bản đồ chuỗi; tham số lặp/mảng bị loại (không mơ hồ khi ký). */
export function flattenQuery(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Xác minh bằng khoá TRƯỚC → cảnh báo có cấu trúc (khoá=`previous`, nguồn, mã giao dịch) để vận hành biết còn lưu lượng
 * dùng khoá cũ (RUNBOOK §9 bước 4). KHÔNG ghi khoá/chữ ký. Lỗi logger không được làm hỏng xử lý thanh toán.
 */
export function warnIfPreviousSecret(
  container: MedusaContainer,
  secretUsed: SecretUsed | undefined,
  source: NotificationSource,
  txnRef: string | undefined,
): void {
  if (secretUsed !== "previous") return;
  try {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[payment] vnpay_secret_previous_used source=${source} txn_ref=${isNonEmpty(txnRef) ? txnRef.slice(0, 64) : "-"} — xác minh bằng VNPAY_HASH_SECRET_PREVIOUS (khoá trước)`,
      );
  } catch {
    // log hỏng không chặn IPN
  }
}

/**
 * IPN GET từ VNPAY: xác minh → inbox → xử lý → phản hồi `{RspCode, Message}`. Xác minh bằng `getVnpayIpnKeys()` (T-166):
 * VNPAY_ENABLED=false chỉ chặn tạo thanh toán mới — IPN của giao dịch đã tạo vẫn xác minh và ghi nhận (RUNBOOK §1). Không
 * có khoá xác minh → 99 (VNPAY gửi lại sau, như khi bận khóa) và KHÔNG ghi gì (không inbox, không ngoại lệ, không tiền).
 */
export async function handleVnpayIpn(
  container: MedusaContainer,
  query: Record<string, string>,
): Promise<IpnResponse> {
  const cfg = getVnpayIpnKeys();
  if (!cfg) {
    try {
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(
          `[payment] IPN VNPAY tới khi không có khoá xác minh (VNPAY tắt, thiếu VNPAY_TMN_CODE/VNPAY_HASH_SECRET) — trả 99 để VNPAY gửi lại, không ghi nhận`,
        );
    } catch {
      // log hỏng không chặn IPN
    }
    return R.unknownError;
  }
  // Nhận khoá hiện tại hoặc khoá trước trong cửa sổ xoay (T-099).
  const verified = verifyNotificationWithRotation(cfg, query);
  if (!verified.ok) {
    const payload = sanitize(query);
    const hash = payloadHash(payload);
    const s = service(container);
    const response = verified.code === "MALFORMED" ? R.unknownError : R.invalidSignature;
    const inbox = await s.recordInbox({
      provider: PROVIDER,
      event_key: `rejected:${hash}`,
      source: "ipn",
      payload,
      payload_hash: hash,
      verified: false,
    });
    await s.markInboxProcessed(inbox.id, { ...response, reason: verified.code });
    await s.openOpsException({
      kind: "webhook_rejected",
      dedupe_key: `webhook_rejected:${PROVIDER}:${hash}`,
      priority: "high",
      detail: { reason: verified.code, txn_ref: payload.vnp_TxnRef ?? null },
    });
    return response;
  }
  warnIfPreviousSecret(container, verified.secretUsed, "ipn", query.vnp_TxnRef);
  return processVerified(container, verified.value, "ipn", sanitize(query));
}

/**
 * Thông báo đã xác minh (IPN hoặc querydr). Event key = txnRef|transactionNo|responseCode|transactionStatus: cùng một
 * sự kiện từ IPN và từ querydr trùng khóa → chỉ xử lý một lần.
 */
export async function processVerified(
  container: MedusaContainer,
  n: vnpay.VerifiedNotification,
  source: NotificationSource,
  payload: Record<string, string>,
  opts: { orderLockHeld?: boolean } = {},
): Promise<IpnResponse> {
  const s = service(container);
  const eventKey = `${n.txnRef}|${n.transactionNo}|${n.responseCode}|${n.transactionStatus}`;
  const inbox = await s.recordInbox({
    provider: PROVIDER,
    event_key: eventKey,
    source,
    payload,
    payload_hash: payloadHash(payload),
    verified: true,
  });
  if (!inbox.inserted && inbox.result) {
    // Đã xử lý: thành công trước đó → "02 đã xác nhận" (AT06); kết quả khác → trả lại y nguyên.
    const prev = inbox.result as { RspCode?: string };
    return prev.RspCode === R.success.RspCode
      ? R.alreadyConfirmed
      : (pickResponse(prev.RspCode) ?? R.unknownError);
  }
  const result = await processUnderOrderLock(container, n, opts.orderLockHeld === true);
  if (result !== R.unknownError) await s.markInboxProcessed(inbox.id, { ...result });
  return result;
}

function pickResponse(code: string | undefined): IpnResponse | null {
  return Object.values(R).find((r) => r.RspCode === code) ?? null;
}

/** `lockHeld` = caller (job hết hạn) đã giữ khóa `order:<id>` — không lấy lại (khóa không tái nhập theo chủ khác). */
async function processUnderOrderLock(
  container: MedusaContainer,
  n: vnpay.VerifiedNotification,
  lockHeld: boolean,
): Promise<IpnResponse> {
  const s = service(container);
  const [attempt] = await s.listPaymentAttempts({ txn_ref: n.txnRef, provider: PROVIDER });
  // Không có attempt (kể cả đơn COD — không bao giờ có payment attempt) → 01.
  if (!attempt) return R.orderNotFound;
  if (n.amount !== attempt.amount) {
    await s.openOpsException({
      kind: "webhook_rejected",
      dedupe_key: `amount_mismatch:${PROVIDER}:${n.txnRef}|${n.transactionNo}`,
      order_id: attempt.order_id,
      amount: n.amount,
      priority: "high",
      detail: { reason: "amount_mismatch", expected: attempt.amount, received: n.amount, txn_ref: n.txnRef },
    });
    return R.invalidAmount;
  }
  const locking = container.resolve(Modules.LOCKING);
  const owner = `pay:${randomUUID()}`;
  try {
    if (!lockHeld) {
      await acquireOrdered(locking, [lockKeys.order(attempt.order_id)], {
        ownerId: owner,
        waitMs: CHECKOUT_CONFIG.orderLockWaitMs,
        ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
        scope: "order",
      });
    }
  } catch (e) {
    if (readCheckoutError(e)?.code === "BUSY_RETRY") return R.unknownError; // VNPAY gửi lại sau
    throw e;
  }
  try {
    if (!n.success) {
      // Giao dịch không thành công: attempt → failed (nếu còn mở); đơn giữ nguyên chờ hết hạn/thanh toán lại. Đơn đang
      // backoff của expire-holds (T-164) → bỏ hẹn: đã có tin chắc chắn, lượt kế tiếp xét ngay (không giữ hàng thêm).
      await s.movePaymentAttempt(attempt.id, "failed", n.transactionNo || null);
      await s.clearHoldRecheck(attempt.order_id);
      return R.success;
    }
    const outcome = await s.applyCapture({
      order_id: attempt.order_id,
      payment_attempt_id: attempt.id,
      provider: PROVIDER,
      provider_txn_id: n.transactionNo || `ref:${n.txnRef}`,
      amount: n.amount,
      now: new Date(),
    });
    if (outcome.duplicate) return R.alreadyConfirmed;
    if (outcome.decision.action === "confirm_order") {
      // Ghi nhận native ngay (vẫn giữ khóa đơn); lỗi → outbox `payment.native_sync` (đã ghi cùng transaction) thử lại.
      await syncNativePaymentSafely(container, attempt.order_id);
    }
    return R.success;
  } finally {
    if (!lockHeld)
      await releaseOwnedOrWarn(
        locking,
        owner,
        container.resolve(ContainerRegistrationKeys.LOGGER),
        "payment",
      );
  }
}

/**
 * Đánh dấu đơn native đã thu bằng workflow chính thức của module Payment/Order: tạo payment collection cho ĐƠN (không
 * phải giỏ) rồi `markPaymentCollectionAsPaid` (provider hệ thống `pp_system_default`: session → authorize → capture).
 * Không đụng giỏ nên không kích hoạt hoàn tất giỏ. Idempotent: đã có collection không ở `not_paid` → bỏ qua.
 * Gọi khi đang giữ khóa `order:<id>`.
 */
export async function syncNativePayment(
  container: MedusaContainer,
  orderId: string,
): Promise<"synced" | "noop"> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const s = service(container);
  const [fin] = await s.listOrderFinances({ order_id: orderId });
  if (!fin || fin.state !== "confirmed") return "noop";
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "payment_collections.id", "payment_collections.status"],
    filters: { id: orderId },
  });
  const collections = (
    (data[0] as { payment_collections?: Array<{ id: string; status: string } | null> })
      ?.payment_collections ?? []
  ).flatMap((c) => (c && c.status !== "canceled" ? [c] : []));
  if (collections.some((c) => c.status !== "not_paid")) return "noop";
  let collectionId = collections[0]?.id;
  if (!isNonEmpty(collectionId)) {
    const { result } = await createOrderPaymentCollectionWorkflow(container).run({
      input: { order_id: orderId, amount: fin.total },
    });
    collectionId = result[0]!.id;
  }
  await markPaymentCollectionAsPaid(container).run({
    input: { order_id: orderId, payment_collection_id: collectionId, captured_by: "x-shop:vnpay" },
  });
  return "synced";
}

async function syncNativePaymentSafely(container: MedusaContainer, orderId: string): Promise<void> {
  try {
    if ((await syncNativePayment(container, orderId)) === "synced") {
      await service(container).markOutboxSentByKey(`payment.native_sync:${orderId}`);
    }
  } catch (e) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(
        `[payment] đồng bộ payment native cho ${orderId} lỗi, outbox sẽ thử lại: ${(e as Error).message}`,
      );
  }
}

/** Kết quả querydr (đã xác minh chữ ký trong adapter) → thông báo như IPN. */
export function notificationFromQuery(
  cfg: { tmnCode: string },
  txnRef: string,
  amount: number,
  outcome: "paid" | "failed",
  transactionNo: string | null,
): vnpay.VerifiedNotification {
  const paid = outcome === "paid";
  return {
    txnRef,
    amount,
    responseCode: paid ? "00" : "02",
    transactionStatus: paid ? "00" : "02",
    transactionNo: transactionNo ?? "",
    bankCode: null,
    payDate: null,
    success: paid,
    tmnCode: cfg.tmnCode,
  };
}
