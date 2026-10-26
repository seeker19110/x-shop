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
 * Hỏi VNPAY (querydr) trạng thái attempt đang mở của đơn rồi đi CÙNG đường xử lý với IPN (inbox nguồn `query`).
 * `paid`/`failed` → xử lý như IPN; `not_paid`/`unknown` → không đổi gì (AT08: tra cứu không tự đổi trạng thái tiền).
 */
export async function queryAndProcess(
  container: MedusaContainer,
  orderId: string,
  opts: { orderLockHeld?: boolean } = {},
): Promise<QueryCheck & { raw?: QueryStatusResult }> {
  const s = service(container);
  const cfg = getVnpayConfig();
  const gateway = getVnpayGateway();
  if (!cfg || !gateway) return { outcome: "skipped", reason: "vnpay_disabled" };
  const [fin] = await s.listOrderFinances({ order_id: orderId });
  if (!fin) return { outcome: "skipped", reason: "no_order" };
  const [pa] = await s.listPaymentAttempts(
    { order_id: orderId, state: ["created", "pending", "unknown"] },
    { order: { created_at: "DESC" } },
  );
  if (!pa) return { outcome: "skipped", reason: "no_open_payment" };
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
