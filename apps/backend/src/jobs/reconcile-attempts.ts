import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { reconcileAttempts } from "../lib/checkout/jobs";

/** Mỗi phút: checkout attempt `preparing` quá lease (submit chết giữa chừng) → bù trừ (AT10). */
export default async function reconcileAttemptsJob(container: MedusaContainer): Promise<void> {
  const r = await reconcileAttempts(container);
  if (r.compensated.length > 0) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[reconcile-attempts] đã bù trừ ${r.compensated.length} attempt: ${r.compensated.join(", ")}`);
  }
}

export const config = { name: "x-reconcile-attempts", schedule: "* * * * *" };
