import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { WEBHOOK_RATE_LIMITS } from "../lib/http/webhook-rate-limit";
import { CHECKOUT_MODULE } from "../modules/checkout";
import type CheckoutModuleService from "../modules/checkout/service";
import { isDraining } from "../lib/lifecycle/shutdown";

/** Mỗi giờ: dọn bộ đếm giới hạn tần suất cũ (> 2 ngày; hàng webhook > 2×cửa sổ chính sách) và dấu đổi liên kết tra cứu đã hết hạn (> 1 ngày) — T-021. */
export default async function orderAccessCleanupJob(container: MedusaContainer): Promise<void> {
  // Đang tắt (T-171/D-081): tick lúc tắt không bắt đầu việc — Medusa chờ job đang chạy trước khi đóng pool; lần tick sau làm.
  if (isDraining()) return;
  const r = await container
    .resolve<CheckoutModuleService>(CHECKOUT_MODULE)
    .purgeOrderAccessRecords(
      new Date(),
      Object.fromEntries(Object.entries(WEBHOOK_RATE_LIMITS).map(([name, w]) => [name, w.windowMs])),
    );
  if (r.counters + r.redemptions > 0) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(`[order-access-cleanup] xoá ${r.counters} bộ đếm, ${r.redemptions} dấu đổi liên kết`);
  }
}

export const config = { name: "x-order-access-cleanup", schedule: "17 * * * *" };
