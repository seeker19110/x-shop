import { cookies } from "next/headers";
import { ORDER_REF_RE } from "./map";
import { isNonEmpty } from "../presence";
import { msToSecondsFloor, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from "../units";

/**
 * Cookie phiên đơn (POST01): mỗi đơn một cookie `xs_order_<mã đơn>` chứa token ngắn hạn do backend ký. HttpOnly (JS
 * không đọc được), SameSite=Lax, Secure ở production, hết hạn đúng hạn token. Token KHÔNG bao giờ nằm trên URL.
 * `xs_order_last` ghi mã đơn vừa đặt để trang trở về từ cổng thanh toán biết chuyển tới đơn nào.
 */
export const ORDER_COOKIE_PREFIX = "xs_order_";
export const LAST_ORDER_COOKIE = "xs_order_last";
/** Token: base64url + "." — giới hạn độ dài để cookie lạ không đi tới backend. */
const TOKEN_RE = /^[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{16,128}$/;
const LAST_MAX_AGE_S = 24 * 3600;

export const orderCookieName = (ref: string) => `${ORDER_COOKIE_PREFIX}${ref}`;

export function orderCookieOptions(production: boolean, maxAgeS: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: production, path: "/", maxAge: maxAgeS };
}

export async function readOrderAccess(ref: string): Promise<string | null> {
  if (!ORDER_REF_RE.test(ref)) return null;
  const v = (await cookies()).get(orderCookieName(ref))?.value;
  return isNonEmpty(v) && TOKEN_RE.test(v) ? v : null;
}

/** Lưu token phiên đơn (chỉ gọi được trong Server Action / Route Handler). */
export async function writeOrderAccess(ref: string, token: unknown, expiresAt: unknown): Promise<boolean> {
  if (!ORDER_REF_RE.test(ref) || typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  const exp = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  const maxAge = Number.isNaN(exp)
    ? SECONDS_PER_HOUR
    : Math.max(SECONDS_PER_MINUTE, msToSecondsFloor(exp - Date.now()));
  const production = process.env.NODE_ENV === "production";
  const jar = await cookies();
  jar.set(orderCookieName(ref), token, orderCookieOptions(production, maxAge));
  jar.set(LAST_ORDER_COOKIE, ref, orderCookieOptions(production, Math.min(maxAge, LAST_MAX_AGE_S)));
  return true;
}

export async function readLastOrderRef(): Promise<string | null> {
  const v = (await cookies()).get(LAST_ORDER_COOKIE)?.value;
  return isNonEmpty(v) && ORDER_REF_RE.test(v) ? v : null;
}

export async function clearOrderAccess(ref: string): Promise<void> {
  if (ORDER_REF_RE.test(ref)) (await cookies()).delete(orderCookieName(ref));
}
