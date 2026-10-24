import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { MedusaContainer } from "@medusajs/framework/types";
import { signLookupToken, verifyLookupToken } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { CheckoutError } from "../checkout/errors";
import { parseEnv } from "../env";

/**
 * Quyền xem đơn sau mua (POST01, S-308, AT20). Mã đơn + SĐT KHÔNG đủ để xem đơn; chỉ hai loại token ngắn hạn ký HMAC
 * (`signLookupToken` của domain — primitive chuẩn, không tự chế mật mã):
 * - `access` — phiên đơn: cấp lúc submit/đổi link, storefront giữ trong cookie HttpOnly và gửi qua header
 *   `x-order-access` (không bao giờ nằm trên URL); dùng lại được tới khi hết hạn.
 * - `link` — liên kết tra cứu gửi qua email/SMS: ngắn hạn, đổi MỘT lần thành phiên (dấu đổi lưu SHA-256 ở DB).
 * Mỗi loại ký bằng khóa dẫn xuất riêng từ ORDER_LOOKUP_SECRET → token loại này không dùng được thay loại kia.
 */
export const ORDER_ACCESS_CONFIG = {
  /** Phiên đơn (cookie) 7 ngày — đủ theo dõi đơn COD tới khi giao; hết hạn thì tra cứu lại bằng mã đơn + SĐT. */
  accessTtlMs: 7 * 24 * 3600_000,
  /** Liên kết tra cứu 15 phút, một lần dùng. */
  linkTtlMs: 15 * 60_000,
} as const;

export type OrderTokenPurpose = "access" | "link";

let secretOverride: string | null = null;
let cachedSecret: string | null = null;

/** Chỉ cho test: đổi khóa gốc (null = đọc lại từ env). */
export function setOrderLookupSecretForTest(secret: string | null): void {
  secretOverride = secret;
  cachedSecret = null;
}

function rootSecret(): string {
  if (secretOverride) return secretOverride;
  if (cachedSecret) return cachedSecret;
  const parsed = parseEnv(process.env);
  if (!parsed.ok || parsed.env.orderLookupSecret === "") {
    throw new Error("[orders] ORDER_LOOKUP_SECRET chưa cấu hình (đã báo khi khởi động)");
  }
  cachedSecret = parsed.env.orderLookupSecret;
  return cachedSecret;
}

const purposeKey = (purpose: OrderTokenPurpose) =>
  createHmac("sha256", rootSecret()).update(`x-shop:order-${purpose}:v1`).digest("base64url");

export function issueOrderToken(
  purpose: OrderTokenPurpose,
  orderId: string,
  now: Date = new Date(),
): { token: string; expires_at: string } {
  const ttl = purpose === "access" ? ORDER_ACCESS_CONFIG.accessTtlMs : ORDER_ACCESS_CONFIG.linkTtlMs;
  const expiresAt = new Date(now.getTime() + ttl);
  return { token: signLookupToken(purposeKey(purpose), orderId, expiresAt), expires_at: expiresAt.toISOString() };
}

/** Token hợp lệ (đúng loại, chữ ký, còn hạn) → { orderId, expiresAt }; ngược lại null (không phân biệt lý do). */
export function readOrderToken(
  purpose: OrderTokenPurpose,
  token: unknown,
  now: Date = new Date(),
): { orderId: string; expiresAt: Date } | null {
  if (typeof token !== "string" || token.length === 0 || token.length > 512) return null;
  const r = verifyLookupToken(purposeKey(purpose), token, now);
  if (!r.ok) return null;
  const body = Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8");
  const exp = Number(body.slice(body.lastIndexOf(".") + 1));
  return { orderId: r.orderId, expiresAt: new Date(exp * 1000) };
}

export const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** So sánh hằng thời gian (SĐT khi tra cứu). */
export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Mã đơn hiển thị (XS-xxxxxx) — kiểm hình dạng trước khi chạm DB. */
export const DISPLAY_REF_RE = /^XS-[A-Z0-9]{4,12}$/;

export function normalizeDisplayRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ref = raw.trim().toUpperCase();
  return DISPLAY_REF_RE.test(ref) ? ref : null;
}

const service = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

export const orderNotFound = () => new CheckoutError("NOT_FOUND", "Không tìm thấy đơn hàng");

/**
 * Đơn mà token `access` cho phép xem, đúng mã `displayRef`. Thiếu/sai/hết hạn token hoặc token của đơn khác → null
 * (route trả 404 như không tồn tại — AT20).
 */
export async function authorizedOrder(
  container: MedusaContainer,
  displayRef: string,
  token: unknown,
  now: Date = new Date(),
) {
  const ref = normalizeDisplayRef(displayRef);
  const claim = ref ? readOrderToken("access", token, now) : null;
  if (!claim) return null;
  const [fin] = await service(container).listOrderFinances({ order_id: claim.orderId });
  if (!fin || fin.display_ref !== ref) return null;
  return fin;
}
