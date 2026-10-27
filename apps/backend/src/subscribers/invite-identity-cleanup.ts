import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { isNonEmpty } from "@x-shop/domain";
import { cleanupUnlinkedIdentityForInvite } from "../lib/admin-security/invite-guard";

/**
 * Xoá / gửi lại lời mời admin → dọn auth identity emailpass chưa gắn actor của đúng email đó (T-138, D-075;
 * lib/admin-security/invite-guard.ts). Lỗi chỉ ghi log — không chặn thao tác lời mời.
 */
export default async function inviteIdentityCleanup({ event, container }: SubscriberArgs<{ id?: unknown }>) {
  const id = event.data?.id;
  if (typeof id !== "string" || !isNonEmpty(id)) return;
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  try {
    const n = await cleanupUnlinkedIdentityForInvite(container, id);
    if (n > 0)
      logger.info(
        `[admin-security] ${event.name}: đã xoá ${n} auth identity chưa gắn actor của lời mời ${id}`,
      );
  } catch (e) {
    logger.error(`[admin-security] Dọn identity sau ${event.name} lỗi: ${(e as Error).message}`);
  }
}

export const config: SubscriberConfig = {
  event: ["invite.deleted", "invite.resent"],
  context: { subscriberId: "x-invite-identity-cleanup" },
};
