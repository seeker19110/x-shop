import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { expireHolds } from "../lib/checkout/jobs";

/** Mỗi phút: đơn online quá hạn giữ hàng → querydr → xác nhận / hủy / ngoại lệ (docs/design/checkout-flow.md §6). */
export default async function expireHoldsJob(container: MedusaContainer): Promise<void> {
  const r = await expireHolds(container);
  const n = r.cancelled.length + r.confirmed.length + r.unknown.length;
  if (n > 0) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .info(
        `[expire-holds] hủy ${r.cancelled.length}, xác nhận ${r.confirmed.length}, chưa rõ ${r.unknown.length}, bỏ qua ${r.skipped.length}`,
      );
  }
}

export const config = { name: "x-expire-holds", schedule: "* * * * *" };
