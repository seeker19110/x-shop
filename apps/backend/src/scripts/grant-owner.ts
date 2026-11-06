import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { z } from "zod";
import { recordAudit } from "../lib/audit/record";
import { RBAC_MODULE } from "../modules/rbac";
import type RbacModuleService from "../modules/rbac/service";

/** Đối số dòng lệnh: đúng một email (≤ 254 ký tự, không khoảng trắng/NUL), chuẩn hoá chữ thường. */
export const GrantOwnerArgs = z.tuple([
  z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .regex(/^[^\s@\0]+@[^\s@\0]+$/),
]);

/**
 * Cấp vai trò `owner` cho admin user theo email — CHỈ qua dòng lệnh trên máy chủ (không có route công khai, T-023):
 *   pnpm --filter @x-shop/backend rbac:grant-owner <email>
 * User phải tồn tại (tạo bằng `medusa user -e <email>` hoặc lời mời). Idempotent; ghi audit actor `system`.
 */
export default async function grantOwner({
  container,
  args,
}: Pick<ExecArgs, "container" | "args">): Promise<{ userId: string; created: boolean }> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const input = GrantOwnerArgs.safeParse(args ?? []);
  if (!input.success) throw new Error("Cách dùng: rbac:grant-owner <email>");
  const email = input.data[0];
  const [user] = await container.resolve(Modules.USER).listUsers({ email }, { select: ["id"] });
  if (!user) throw new Error("Không thấy admin user với email đã cho");
  const rbac = container.resolve<RbacModuleService>(RBAC_MODULE);
  const before = await rbac.rolesOf(user.id);
  const { created } = await rbac.grant(user.id, "owner", "script:grant-owner");
  if (created) {
    await recordAudit(container, {
      actor_type: "system",
      actor_id: "script:grant-owner",
      action: "rbac.role_granted",
      resource_type: "user",
      resource_id: user.id,
      reason: "grant-owner script",
      changes: { role: "owner", before, after: await rbac.rolesOf(user.id) },
    });
  }
  logger.info(`[rbac] owner ${created ? "đã cấp" : "đã có sẵn"} cho user ${user.id}`);
  return { userId: user.id, created };
}
