import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { expireHolds } from "../lib/checkout/jobs";
import { isDraining } from "../lib/lifecycle/shutdown";

/**
 * Mỗi phút: đơn online quá hạn giữ hàng → querydr → xác nhận / hủy / ngoại lệ (docs/design/checkout-flow.md §6). querydr qua
 * circuit breaker `vnpay.querydr` (T-161): breaker mở → giữ hàng như `unknown`, không hủy.
 */
export default async function expireHoldsJob(container: MedusaContainer): Promise<void> {
  // Đang tắt (T-171/D-081): tick lúc tắt không bắt đầu việc — Medusa chờ job đang chạy trước khi đóng pool; lần tick sau làm.
  if (isDraining()) return;
  const r = await expireHolds(container);
  const n = r.cancelled.length + r.confirmed.length + r.unknown.length + r.deferred.length;
  if (n > 0) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(
        `[expire-holds] hủy ${r.cancelled.length}, xác nhận ${r.confirmed.length}, chưa rõ ${r.unknown.length}, hoãn querydr (breaker) ${r.deferred.length}, bỏ qua ${r.skipped.length}`,
      );
  }
}

export const config = { name: "x-expire-holds", schedule: "* * * * *" };
