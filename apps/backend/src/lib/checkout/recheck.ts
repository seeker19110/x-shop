import type { MedusaContainer } from "@medusajs/framework/types";
import type { vnpay } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { getVnpayConfig } from "./config";
import { notificationFromQuery, processVerified } from "./payment";
import { getVnpayGateway, type QueryStatusResult } from "./vnpay-gateway";
import { isNonEmpty } from "@x-shop/domain";

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

export type QueryCheck = { outcome: vnpay.QueryOutcome | "skipped"; reason: string };

/**
 * Cổng của lời gọi querydr (T-161 — circuit breaker): `admit()` xét NGAY TRƯỚC lời gọi (sau mọi điều kiện tiên quyết —
 * không tốn lượt cho đơn không cần hỏi); trả lý do từ chối (vd. `breaker_open`, `breaker_throttled`) → KHÔNG gọi VNPAY,
 * kết quả `deferred` mang đúng lý do đó; `null` → gọi. `settle(raw)` nhận kết quả thô ngay sau lời gọi, TRƯỚC khi xử lý
 * (lỗi xử lý về sau không che tín hiệu sức khoẻ của cổng).
 */
export interface QueryGate {
  admit(): Promise<string | null>;
  settle(raw: QueryStatusResult): Promise<void>;
}

/** Lý do khi không hỏi được VNPAY vì tắt/thiếu cấu hình (T-166) — ghi vào `payment_unknown.detail.reason`. */
export const VNPAY_DISABLED_REASON = "vnpay_disabled";

/** Không gọi querydr vì cổng từ chối (breaker mở/đang thử/bóp) — trạng thái tiền CHƯA RÕ, không được coi là "chưa trả". */
export type DeferredQuery = { outcome: "deferred"; reason: string };

/**
 * Hỏi VNPAY (querydr) trạng thái attempt đang mở của đơn rồi đi CÙNG đường xử lý với IPN (inbox nguồn `query`).
 * `paid`/`failed` → xử lý như IPN; `not_paid`/`unknown` → không đổi gì (AT08: tra cứu không tự đổi trạng thái tiền).
 * Có `gate` → có thể trả `deferred` (không gọi).
 *
 * VNPAY tắt (`VNPAY_ENABLED=false` — cách giảm thiệt hại khi cổng lỗi, INCIDENT-RESPONSE §3) hoặc không có gateway mà đơn
 * CÒN attempt mở (T-166): KHÔNG hỏi được = trạng thái tiền CHƯA RÕ, không bao giờ suy ra "chưa trả" — có `gate` (job
 * expire-holds) → `deferred` lý do `vnpay_disabled` (giữ hàng như breaker mở); không có → `unknown` (hủy tay trả 409
 * PAYMENT_PENDING). Đơn không còn attempt mở (`no_open_payment`, vd. IPN thất bại) vẫn `skipped` như trước.
 */
export async function queryAndProcess(
  container: MedusaContainer,
  orderId: string,
  opts: { orderLockHeld?: boolean; gate: QueryGate },
): Promise<(QueryCheck & { raw?: QueryStatusResult }) | DeferredQuery>;
export async function queryAndProcess(
  container: MedusaContainer,
  orderId: string,
  opts?: { orderLockHeld?: boolean },
): Promise<QueryCheck & { raw?: QueryStatusResult }>;
export async function queryAndProcess(
  container: MedusaContainer,
  orderId: string,
  opts: { orderLockHeld?: boolean; gate?: QueryGate } = {},
): Promise<(QueryCheck & { raw?: QueryStatusResult }) | DeferredQuery> {
  const s = service(container);
  const [fin] = await s.listOrderFinances({ order_id: orderId });
  if (!fin) return { outcome: "skipped", reason: "no_order" };
  const [pa] = await s.listPaymentAttempts(
    { order_id: orderId, state: ["created", "pending", "unknown"] },
    { order: { created_at: "DESC" } },
  );
  if (!pa) return { outcome: "skipped", reason: "no_open_payment" };
  const cfg = getVnpayConfig();
  const gateway = getVnpayGateway();
  if (!cfg || !gateway) {
    return opts.gate
      ? { outcome: "deferred", reason: VNPAY_DISABLED_REASON }
      : { outcome: "unknown", reason: VNPAY_DISABLED_REASON };
  }
  const refused = opts.gate ? await opts.gate.admit() : null;
  if (refused !== null) return { outcome: "deferred", reason: refused };
  let raw: QueryStatusResult;
  try {
    raw = await gateway.queryStatus({
      txnRef: pa.txn_ref,
      amount: pa.amount,
      transactionDate: new Date(pa.created_at),
      orderInfo: `Thanh toan don ${fin.display_ref}`,
    });
  } catch (e) {
    raw = { outcome: "unknown", transactionNo: null, reason: `adapter_error:${(e as Error).message}` };
  }
  if (opts.gate) await opts.gate.settle(raw);
  if (raw.outcome === "paid" || raw.outcome === "failed") {
    const n = notificationFromQuery(cfg, pa.txn_ref, pa.amount, raw.outcome, raw.transactionNo);
    await processVerified(
      container,
      n,
      "query",
      {
        vnp_TxnRef: pa.txn_ref,
        vnp_TransactionNo: raw.transactionNo ?? "",
        source: "querydr",
        outcome: raw.outcome,
      },
      opts,
    );
  }
  return { outcome: raw.outcome, reason: raw.reason, raw };
}

/** Nút "Kiểm tra lại" (S-104): chỉ có ý nghĩa khi đơn đang chờ thanh toán. */
export async function recheckAttempt(container: MedusaContainer, attemptId: string): Promise<QueryCheck> {
  const s = service(container);
  const [a] = await s.listCheckoutAttempts({ id: attemptId });
  if (!a || !isNonEmpty(a.order_id) || a.payment_method !== "vnpay")
    return { outcome: "skipped", reason: "not_online" };
  const [fin] = await s.listOrderFinances({ order_id: a.order_id });
  if (fin?.state !== "awaiting_payment")
    return { outcome: "skipped", reason: `order_${fin?.state ?? "missing"}` };
  const r = await queryAndProcess(container, a.order_id);
  return { outcome: r.outcome, reason: r.reason };
}
