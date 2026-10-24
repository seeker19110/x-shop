import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../modules/checkout";
import type CheckoutModuleService from "../modules/checkout/service";

/** Mỗi giờ: dọn bộ đếm giới hạn tần suất cũ (> 2 ngày) và dấu đổi liên kết tra cứu đã hết hạn (> 1 ngày) — T-021. */
export default async function orderAccessCleanupJob(container: MedusaContainer): Promise<void> {
  const r = await container
    .resolve<CheckoutModuleService>(CHECKOUT_MODULE)
    .purgeOrderAccessRecords(new Date());
  if (r.counters + r.redemptions > 0) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(`[order-access-cleanup] xoá ${r.counters} bộ đếm, ${r.redemptions} dấu đổi liên kết`);
  }
}

export const config = { name: "x-order-access-cleanup", schedule: "17 * * * *" };
