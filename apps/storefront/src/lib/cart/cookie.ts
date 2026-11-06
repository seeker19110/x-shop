import { cookies } from "next/headers";
import { isNonEmpty } from "../presence";

/**
 * Cookie id giỏ: HttpOnly (JS không đọc được), SameSite=Lax, Secure ở production, 30 ngày. KHÔNG lưu giỏ/PII ở
 * localStorage (S-504) — id giỏ là tham chiếu duy nhất; nội dung giỏ luôn đọc lại từ server.
 */
export const CART_COOKIE = "xs_cart";
const MAX_AGE_S = 60 * 60 * 24 * 30;

/** Id giỏ Medusa: `cart_` + ULID; kiểm hình dạng để cookie giả không đi tới backend. */
export const CART_ID_RE = /^cart_[0-9A-Za-z]{10,64}$/;

export function cartCookieOptions(production: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: production,
    path: "/",
    maxAge: MAX_AGE_S,
  };
}

export async function readCartId(): Promise<string | null> {
  const v = (await cookies()).get(CART_COOKIE)?.value;
  return isNonEmpty(v) && CART_ID_RE.test(v) ? v : null;
}

export async function writeCartId(id: string): Promise<void> {
  (await cookies()).set(CART_COOKIE, id, cartCookieOptions(process.env.NODE_ENV === "production"));
}

export async function clearCartId(): Promise<void> {
  (await cookies()).delete(CART_COOKIE);
}
