import { can, type Role } from "@x-shop/domain";
import { NATIVE_VARIANT_INVENTORY_ROUTE } from "./native-permissions";
import { matchPath } from "./route-match";

/**
 * Lọc `?fields=` cho route ĐỌC admin native (T-147 review, D-108). Cổng RBAC xét path; route native của Medusa 2.22.1 nhận
 * `fields` tuỳ ý và remote query đi theo link (kể cả link chỉ đọc) — `GET /admin/regions?fields=orders.email,
 * orders.shipping_address.*` trả PII đơn cho vai trò chỉ được đọc vùng. Chính sách:
 *  - vai trò KHÔNG có `order.read`: mọi đoạn trong `PII_FIELD_SEGMENTS`/`PII_FIELD_PATTERNS` bị cấm ở mọi route đọc native;
 *  - route biến thể kèm tồn (`NATIVE_VARIANT_INVENTORY_ROUTE`) cho vai trò không có `catalog.read`: chỉ các trường trong
 *    `VARIANT_INVENTORY_FIELDS` (form tạo vận đơn) — không đọc catalog qua `product.*`, `prices`, `options`…
 * Áp hai lớp: (1) `fields`/`order` yêu cầu chạm trường cấm → 403 + audit (lộ rõ hành vi dò, không trả dữ liệu cắt xén
 * khiến người gọi tưởng không có gì); (2) `req.disallowed`/`req.allowed` cho `validateAndTransformQuery` của Medusa gỡ trường
 * cấm khỏi cả trường MẶC ĐỊNH của route (không nằm trong `fields`).
 */

/**
 * Đoạn quan hệ dẫn tới đơn, giỏ, khách, vận đơn (địa chỉ giao), thanh toán/hoàn tiền, người dùng — so khớp TỪNG đoạn của
 * đường dẫn trường (sau NFKC + chữ thường, như `DisallowedFieldFilter`). Test rbac.spec.ts quét định nghĩa link của
 * `@medusajs/link-modules`: alias mới dẫn tới thực thể nhạy cảm mà chưa có ở đây → đỏ.
 */
export const PII_FIELD_SEGMENTS: readonly string[] = [
  "order",
  "orders",
  "cart",
  "carts",
  "customer",
  "customers",
  "fulfillment",
  "fulfillments",
  "delivery_address",
  "shipping_address",
  "billing_address",
  "payment_collection",
  "payment_collections",
  "payment",
  "payments",
  "payment_sessions",
  "refunds",
  "captures",
  "account_holder",
  "account_holders",
  "order_items",
  "cart_items",
  "usages",
  "return",
  "returns",
  "claims",
  "exchanges",
  "user",
  "users",
  "invite",
  "invites",
];

/** Bảng nối của link (`order_link`, `payment_collection_link`, …) — chặn cả họ, kể cả alias tương lai. */
export const PII_FIELD_PATTERNS: readonly RegExp[] = [/_link$/];

/** Trường form tạo vận đơn native cần (dashboard: `*inventory,*inventory.location_levels,*inventory_items`). */
export const VARIANT_INVENTORY_FIELDS: readonly string[] = [
  "id",
  "title",
  "sku",
  "manage_inventory",
  "allow_backorder",
  "inventory_quantity",
  "inventory",
  "inventory.location_levels",
  "inventory_items",
];

export interface FieldPolicy {
  /** Đoạn/biểu thức cấm — gán `req.disallowed` (Medusa gỡ khỏi cả trường mặc định). */
  disallowed: (string | RegExp)[];
  /** Danh sách trường cho phép duy nhất (đường dẫn đầy đủ) — gán `req.allowed`; `null` = không giới hạn. */
  allowed: string[] | null;
}

/** Chính sách trường cho một request ĐỌC native đã qua RBAC; `null` = không giới hạn (vai trò đủ quyền). */
export function nativeReadFieldPolicy(path: string, roles: readonly Role[]): FieldPolicy | null {
  const disallowed: (string | RegExp)[] = can(roles, "order.read")
    ? []
    : [...PII_FIELD_SEGMENTS, ...PII_FIELD_PATTERNS];
  const allowed =
    matchPath(NATIVE_VARIANT_INVENTORY_ROUTE, path) && !can(roles, "catalog.read")
      ? [...VARIANT_INVENTORY_FIELDS]
      : null;
  return disallowed.length === 0 && allowed === null ? null : { disallowed, allowed };
}

const normalize = (s: string) => s.normalize("NFKC").trim().toLowerCase();

/**
 * Trường được YÊU CẦU qua `fields` (chuỗi phân tách dấu phẩy hoặc mảng) và `order` — đã bỏ tiền tố `+`/khoảng trắng/`*`,
 * hậu tố `.*`; trường bỏ (`-x`) không tính. `null` = tham số có dạng lạ (object…) → nơi gọi từ chối.
 */
export function requestedFields(query: Record<string, unknown> | undefined): string[] | null {
  const out: string[] = [];
  for (const key of ["fields", "order"] as const) {
    const raw: unknown = query?.[key];
    if (raw === undefined) continue;
    const parts = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
    if (parts === null || parts.some((p) => typeof p !== "string")) return null;
    for (const item of (parts as string[]).flatMap((p) => p.split(","))) {
      if (key === "fields" && /^\s*-/.test(item)) continue;
      const field = normalize(
        item
          .replace(/^[+ \t-]+/, "")
          .replace(/^\*/, "")
          .replace(/\.\*$/, ""),
      );
      if (field) out.push(field);
    }
  }
  // Khoá lồng `fields.x`/`order.x` (Medusa gộp thành object) — dạng lạ, từ chối.
  if (Object.keys(query ?? {}).some((k) => /^(fields|order)[.[]/i.test(k))) return null;
  return out;
}

/** Trường yêu cầu vi phạm chính sách (rỗng = được). */
export function forbiddenFields(requested: readonly string[], policy: FieldPolicy): string[] {
  const segments = new Set(policy.disallowed.filter((d): d is string => typeof d === "string"));
  const patterns = policy.disallowed.filter((d): d is RegExp => d instanceof RegExp);
  const allowed = policy.allowed === null ? null : new Set(policy.allowed);
  return requested.filter(
    (field) =>
      (allowed !== null && !allowed.has(field)) ||
      patterns.some((p) => p.test(field)) ||
      field.split(".").some((seg) => segments.has(seg) || patterns.some((p) => p.test(seg))),
  );
}
