import type { MedusaContainer } from "@medusajs/framework/types";
import { codConfirmTimeout } from "../lib/checkout/jobs";

/** Mỗi 15 phút: đơn COD quá hạn xác nhận → ngoại lệ cho nhân viên đơn, không tự hủy (§6.3, D-004). */
export default async function codConfirmTimeoutJob(container: MedusaContainer): Promise<void> {
  await codConfirmTimeout(container);
}

export const config = { name: "x-cod-confirm-timeout", schedule: "*/15 * * * *" };
