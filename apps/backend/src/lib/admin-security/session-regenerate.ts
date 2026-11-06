/**
 * Tạo lại session ID khi đăng nhập/đổi đặc quyền (BE-AUTH-004, D-059, T-133) — chống session fixation.
 *
 * Medusa 2.22.1 `POST /auth/session` (@medusajs/medusa/dist/api/auth/session/route.js) chỉ gán
 * `req.session.auth_context = req.auth_context` lên phiên HIỆN CÓ: kẻ tấn công cấy được cookie phiên (vd qua
 * subdomain ở dev, hoặc phiên cũ trên máy dùng chung) thì sau khi nạn nhân đăng nhập, cookie đó mang quyền admin.
 * Luồng MFA cũng đi qua đây: `POST /auth/mfa/challenges/:id/verify` trả token mới (mfa_challenge_completed_at) và
 * dashboard đổi token đó lấy phiên bằng `POST /auth/session` → mỗi lần nâng đặc quyền đều được ID mới.
 *
 * `regenerate` của express-session xoá bản ghi phiên cũ khỏi store và gắn `req.session` MỚI (ID mới từ uid-safe 24
 * byte) — phải gán auth_context SAU khi regenerate xong (đối tượng cũ đã bị thay). Lỗi store → ném lỗi (fail-closed),
 * KHÔNG rơi về gắn quyền lên phiên cũ.
 */
export interface RegenerableSession {
  id?: string;
  regenerate(cb: (err?: unknown) => void): void;
  [key: string]: unknown;
}

export interface SessionCarrier {
  session?: RegenerableSession;
}

export function regenerateSession(req: SessionCarrier): Promise<void> {
  const session = req.session;
  if (session === undefined || typeof session.regenerate !== "function") {
    return Promise.reject(new Error("express-session chưa được nạp: không tạo lại được session ID"));
  }
  return new Promise<void>((resolve, reject) => {
    session.regenerate((err) => {
      if (err === undefined || err === null) resolve();
      else reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/** Thay `POST /auth/session` native: tạo lại ID rồi mới gắn auth context (giữ nguyên phản hồi 200 `{ user }`). */
export async function establishAdminSession<C>(
  req: SessionCarrier & { auth_context?: C },
): Promise<C | undefined> {
  await regenerateSession(req);
  const fresh = req.session;
  if (fresh === undefined) throw new Error("express-session không gắn phiên mới sau regenerate");
  fresh.auth_context = req.auth_context;
  return req.auth_context;
}
