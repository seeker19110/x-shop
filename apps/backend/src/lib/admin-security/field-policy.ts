import { can, type Role } from "@x-shop/domain";
import { NATIVE_VARIANT_INVENTORY_ROUTE } from "./native-permissions";
import { matchPath } from "./route-match";

/**
 * Lọc `?fields=`/`?order=` cho route admin native (T-147 review, D-108). Cổng RBAC xét path; route native của Medusa 2.22.1
 * nhận `fields` tuỳ ý và remote query đi theo link (kể cả link chỉ đọc) — `GET /admin/regions?fields=orders.email,
 * orders.shipping_address.*` trả PII đơn cho vai trò chỉ được đọc vùng; handler GHI cũng tải lại thực thể theo
 * `req.queryConfig.fields` (`POST /admin/promotions/:id?fields=order_link.order.email`). Chính sách (mọi method):
 *  - vai trò KHÔNG có `order.read`: cấm `PII_FIELD_SEGMENTS`/`PII_FIELD_PATTERNS`; route họ đơn hàng mà vai trò đó vẫn gọi
 *    được (ghi `fulfillment.update` của kho) chỉ trả `ORDER_MIN_FIELDS`/`FULFILLMENT_MIN_FIELDS`;
 *  - vai trò KHÔNG có `catalog.read`: cấm `CATALOG_FIELD_SEGMENTS` ngoài họ đơn hàng; route biến thể kèm tồn chỉ trả
 *    `VARIANT_INVENTORY_FIELDS`, tồn kho chỉ trả `INVENTORY_ITEM_FIELDS`.
 * Áp hai lớp: (1) `fields`/`order` yêu cầu chạm trường cấm → 403 + audit (lộ rõ hành vi dò, không trả dữ liệu cắt xén
 * khiến người gọi tưởng không có gì); (2) `req.disallowed`/`req.allowed` cho `validateAndTransformQuery` của Medusa (route
 * đọc lẫn ghi đều dùng) gỡ trường cấm khỏi cả trường MẶC ĐỊNH của route (không nằm trong `fields`).
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

/**
 * Đoạn quan hệ dẫn vào catalog (sản phẩm/biến thể, kể cả bảng nối `products_link`, `variant_link`) — cấm với vai trò thiếu
 * `catalog.read` ở mọi route native NGOÀI họ đơn hàng (đơn/vận đơn hiển thị tên sản phẩm của dòng hàng là hợp lệ).
 * Chặn `?fields=products_link.product.title` trên kênh bán, `variants.product.*` trên tồn kho… (sản phẩm nháp).
 */
export const CATALOG_FIELD_SEGMENTS: readonly string[] = [
  "product",
  "products",
  "variant",
  "variants",
  "product_variant",
  "product_variants",
  "products_link",
  "variant_link",
];

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

/**
 * Tồn kho cho vai trò thiếu `catalog.read` (nhân viên đơn): trường riêng của inventory item + mức tồn từng kho (trường mặc
 * định của `/admin/inventory-items*` trong Medusa 2.22.1), không có `variants`/`product`.
 */
export const INVENTORY_ITEM_FIELDS: readonly string[] = [
  "id",
  "sku",
  "title",
  "description",
  "thumbnail",
  "origin_country",
  "hs_code",
  "requires_shipping",
  "mid_code",
  "material",
  "unit_of_measure",
  "weight",
  "length",
  "height",
  "width",
  "metadata",
  "reserved_quantity",
  "stocked_quantity",
  "created_at",
  "updated_at",
  "location_levels",
  // `/admin/inventory-items/:id/location-levels` (gốc là inventory_level)
  "inventory_item_id",
  "location_id",
  "incoming_quantity",
  "available_quantity",
  // Bảng mức tồn của màn chi tiết tồn kho: `fields=+stock_locations.id,+stock_locations.name` (tên kho, không PII).
  "stock_locations",
  "stock_locations.id",
  "stock_locations.name",
];

/** Đơn trả về cho vai trò thiếu `order.read` (kho tạo/giao vận đơn native): không email, khách, địa chỉ, dòng hàng, tiền. */
export const ORDER_MIN_FIELDS: readonly string[] = [
  "id",
  "display_id",
  "status",
  "version",
  "created_at",
  "updated_at",
];

/** Vận đơn trả về cho vai trò thiếu `order.read`: mốc thời gian, nhãn (mã vận đơn), mặt hàng — không địa chỉ giao, `data`. */
export const FULFILLMENT_MIN_FIELDS: readonly string[] = [
  "id",
  "location_id",
  "provider_id",
  "shipping_option_id",
  "packed_at",
  "shipped_at",
  "delivered_at",
  "canceled_at",
  "created_at",
  "updated_at",
  "items",
  "labels",
];

/**
 * Họ route có gốc là dữ liệu đơn/khách/tiền. Vai trò thiếu `order.read` mà vẫn gọi được (route ghi `fulfillment.update` của
 * kho) chỉ nhận trường tối thiểu; họ khác không có route nào mở cho vai trò đó (đọc cần `order.read`, ghi mặc định owner) —
 * vẫn đặt `["id"]` để route mới mở nhầm cũng không trả dữ liệu.
 */
const ORDER_FAMILIES: readonly (readonly [string, readonly string[]])[] = [
  ["/admin/orders", ORDER_MIN_FIELDS],
  ["/admin/fulfillments", FULFILLMENT_MIN_FIELDS],
  ["/admin/order-changes", ["id"]],
  ["/admin/order-edits", ["id"]],
  ["/admin/draft-orders", ["id"]],
  ["/admin/returns", ["id"]],
  ["/admin/claims", ["id"]],
  ["/admin/exchanges", ["id"]],
  ["/admin/customers", ["id"]],
  ["/admin/customer-groups", ["id"]],
  ["/admin/payments", ["id"]],
  ["/admin/payment-collections", ["id"]],
];

const inFamily = (prefix: string, path: string) => path === prefix || path.startsWith(`${prefix}/`);

/** `path` thuộc họ đơn hàng (đơn, vận đơn, đổi trả, khách, thanh toán…). */
export const isOrderFamilyPath = (path: string) => ORDER_FAMILIES.some(([prefix]) => inFamily(prefix, path));

/**
 * Họ đơn hàng, vai trò thiếu `catalog.read` (nhân viên đơn, kế toán): tên sản phẩm/biến thể của DÒNG HÀNG là hợp lệ
 * (`items.variant.product`; `item.variant.product` ở `/admin/orders/:id/line-items`), nhưng không được đi vòng sang catalog
 * khác — `sales_channel.products_link.product.*` từng trả sản phẩm nháp. Cấm: mọi bảng nối `*_link`; đoạn số nhiều
 * (`products`, `variants`, `product_variants` — liệt kê sản phẩm khác); `product`/`variant`/`product_variant` lồng (có `.`
 * phía trước) mà KHÔNG nằm dưới `items.`/`item.`. Biểu thức cuối chỉ khớp đường dẫn đầy đủ (luôn cần `.`), nên không chặn một đoạn
 * đơn lẻ khi Medusa thử từng đoạn.
 */
export const ORDER_FAMILY_CATALOG_RULES: readonly (string | RegExp)[] = [
  ...PII_FIELD_PATTERNS,
  "products",
  "variants",
  "product_variants",
  /^(?!items?\.).*\.(?:product|variant|product_variant)(?:\.|$)/,
];

export interface FieldPolicy {
  /** Đoạn/biểu thức cấm — gán `req.disallowed` (Medusa gỡ khỏi cả trường mặc định). */
  disallowed: (string | RegExp)[];
  /** Danh sách trường cho phép duy nhất (đường dẫn đầy đủ) — gán `req.allowed`; `null` = không giới hạn. */
  allowed: string[] | null;
}

/**
 * Chính sách trường cho MỌI request admin native đã qua RBAC (đọc lẫn ghi — handler ghi của Medusa tải lại thực thể theo
 * `req.queryConfig.fields`); `null` = không giới hạn (vai trò đủ quyền).
 */
export function nativeFieldPolicy(path: string, roles: readonly Role[]): FieldPolicy | null {
  const orderRead = can(roles, "order.read");
  const catalogRead = can(roles, "catalog.read");
  const orderFamily = isOrderFamilyPath(path);
  const disallowed: (string | RegExp)[] = [
    ...(orderRead ? [] : [...PII_FIELD_SEGMENTS, ...PII_FIELD_PATTERNS]),
    ...(catalogRead ? [] : orderFamily ? ORDER_FAMILY_CATALOG_RULES : CATALOG_FIELD_SEGMENTS),
  ];
  let allowed: string[] | null = null;
  if (!orderRead && orderFamily) {
    allowed = [...(ORDER_FAMILIES.find(([prefix]) => inFamily(prefix, path))?.[1] ?? ["id"])];
  } else if (!catalogRead && matchPath(NATIVE_VARIANT_INVENTORY_ROUTE, path)) {
    allowed = [...VARIANT_INVENTORY_FIELDS];
  } else if (!catalogRead && inFamily("/admin/inventory-items", path)) {
    allowed = [...INVENTORY_ITEM_FIELDS];
  }
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
