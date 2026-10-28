import { createHmac } from "node:crypto";
import type { AdminSessionPolicy } from "./config";
import type { SecurityStore } from "./store";
import { isNonEmpty, msToSecondsCeil, secondsToMs } from "@x-shop/domain";

/**
 * Chính sách phiên admin (SEC02, SPEC-admin S-402) — hàm thuần + lớp lưu "lần thấy cuối" trong SecurityStore.
 *
 * Mốc phiên (anchor) = thời điểm XÁC THỰC: `mfa_challenge_completed_at` (giữ nguyên qua /auth/token/refresh) hoặc `iat`
 * của JWT khi không có MFA (token không-MFA của admin bị chặn refresh — guard). Phiên cookie lưu nguyên auth_context
 * của JWT nên dùng chung quy tắc. Native `requireMfa` chỉ áp khi user ĐÃ bật MFA và trả 401 — không đủ cho "chưa đăng
 * ký MFA → 403 MFA_REQUIRED", nên kiểm ở đây.
 */
export interface AdminAuthContext {
  actor_id?: string;
  actor_type?: string;
  auth_identity_id?: string;
  iat?: number;
  mfa_enabled?: boolean;
  mfa_challenge_completed_at?: string | null;
}

export type SessionCode = "SESSION_EXPIRED" | "SESSION_IDLE";
export type MfaCode = "MFA_REQUIRED" | "REAUTH_REQUIRED";

export function mfaCompletedAtMs(ctx: AdminAuthContext): number | null {
  if (!isNonEmpty(ctx.mfa_challenge_completed_at)) return null;
  const t = new Date(ctx.mfa_challenge_completed_at).getTime();
  return Number.isNaN(t) ? null : t;
}

export function sessionAnchorMs(ctx: AdminAuthContext): number | null {
  const mfa = mfaCompletedAtMs(ctx);
  if (mfa !== null) return mfa;
  return typeof ctx.iat === "number" && Number.isFinite(ctx.iat) ? secondsToMs(ctx.iat) : null;
}

/** Không có mốc → không thể áp hạn phiên → từ chối (fail-closed). */
export function evaluateSession(input: {
  anchorMs: number | null;
  lastSeenMs: number | null;
  nowMs: number;
  policy: Pick<AdminSessionPolicy, "maxAgeSeconds" | "idleSeconds">;
}): { ok: true } | { ok: false; code: SessionCode } {
  const { anchorMs, lastSeenMs, nowMs, policy } = input;
  if (anchorMs === null) return { ok: false, code: "SESSION_EXPIRED" };
  if (nowMs - anchorMs > secondsToMs(policy.maxAgeSeconds)) return { ok: false, code: "SESSION_EXPIRED" };
  const last = lastSeenMs ?? anchorMs;
  if (nowMs - last > secondsToMs(policy.idleSeconds)) return { ok: false, code: "SESSION_IDLE" };
  return { ok: true };
}

/** MFA cho route nhạy cảm; `reauthSeconds` ≠ null → MFA phải hoàn tất trong chừng đó giây (xác thực lại). */
export function evaluateMfa(
  ctx: AdminAuthContext,
  nowMs: number,
  reauthSeconds: number | null,
): { ok: true } | { ok: false; code: MfaCode } {
  const at = mfaCompletedAtMs(ctx);
  if (ctx.mfa_enabled !== true || at === null) return { ok: false, code: "MFA_REQUIRED" };
  if (reauthSeconds !== null && nowMs - at > secondsToMs(reauthSeconds))
    return { ok: false, code: "REAUTH_REQUIRED" };
  return { ok: true };
}

/** Nhãn cố định của HMAC dẫn xuất khóa phiên (không phải bí mật — chỉ tách miền băm; đầu vào không phải mật khẩu). */
const SESSION_KEY_LABEL = "x-shop/admin-session-key/v1";

/**
 * Khóa phiên ổn định qua refresh: HMAC-SHA256 (auth identity, mốc xác thực) — không lưu token/định danh thô.
 * Đổi từ SHA-256 trần sang HMAC làm khóa phiên đang có (Redis/DB) mất khớp một lần: phiên phải đăng nhập lại.
 */
export function sessionKey(ctx: AdminAuthContext, anchorMs: number): string {
  const h = createHmac("sha256", SESSION_KEY_LABEL)
    .update(`${ctx.auth_identity_id ?? ""}|${anchorMs}`)
    .digest("hex");
  return `sess:${h.slice(0, 40)}`;
}

/** Kiểm hạn phiên và ghi nhận hoạt động (chỉ khi còn hạn — phiên đã nhàn rỗi quá hạn không được "đánh thức" lại). */
export async function checkAndTouchSession(
  store: SecurityStore,
  ctx: AdminAuthContext,
  policy: AdminSessionPolicy,
  nowMs = Date.now(),
): Promise<{ ok: true } | { ok: false; code: SessionCode }> {
  const anchorMs = sessionAnchorMs(ctx);
  if (anchorMs === null) return { ok: false, code: "SESSION_EXPIRED" };
  const key = sessionKey(ctx, anchorMs);
  const raw = await store.get(key);
  const lastSeenMs = raw === null ? null : Number(raw);
  const verdict = evaluateSession({
    anchorMs,
    lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : null,
    nowMs,
    policy,
  });
  if (!verdict.ok) return verdict;
  const remaining = msToSecondsCeil(anchorMs + secondsToMs(policy.maxAgeSeconds) - nowMs);
  await store.set(key, String(nowMs), Math.max(1, remaining));
  return verdict;
}
