import { randomUUID } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { createUserAccountWorkflow } from "@medusajs/medusa/core-flows";
import type { Role } from "@x-shop/domain";
import { TOTP } from "otpauth";
import { RBAC_MODULE } from "../../src/modules/rbac";
import type RbacModuleService from "../../src/modules/rbac/service";

/** Payload JWT không kiểm chữ ký — chỉ để đọc auth_identity_id của token đăng ký trong test. */
export function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export interface HttpResponse {
  status: number;
  data: Record<string, unknown>;
  headers: Record<string, unknown>;
}

/** Phần tối thiểu của client HTTP (axios) mà test-utils cấp — axios không là phụ thuộc trực tiếp của backend. */
export interface HttpClient {
  post(url: string, body?: unknown, config?: unknown): Promise<{ data: Record<string, unknown> }>;
}

/** Không ném lỗi khi status ≠ 2xx — test đọc status/body. */
export const noThrow = { validateStatus: () => true };

/** Mã TOTP bằng thư viện chuẩn (otpauth, RFC 6238: SHA-1, 6 số, 30 giây) — không dùng mã nội bộ của Medusa. */
export const totp = (secret: string, timestampMs: number = Date.now()): string =>
  new TOTP({ secret, algorithm: "SHA1", digits: 6, period: 30 }).generate({ timestamp: timestampMs });

export interface AdminAccount {
  userId: string;
  email: string;
  password: string;
  authIdentityId: string;
  headers: { authorization: string };
}

/**
 * Tạo admin thật qua luồng native (lời mời → đăng ký emailpass kèm token mời → tạo user gắn auth identity → đăng nhập) và
 * trả header Bearer. Đăng ký `user` chỉ qua cổng khi có lời mời hợp lệ (T-138, lib/admin-security/register-gate.ts).
 * Không giả token: route admin chạy đúng middleware authenticate của Medusa. Mặc định cấp vai trò `owner` (RBAC T-023)
 * để test chức năng không vướng quyền; `roles: []` = user chưa có vai trò.
 */
export async function createAdmin(
  api: HttpClient,
  container: MedusaContainer,
  opts: { roles?: Role[] } = {},
): Promise<AdminAccount> {
  const email = `admin-${randomUUID()}@x-shop.test`;
  const password = `pw-${randomUUID()}`;
  const users = container.resolve(Modules.USER);
  const [invite] = await users.createInvites([{ email }]);
  const reg = await api.post("/auth/user/emailpass/register", {
    email,
    password,
    invite_token: invite!.token,
  });
  const authIdentityId = jwtPayload(String(reg.data.token)).auth_identity_id as string;
  const { result: user } = await createUserAccountWorkflow(container).run({
    input: { userData: { email }, authIdentityId },
  });
  // Như acceptInviteWorkflow: lời mời đã dùng bị xoá (mềm) — không để lại lời mời còn hạn cho email của admin đã có.
  await users.deleteInvites([invite!.id]);
  const rbac = container.resolve<RbacModuleService>(RBAC_MODULE);
  for (const role of opts.roles ?? ["owner"]) await rbac.grant(user.id, role, "test");
  const login = await api.post("/auth/user/emailpass", { email, password });
  return {
    userId: user.id,
    email,
    password,
    authIdentityId,
    headers: { authorization: `Bearer ${String(login.data.token)}` },
  };
}

export async function adminHeaders(
  api: HttpClient,
  container: MedusaContainer,
  opts: { roles?: Role[] } = {},
) {
  const a = await createAdmin(api, container, opts);
  return { userId: a.userId, headers: a.headers };
}

export interface MfaAdmin extends AdminAccount {
  secret: string;
  factorId: string;
}

/** Đăng ký TOTP native (POST /auth/mfa/factors → verify) cho tài khoản đang đăng nhập. */
export async function enrollTotp(api: HttpClient, headers: { authorization: string }) {
  const start = await api.post("/auth/mfa/factors", { provider: "totp" }, { headers });
  const secret = String(start.data.secret);
  const factorId = String((start.data.mfa_factor as { id: string }).id);
  await api.post(`/auth/mfa/factors/${factorId}/verify`, { code: totp(secret) }, { headers });
  return { secret, factorId };
}

/** Đăng nhập có MFA: mật khẩu → challenge → mã (TOTP hoặc recovery code) → token có mfa_challenge_completed_at. */
export async function loginWithMfa(
  api: HttpClient,
  creds: { email: string; password: string },
  code: { method: "totp" | "recovery_code"; code: string },
): Promise<{ authorization: string }> {
  const first = await api.post("/auth/user/emailpass", creds);
  const challenge = first.data.mfa_challenge as { id: string } | undefined;
  if (!challenge) throw new Error("Đăng nhập không đòi MFA");
  const verified = await api.post(`/auth/mfa/challenges/${challenge.id}/verify`, code, {
    headers: { authorization: `Bearer ${String(first.data.token)}` },
  });
  return { authorization: `Bearer ${String(verified.data.token)}` };
}

/** Admin có vai trò + TOTP đã bật + phiên đã qua MFA. */
export async function createMfaAdmin(
  api: HttpClient,
  container: MedusaContainer,
  opts: { roles?: Role[] } = {},
): Promise<MfaAdmin> {
  const account = await createAdmin(api, container, opts);
  const { secret, factorId } = await enrollTotp(api, account.headers);
  const headers = await loginWithMfa(api, account, { method: "totp", code: totp(secret) });
  return { ...account, secret, factorId, headers };
}

/** Header publishable key của kênh web (seed tạo) cho Store API. */
export async function storeHeaders(container: MedusaContainer, title = "Storefront x-shop") {
  const [key] = await container.resolve(Modules.API_KEY).listApiKeys({ title, type: "publishable" });
  if (!key) throw new Error("Chưa seed publishable key");
  return { "x-publishable-api-key": key.token };
}
