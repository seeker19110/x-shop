import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { IUserModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { isNonEmpty } from "@x-shop/domain";
import { sendProblem } from "../http/problem";

/**
 * Cổng đăng ký `POST /auth/:actor_type/:auth_provider/register` (BE-AUTH-003, T-138, D-068).
 *
 * Route gốc Medusa 2.22.1 gọi `register()` của provider: email đã có identity → 401 "Identity with email already exists",
 * email lạ → 200 + tạo `auth_identity` ⇒ dò được email admin và chiếm trước email của admin tương lai (identity emailpass
 * có `entity_id = email`, DÙNG CHUNG mọi actor — đăng ký qua `customer` hay actor bất kỳ cũng chiếm/dò được email admin;
 * `authMethodsPerActor` không khai cho actor lạ thì Medusa cho mọi provider).
 *
 * Chính sách (danh sách cho phép, mọi ca khác cùng MỘT phản hồi chung, không chạm provider → không tạo identity):
 *  - chỉ actor `user` + provider `emailpass` (so khớp CHÍNH XÁC trên tham số đã giải mã — `/auth/%75ser/…`, `/AUTH/USER/…`
 *    cũng qua cổng này vì middleware khai bằng tham số, không bằng chuỗi literal);
 *  - kèm `invite_token` trong thân → token phải hợp lệ (chữ ký, còn hạn, là token hiện hành của lời mời, chưa nhận) và
 *    lời mời đúng email đăng ký;
 *  - không kèm token → phải có lời mời còn hạn, chưa nhận cho ĐÚNG email (trang mời của dashboard Medusa 2.22.1 gọi
 *    `register` chỉ với email + mật khẩu rồi mới gửi token ở `/admin/invites/accept` — giữ luồng mời không vỡ).
 *  - actor `customer`: đóng ở P0 (mua không cần tài khoản — đặc tả §1.1; tài khoản khách là P1, POST04) vì đăng ký khách
 *    cũng dò/chiếm được email admin qua identity dùng chung.
 * Đường từ chối chỉ tốn một truy vấn lời mời theo email — như nhau cho email admin có thật và email lạ.
 */
export const REGISTER_DENIED = {
  status: 400,
  code: "REGISTRATION_NOT_ALLOWED",
  title: "Không đăng ký được. Tài khoản quản trị chỉ tạo qua lời mời hợp lệ cho đúng email.",
} as const;

const MAX_EMAIL = 320;
const MAX_TOKEN = 4096;

export interface InviteView {
  email: string;
  accepted: boolean;
  expires_at: Date | string;
}

export interface InviteLookup {
  /** Lời mời của token đã kiểm chữ ký/hạn/token hiện hành; `null` khi token không hợp lệ. */
  byToken(token: string): Promise<InviteView | null>;
  /** Có lời mời chưa nhận, `expires_at > now` cho đúng `email`. */
  pendingForEmail(email: string, now: Date): Promise<boolean>;
}

export interface RegisterRequest {
  actorType: unknown;
  provider: unknown;
  email: unknown;
  inviteToken: unknown;
}

const boundedString = (v: unknown, max: number): v is string =>
  typeof v === "string" && isNonEmpty(v) && v.length <= max;

/** Quyết định cho/không cho đăng ký (thuần, tiêm `lookup` + `now` — test tất định). */
export async function mayRegister(input: RegisterRequest, lookup: InviteLookup, now: Date): Promise<boolean> {
  if (input.actorType !== "user" || input.provider !== "emailpass") return false;
  if (!boundedString(input.email, MAX_EMAIL)) return false;
  const email = input.email;
  if (input.inviteToken !== undefined && input.inviteToken !== null) {
    if (!boundedString(input.inviteToken, MAX_TOKEN)) return false;
    const invite = await lookup.byToken(input.inviteToken);
    if (!invite || invite.accepted) return false;
    if (new Date(invite.expires_at).getTime() <= now.getTime()) return false;
    return invite.email === email;
  }
  return lookup.pendingForEmail(email, now);
}

/** Tra lời mời qua User Module (token: `validateInviteToken` — chữ ký JWT, hạn, token đã xoay/đã nhận → lỗi). */
export function userModuleInviteLookup(users: IUserModuleService): InviteLookup {
  return {
    async byToken(token) {
      try {
        return await users.validateInviteToken(token);
      } catch {
        return null;
      }
    },
    async pendingForEmail(email, now) {
      // Bộ lọc kiểu của listInvites chỉ có trường của user (email…) → lọc `accepted`/`expires_at` sau; lời mời đã nhận bị
      // xoá mềm (acceptInviteWorkflow) nên không nằm trong kết quả. Mỗi email chỉ một lời mời còn sống (chỉ mục duy nhất).
      const found = await users.listInvites({ email }, { select: ["id", "email", "accepted", "expires_at"] });
      return found.some(
        (i) => i.email === email && !i.accepted && new Date(i.expires_at).getTime() > now.getTime(),
      );
    },
  };
}

export async function registerGate(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  const body = (req.body ?? {}) as { email?: unknown; invite_token?: unknown };
  const allowed = await mayRegister(
    {
      actorType: req.params.actor_type,
      provider: req.params.auth_provider,
      email: body.email,
      inviteToken: body.invite_token,
    },
    userModuleInviteLookup(req.scope.resolve<IUserModuleService>(Modules.USER)),
    new Date(),
  );
  if (!allowed) return sendProblem(res, REGISTER_DENIED.status, REGISTER_DENIED.code, REGISTER_DENIED.title);
  return next();
}
