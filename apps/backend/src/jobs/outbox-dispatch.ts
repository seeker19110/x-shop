import type { MedusaContainer } from "@medusajs/framework/types";
import { dispatchOutbox } from "../lib/checkout/jobs";

/** Mỗi 10 giây: gửi sự kiện outbox đến hạn; lỗi → thử lại lũy thừa, quá số lần → `dead` + ngoại lệ (DATA06, AT18). */
export default async function outboxDispatchJob(container: MedusaContainer): Promise<void> {
  await dispatchOutbox(container);
}

export const config = { name: "x-outbox-dispatch", schedule: { interval: 10_000 } };
