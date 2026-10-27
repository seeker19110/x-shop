import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { IAuthModuleService, IUserModuleService, MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { isNonEmpty } from "@x-shop/domain";
import { sendProblem } from "../http/problem";
import { userModuleInviteLookup } from "./register-gate";

/**
 * Ràng buộc lời mời admin với danh tính (T-138, D-075).
 *
 * `acceptInviteWorkflow` (core-flows 2.22.1) tạo user với `input.user.email ?? invite.email` và gắn bất kỳ auth identity nào
 * trong Bearer — không kiểm email/identity khớp lời mời: mời A, accept với thân `{email: B}` → user email B; hoặc dùng
 * token mời của A với identity của C. Cổng dưới đây chạy trước route accept.
 */
const PROVIDER = "emailpass";

export const INVITE_MISMATCH = {
  status: 400,
  code: "INVITE_MISMATCH",
  title: "Lời mời không khớp email hoặc tài khoản đăng ký",
} as const;

export interface AcceptCheck {
  inviteEmail: string;
  bodyEmail: unknown;
  /** entity_id của các provider identity `emailpass` thuộc identity trong Bearer. */
  identityEmails: readonly string[];
}

/** Thuần: thân không được đổi email khác lời mời; identity phải là identity emailpass của ĐÚNG email lời mời. */
export function acceptMatchesInvite(c: AcceptCheck): boolean {
  if (c.bodyEmail !== undefined && c.bodyEmail !== null && c.bodyEmail !== c.inviteEmail) return false;
  return c.identityEmails.includes(c.inviteEmail);
}

type AuthedRequest = MedusaRequest & { auth_context?: { auth_identity_id?: string } };

/**
 * `POST /admin/invites/accept?token=…`: token không hợp lệ → để route gốc trả 401 như cũ; token hợp lệ → kiểm khớp
 * (fail-closed: thiếu identity trong Bearer cũng là không khớp).
 */
export async function inviteAcceptGuard(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const token = (req.query as { token?: unknown }).token;
  if (typeof token !== "string" || !isNonEmpty(token)) return next();
  const invite = await userModuleInviteLookup(req.scope.resolve<IUserModuleService>(Modules.USER)).byToken(
    token,
  );
  if (!invite) return next();
  const authIdentityId = (req as AuthedRequest).auth_context?.auth_identity_id;
  let identityEmails: string[] = [];
  if (isNonEmpty(authIdentityId)) {
    const pis = await req.scope
      .resolve<IAuthModuleService>(Modules.AUTH)
      .listProviderIdentities(
        { auth_identity_id: authIdentityId, provider: PROVIDER },
        { select: ["entity_id"] },
      );
    identityEmails = pis.map((p) => p.entity_id);
  }
  const body = (req.body ?? {}) as { email?: unknown };
  if (!acceptMatchesInvite({ inviteEmail: invite.email, bodyEmail: body.email, identityEmails })) {
    return sendProblem(res, INVITE_MISMATCH.status, INVITE_MISMATCH.code, INVITE_MISMATCH.title);
  }
  return next();
}

/** Identity chưa gắn actor: `app_metadata` không có khoá `<actor>_id` mang giá trị (user_id, customer_id…). */
export function isUnlinkedIdentity(appMetadata: Record<string, unknown> | null | undefined): boolean {
  if (!appMetadata) return true;
  return !Object.entries(appMetadata).some(
    ([k, v]) => k.endsWith("_id") && typeof v === "string" && isNonEmpty(v),
  );
}

/**
 * Lời mời bị xoá hoặc gửi lại → xoá auth identity emailpass CHƯA gắn actor của đúng email lời mời (đã đăng ký bằng token
 * cũ nhưng chưa accept): người được mời đăng ký lại bằng link mới, mật khẩu mới; không để identity treo. Identity đã gắn
 * user/customer không bị chạm. Trả số identity đã xoá.
 */
export async function cleanupUnlinkedIdentityForInvite(
  container: MedusaContainer,
  inviteId: string,
): Promise<number> {
  const [invite] = await container
    .resolve<IUserModuleService>(Modules.USER)
    .listInvites({ id: inviteId }, { withDeleted: true, select: ["id", "email"] });
  if (!invite || !isNonEmpty(invite.email)) return 0;
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH);
  const pis = await auth.listProviderIdentities(
    { entity_id: invite.email, provider: PROVIDER },
    { relations: ["auth_identity"] },
  );
  const ids = [
    ...new Set(
      pis
        .filter((p) => p.entity_id === invite.email && isUnlinkedIdentity(p.auth_identity?.app_metadata))
        .map((p) => p.auth_identity_id)
        .filter((id): id is string => typeof id === "string" && isNonEmpty(id)),
    ),
  ];
  if (ids.length > 0) await auth.deleteAuthIdentities(ids);
  return ids.length;
}
