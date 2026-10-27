import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { IUserModuleService } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { isNonEmpty } from "@x-shop/domain";
import { sendProblem } from "../http/problem";

/**
 * Cổng đăng ký `POST /auth/:actor_type/:auth_provider/register` (BE-AUTH-003, T-138, D-068, D-075).
 *
 * Route gốc Medusa 2.22.1 gọi `register()` của provider: email đã có identity → 401 "Identity with email already exists",
 * email lạ → 200 + tạo `auth_identity` ⇒ dò được email admin và chiếm trước email của admin tương lai (identity emailpass
 * có `entity_id = email`, DÙNG CHUNG mọi actor — đăng ký qua `customer` hay actor bất kỳ cũng chiếm/dò được email admin;
 * `authMethodsPerActor` không khai cho actor lạ thì Medusa cho mọi provider).
 *
 * Chính sách (danh sách cho phép; mọi ca khác cùng MỘT phản hồi chung, không chạm provider → không tạo identity):
 *  - chỉ actor `user` + provider `emailpass` (so khớp CHÍNH XÁC trên tham số đã giải mã — `/auth/%75ser/…`, `/AUTH/USER/…`
 *    cũng qua cổng này vì middleware khai bằng tham số, không bằng chuỗi literal);
 *  - PHẢI chứng minh có token mời hợp lệ (chữ ký, còn hạn, là token hiện hành, chưa nhận) của lời mời ĐÚNG email đăng ký
 *    (D-075 — chỉ "có lời mời cho email" thì người lạ biết email đang được mời chiếm trước được identity). Nguồn token:
 *      1. thân `invite_token` (đã gửi thì nó quyết định — sai là từ chối, không xét nguồn khác);
 *      2. header `Referer` = trang mời của dashboard Medusa (`<admin.path>/invite?token=…`) CÙNG host với request: trang
 *         mời 2.22.1 gọi `register` chỉ với email + mật khẩu (token chỉ gửi ở `/admin/invites/accept`); dashboard và
 *         admin-bundler không đặt Referrer-Policy nên trình duyệt (mặc định `strict-origin-when-cross-origin`) gửi đủ URL
 *         cho request cùng origin. Referer giả được bởi client không phải trình duyệt — nhưng giá trị bảo vệ là TOKEN, không
 *         phải header: không có token mời thì không đăng ký được.
 *  - actor `customer`: đóng ở P0 (mua không cần tài khoản — đặc tả §1.1; tài khoản khách là P1, POST04).
 */
export const REGISTER_DENIED = {
  status: 400,
  code: "REGISTRATION_NOT_ALLOWED",
  title: "Không đăng ký được. Tài khoản quản trị chỉ tạo qua lời mời hợp lệ cho đúng email.",
} as const;

const MAX_EMAIL = 320;
const MAX_TOKEN = 4096;
const MAX_REFERER = 8192;
export const DEFAULT_ADMIN_PATH = "/app";

export interface InviteView {
  email: string;
  accepted: boolean;
  expires_at: Date | string;
}

export interface InviteLookup {
  /** Lời mời của token đã kiểm chữ ký/hạn/token hiện hành; `null` khi token không hợp lệ. */
  byToken(token: string): Promise<InviteView | null>;
}

export interface RegisterRequest {
  actorType: unknown;
  provider: unknown;
  email: unknown;
  /** `invite_token` trong thân (chưa kiểm kiểu). */
  inviteToken: unknown;
  /** Token rút từ Referer hợp lệ (`inviteTokenFromReferer`), `null` khi không có. */
  refererToken: string | null;
}

const boundedString = (v: unknown, max: number): v is string =>
  typeof v === "string" && isNonEmpty(v) && v.length <= max;

const trimSlash = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/**
 * Token mời trong `Referer` khi Referer là trang mời của dashboard (`<adminPath>/invite`, `?token=` đúng một giá trị) và
 * cùng host (gồm cổng) với request. Không so scheme: sau proxy kết thúc TLS, request tới backend là http còn Referer là https.
 */
export function inviteTokenFromReferer(
  referer: unknown,
  requestHost: unknown,
  adminPath: string = DEFAULT_ADMIN_PATH,
): string | null {
  if (!boundedString(referer, MAX_REFERER) || !boundedString(requestHost, 255)) return null;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.host.toLowerCase() !== requestHost.toLowerCase()) return null;
  if (trimSlash(url.pathname) !== `${trimSlash(adminPath)}/invite`) return null;
  const tokens = url.searchParams.getAll("token");
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  return boundedString(token, MAX_TOKEN) ? token : null;
}

/** Quyết định cho/không cho đăng ký (thuần, tiêm `lookup` + `now` — test tất định). */
export async function mayRegister(input: RegisterRequest, lookup: InviteLookup, now: Date): Promise<boolean> {
  if (input.actorType !== "user" || input.provider !== "emailpass") return false;
  if (!boundedString(input.email, MAX_EMAIL)) return false;
  const bodyGiven = input.inviteToken !== undefined && input.inviteToken !== null;
  const token = bodyGiven ? input.inviteToken : input.refererToken;
  if (!boundedString(token, MAX_TOKEN)) return false;
  const invite = await lookup.byToken(token);
  if (!invite || invite.accepted) return false;
  if (new Date(invite.expires_at).getTime() <= now.getTime()) return false;
  return invite.email === input.email;
}

/** Tra lời mời qua User Module (`validateInviteToken` — chữ ký JWT, hạn, token đã xoay/đã nhận/đã xoá → lỗi). */
export function userModuleInviteLookup(users: IUserModuleService): InviteLookup {
  return {
    async byToken(token) {
      try {
        return await users.validateInviteToken(token);
      } catch {
        return null;
      }
    },
  };
}

export function adminPathOf(req: MedusaRequest): string {
  const path = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE).admin?.path;
  return typeof path === "string" && isNonEmpty(path) ? path : DEFAULT_ADMIN_PATH;
}

export async function registerGate(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const body = (req.body ?? {}) as { email?: unknown; invite_token?: unknown };
  const allowed = await mayRegister(
    {
      actorType: req.params.actor_type,
      provider: req.params.auth_provider,
      email: body.email,
      inviteToken: body.invite_token,
      refererToken: inviteTokenFromReferer(req.headers.referer, req.headers.host, adminPathOf(req)),
    },
    userModuleInviteLookup(req.scope.resolve<IUserModuleService>(Modules.USER)),
    new Date(),
  );
  if (!allowed) return sendProblem(res, REGISTER_DENIED.status, REGISTER_DENIED.code, REGISTER_DENIED.title);
  return next();
}
