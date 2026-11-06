/**
 * Giao thức webhook vô hiệu hoá cache catalog backend → storefront (T-142, D-070, BE-CACHE-007). Một nơi khai báo chuỗi
 * ký, header và tên tag để hai phía không lệch nhau:
 *
 *  - Backend POST `{ "id": string, "tags": string[] }` (JSON) tới route `/api/revalidate` của storefront, kèm 3 header:
 *    `x-xshop-timestamp` (giây Unix), `x-xshop-nonce` (ngẫu nhiên, mỗi lần gửi một giá trị mới) và
 *    `x-xshop-signature` = `v1=` + hex(HMAC-SHA256(khoá, `v1:<timestamp>:<nonce>:<thân thô>`)).
 *  - Storefront kiểm chữ ký trên THÂN THÔ (trước khi parse), lệch giờ tối đa `REVALIDATE_TOLERANCE_S` theo cả hai chiều,
 *    nonce đã thấy trong cửa sổ đó → phát lại (409). Khoá chung ≥ 32 ký tự, chỉ ở server hai phía.
 *
 * Theo cùng mẫu chữ ký có mốc thời gian của Stripe/GitHub webhook (HMAC-SHA256 trên timestamp + thân thô, so sánh thời gian
 * hằng) — thêm nonce để chặn phát lại TRONG cửa sổ lệch giờ.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { kibToBytes, msToSeconds } from "../units.js";

export const REVALIDATE_HEADERS = {
  timestamp: "x-xshop-timestamp",
  nonce: "x-xshop-nonce",
  signature: "x-xshop-signature",
} as const;

export const REVALIDATE_SIGNATURE_VERSION = "v1";
/** Lệch giờ tối đa (giây) giữa lúc ký và lúc nhận, theo cả hai chiều. */
export const REVALIDATE_TOLERANCE_S = 300;
/** Trần thân request (byte UTF-8). */
export const REVALIDATE_MAX_BODY_BYTES = kibToBytes(16);
/** Trần số tag mỗi request (Next nhận tối đa 128 tag/mục cache; webhook gộp ít hơn nhiều). */
export const REVALIDATE_MAX_TAGS = 64;

/** Mọi dữ liệu catalog công khai storefront nạp từ backend (danh sách, tìm kiếm, PDP, danh mục). */
export const CATALOG_TAG = "catalog";
/** Dữ liệu gộp nhiều sản phẩm (danh sách, tìm kiếm, danh mục) — đổi một sản phẩm bất kỳ là phải làm mới. */
export const CATALOG_LIST_TAG = "catalog:list";
const PRODUCT_TAG_PREFIX = "product:";
/** Trần độ dài tag của Next 16 (`NEXT_CACHE_TAG_MAX_LENGTH`). */
export const MAX_TAG_LENGTH = 256;

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP = /^\d{1,12}$/;
const SIGNATURE = /^v1=[0-9a-f]{64}$/;
/** Ký tự đầu ra của `encodeURIComponent` (+ `%XX`). */
const ENCODED_HANDLE = /^[A-Za-z0-9\-_.!~*'()%]+$/;

/**
 * Tag dữ liệu PDP của một sản phẩm theo handle (storefront nạp PDP theo handle). `null` khi handle rỗng hoặc tag quá dài —
 * bên gửi khi đó phải dùng `CATALOG_TAG` (làm mới cả catalog) để không bỏ sót.
 */
export function productTag(handle: string): string | null {
  if (handle === "") return null;
  const tag = PRODUCT_TAG_PREFIX + encodeURIComponent(handle);
  return tag.length <= MAX_TAG_LENGTH ? tag : null;
}

/** Tag hợp lệ trong webhook: `catalog`, `catalog:list` hoặc `product:<handle đã encode>` (≤ 256 ký tự). */
export function isRevalidateTag(tag: unknown): tag is string {
  if (typeof tag !== "string") return false;
  if (tag === CATALOG_TAG || tag === CATALOG_LIST_TAG) return true;
  if (!tag.startsWith(PRODUCT_TAG_PREFIX) || tag.length > MAX_TAG_LENGTH) return false;
  return ENCODED_HANDLE.test(tag.slice(PRODUCT_TAG_PREFIX.length));
}

/** Chuỗi được ký. Thân là chuỗi THÔ đúng như gửi trên dây (không parse/serialize lại). */
export function signingInput(timestamp: string, nonce: string, body: string): string {
  return `${REVALIDATE_SIGNATURE_VERSION}:${timestamp}:${nonce}:${body}`;
}

export function signRevalidate(secret: string, timestamp: string, nonce: string, body: string): string {
  const mac = createHmac("sha256", secret)
    .update(signingInput(timestamp, nonce, body), "utf8")
    .digest("hex");
  return `${REVALIDATE_SIGNATURE_VERSION}=${mac}`;
}

export interface SignedHeaders {
  timestamp: string | null;
  nonce: string | null;
  signature: string | null;
}

export type VerifyFailure = "missing_header" | "malformed" | "expired" | "bad_signature";
export type VerifyResult =
  { ok: true; timestamp: number; nonce: string } | { ok: false; reason: VerifyFailure };

/**
 * Kiểm chữ ký + mốc thời gian (KHÔNG kiểm nonce đã dùng — việc của bên nhận, sau khi chữ ký đúng để kẻ không có khoá
 * không làm đầy bộ nhớ nonce). Mọi lỗi trả lý do ngắn, không chứa giá trị nhận được.
 */
export function verifyRevalidate(
  secret: string,
  headers: SignedHeaders,
  body: string,
  nowMs: number,
  toleranceS: number = REVALIDATE_TOLERANCE_S,
): VerifyResult {
  const { timestamp, nonce, signature } = headers;
  if (timestamp === null || nonce === null || signature === null)
    return { ok: false, reason: "missing_header" };
  if (!TIMESTAMP.test(timestamp) || !NONCE.test(nonce) || !SIGNATURE.test(signature)) {
    return { ok: false, reason: "malformed" };
  }
  const ts = Number(timestamp);
  if (Math.abs(msToSeconds(nowMs) - ts) > toleranceS) return { ok: false, reason: "expired" };
  const expected = Buffer.from(signRevalidate(secret, timestamp, nonce, body), "utf8");
  const got = Buffer.from(signature, "utf8");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, timestamp: ts, nonce };
}
