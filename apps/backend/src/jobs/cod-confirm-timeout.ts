import type { MedusaContainer } from "@medusajs/framework/types";
import { codConfirmTimeout } from "../lib/checkout/jobs";
import { isDraining } from "../lib/lifecycle/shutdown";

/** Mỗi 15 phút: đơn COD quá hạn xác nhận → ngoại lệ cho nhân viên đơn, không tự hủy (§6.3, D-004). */
export default async function codConfirmTimeoutJob(container: MedusaContainer): Promise<void> {
  // Đang tắt (T-171/D-081): tick lúc tắt không bắt đầu việc — Medusa chờ job đang chạy trước khi đóng pool; lần tick sau làm.
  if (isDraining()) return;
  await codConfirmTimeout(container);
}

export const config = { name: "x-cod-confirm-timeout", schedule: "*/15 * * * *" };
