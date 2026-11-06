import type { Permission } from "@x-shop/domain";

/**
 * RBAC cho route admin NATIVE của Medusa (T-023). RBAC native là Enterprise (`MEDUSA_FF_RBAC`) — không bật; bảng này
 * áp ma trận vai trò của dự án lên route native. Tra theo thứ tự, mục đầu tiên khớp thắng (cụ thể → chung).
 *
 * Route native KHÔNG có trong bảng — đóng mặc định (T-147, D-080):
 *   - đọc (GET/HEAD) → từ chối với MỌI vai trò, kể cả owner (`deny UNDECLARED_ROUTE`, như `/admin/x/*` chưa khai) — route
 *     đọc mới của Medusa (nâng cấp) không tự mở cho mọi nhân viên;
 *   - ghi (POST/PUT/PATCH/DELETE) → `settings.manage` (chỉ owner, kèm MFA).
 * User chưa có vai trò nào chỉ được đọc hồ sơ mình (`GET /admin/users/me`).
 *
 * Mục ĐỌC dưới đây = mọi route GET mà dashboard Medusa 2.22.1 gọi (nguồn: `sdk.admin.*` trong bundle
 * `@medusajs/dashboard/dist` ánh xạ sang path qua `@medusajs/js-sdk/dist/esm/admin`, đối chiếu cây route
 * `@medusajs/medusa/dist/api/admin/**\/route.js`; test rbac.spec.ts quét lại cả hai nên nâng cấp Medusa thêm route là đỏ).
 * Nguyên tắc cấp đọc (theo PATH):
 *   - dữ liệu tham chiếu mà khung dashboard/bộ lọc của nhiều vai trò cần (cửa hàng, vùng, tiền tệ, kênh bán, ngôn ngữ,
 *     plugin, lý do đổi trả/hoàn tiền, cấu hình cột) → `any_role` (vẫn phải có ít nhất một vai trò). Trường RIÊNG của các
 *     thực thể này không có PII, nhưng chúng có quan hệ/link ngược tới đơn, giỏ, khách (`Region.orders`,
 *     `SalesChannel.orders`, `RefundReason.refunds…`) — đọc được chỉ vì `field-policy.ts` chặn các quan hệ đó qua `?fields=`;
 *   - dữ liệu nghiệp vụ → quyền đọc của màn hình đó (catalog → `catalog.read`, tồn/kho → `inventory.read`, đơn/khách →
 *     `order.read`, thanh toán → `payment.read`, giá/khuyến mãi → `price.write`);
 *   - PII (khách, đơn kèm địa chỉ/SĐT, người dùng, lời mời, thông báo kèm người nhận, tìm kiếm toàn cục trả email khách/
 *     người dùng/khoá API) chỉ cho vai trò cần: `order.read` (đơn/khách) hoặc `user.manage`/`settings.manage` (owner).
 *     CSKH (`order.read_masked`) và kho/catalog KHÔNG đọc PII qua route native — CSKH xem đơn đã che qua `/admin/x/*`.
 * Path chỉ là nửa đầu: route native nhận `?fields=` tuỳ ý và remote query đi theo link, nên cổng còn áp chính sách TRƯỜNG
 * (`field-policy.ts`, MỌI method — handler ghi cũng tải lại thực thể theo `fields`): vai trò thiếu `order.read` không mở được
 * quan hệ tới đơn/giỏ/khách/vận đơn/thanh toán/người dùng (403 nếu yêu cầu, gỡ khỏi trường mặc định) và route vận đơn của kho
 * chỉ trả trường tối thiểu; vai trò thiếu `catalog.read` không đi vào sản phẩm/biến thể ngoài họ đơn hàng, route biến thể kèm
 * tồn và tồn kho chỉ trả trường tồn kho.
 *
 * `deny`: route native đóng với MỌI vai trò, kể cả owner (T-044) — đi vòng sổ/duyệt của `/admin/x/*`:
 *   - `NATIVE_MONEY_ROUTE`: ghi tiền native (capture/refund/mark-as-paid/payment-collection/credit-line) lách duyệt hoàn
 *     tiền 2 người + sổ `x_refund`/ledger (S-403, S-108) → hoàn tiền chỉ qua `/admin/x/refunds`;
 *   - `NATIVE_ORDER_CANCEL`: `cancelOrderWorkflow` ghi refund native qua provider hệ thống khi tiền thật chưa hoàn
 *     (D-012) → nhân viên hủy qua `POST /admin/x/orders/:id/cancel`;
 *   - `UNDECLARED_ROUTE`: đọc native chưa khai trong bảng (mặc định đóng, T-147).
 */
/** Route biến thể kèm tồn — ngoại lệ đọc cho form tạo vận đơn native (giới hạn trường ở field-policy.ts). */
export const NATIVE_VARIANT_INVENTORY_ROUTE = "/admin/products/:id/variants/:variant_id";

export type NativeDenyReason = "NATIVE_MONEY_ROUTE" | "NATIVE_ORDER_CANCEL" | "UNDECLARED_ROUTE";

export type NativeRule =
  | { kind: "public" }
  | { kind: "self" }
  | { kind: "any_role" }
  | { kind: "deny"; reason: NativeDenyReason }
  | { kind: "permission"; permission: Permission };

export interface NativeRoute {
  methods: readonly ("READ" | "WRITE" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
  path: string;
  rule: NativeRule;
}

const p = (permission: Permission): NativeRule => ({ kind: "permission", permission });
const deny = (reason: NativeDenyReason): NativeRule => ({ kind: "deny", reason });
const R = ["READ"] as const;
const W = ["WRITE"] as const;
const ALL = ["READ", "WRITE"] as const;

export const NATIVE_ADMIN_ROUTES: readonly NativeRoute[] = [
  // Không xác thực (route native tự opt-out khỏi auth): chấp nhận lời mời, cờ tính năng.
  { methods: ["POST"], path: "/admin/invites/accept", rule: { kind: "public" } },
  { methods: R, path: "/admin/feature-flags", rule: { kind: "public" } },
  // Hồ sơ của chính mình — mọi user đã đăng nhập, kể cả chưa có vai trò.
  { methods: R, path: "/admin/users/me", rule: { kind: "self" } },
  // Người dùng, lời mời, khoá API, cấu hình cửa hàng
  { methods: ALL, path: "/admin/users/*", rule: p("user.manage") },
  { methods: ALL, path: "/admin/invites/*", rule: p("user.manage") },
  { methods: ALL, path: "/admin/api-keys/*", rule: p("settings.manage") },
  { methods: W, path: "/admin/stores/*", rule: p("settings.manage") },
  { methods: ALL, path: "/admin/rbac/*", rule: p("settings.manage") },
  { methods: ALL, path: "/admin/workflows-executions/*", rule: p("settings.manage") },
  // Thông báo native chứa người nhận (`to` = email/SĐT) + dữ liệu đơn → chỉ owner. Chuông thông báo ở khung dashboard
  // của vai trò khác nhận 403 và bỏ qua (không vỡ trang).
  { methods: ALL, path: "/admin/notifications/*", rule: p("settings.manage") },
  // Tìm kiếm toàn cục native (Cmd-K): một lời gọi quét MỌI thực thể — đơn (email), khách (email/tên), người dùng, khoá
  // API — nên chỉ owner; chỉ số tìm kiếm là cấu hình.
  { methods: R, path: "/admin/search", rule: p("settings.manage") },
  { methods: R, path: "/admin/search-indexes/*", rule: p("settings.manage") },
  // Cấu hình chỉ màn Cài đặt (owner) dùng: thuế, nhà cung cấp vận chuyển, loại phương án giao.
  { methods: R, path: "/admin/tax-providers/*", rule: p("settings.manage") },
  { methods: R, path: "/admin/tax-rates/*", rule: p("settings.manage") },
  { methods: R, path: "/admin/tax-regions/*", rule: p("settings.manage") },
  { methods: R, path: "/admin/fulfillment-providers/*", rule: p("settings.manage") },
  { methods: R, path: "/admin/shipping-option-types/*", rule: p("settings.manage") },
  // Tham chiếu cho khung dashboard + bộ lọc của mọi màn (T-147; quan hệ ngược tới đơn/khách bị field-policy.ts chặn với vai
  // trò thiếu order.read): header đọc cửa hàng (lỗi → vỡ cả khung), vùng/
  // kênh bán ở bộ lọc đơn/sản phẩm, tiền tệ/ngôn ngữ, plugin (trang chi tiết đơn), lý do đổi trả/hoàn tiền (form đơn),
  // cấu hình cột/bố cục bảng (cờ view_configurations).
  { methods: R, path: "/admin/stores/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/regions/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/sales-channels/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/currencies/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/locales/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/plugins", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/return-reasons/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/refund-reasons/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/views/*", rule: { kind: "any_role" } },
  { methods: R, path: "/admin/layouts/*", rule: { kind: "any_role" } },
  // Tiền (T-044, S-403): MỌI ghi native — capture/refund/đánh dấu đã trả/tạo-xóa payment collection/credit line — đóng
  // với mọi vai trò, kể cả owner; hoàn tiền chỉ qua /admin/x/refunds (sổ + duyệt 2 người). Đọc vẫn theo payment.read.
  { methods: W, path: "/admin/payments/*", rule: deny("NATIVE_MONEY_ROUTE") },
  { methods: R, path: "/admin/payments/*", rule: p("payment.read") },
  { methods: W, path: "/admin/payment-collections/*", rule: deny("NATIVE_MONEY_ROUTE") },
  { methods: R, path: "/admin/payment-collections/*", rule: p("payment.read") },
  { methods: W, path: "/admin/orders/:id/credit-lines/*", rule: deny("NATIVE_MONEY_ROUTE") },
  // Đơn hàng — hủy native ghi refund native khi tiền thật chưa hoàn (D-012) → đóng; dùng POST /admin/x/orders/:id/cancel.
  { methods: W, path: "/admin/orders/:id/cancel", rule: deny("NATIVE_ORDER_CANCEL") },
  { methods: ["POST"], path: "/admin/orders/:id/complete", rule: p("order.confirm") },
  { methods: ["POST"], path: "/admin/orders/:id/fulfillments/:fid/cancel", rule: p("fulfillment.update") },
  { methods: ["POST"], path: "/admin/orders/:id/fulfillments/:fid/shipments", rule: p("fulfillment.update") },
  {
    methods: ["POST"],
    path: "/admin/orders/:id/fulfillments/:fid/mark-as-delivered",
    rule: p("fulfillment.update"),
  },
  { methods: ["POST"], path: "/admin/orders/:id/fulfillments", rule: p("fulfillment.create") },
  { methods: W, path: "/admin/fulfillments/*", rule: p("fulfillment.update") },
  { methods: R, path: "/admin/fulfillments/*", rule: p("order.read") },
  { methods: R, path: "/admin/orders/*", rule: p("order.read") },
  { methods: R, path: "/admin/order-changes/*", rule: p("order.read") },
  { methods: R, path: "/admin/order-edits/*", rule: p("order.read") },
  { methods: R, path: "/admin/draft-orders/*", rule: p("order.read") },
  { methods: R, path: "/admin/returns/*", rule: p("order.read") },
  { methods: R, path: "/admin/claims/*", rule: p("order.read") },
  { methods: R, path: "/admin/exchanges/*", rule: p("order.read") },
  // Khách hàng (PII đầy đủ) — CSKH chỉ có order.read_masked nên không đọc qua route native.
  { methods: R, path: "/admin/customers/*", rule: p("order.read") },
  { methods: R, path: "/admin/customer-groups/*", rule: p("order.read") },
  // Tồn kho: điều chỉnh có lý do/khóa chống trùng đi qua POST /admin/x/inventory/adjustments (INV03).
  // D-010: ghi tồn native đi vòng qua lý do/idempotency/khóa của INV03 → chỉ owner; kho dùng /admin/x/inventory/adjustments.
  { methods: W, path: "/admin/inventory-items/*", rule: p("settings.manage") },
  { methods: R, path: "/admin/inventory-items/*", rule: p("inventory.read") },
  // Đổi `location_id` của reservation (POST /admin/reservations/:id) bị chặn thêm 400 RESERVATION_LOCATION_CHANGE_UNSUPPORTED
  // sau cổng này — lỗi gốc Medusa 2.22.1 luôn lệch số giữ ở kho cũ (T-224, reservation-guard.ts).
  { methods: W, path: "/admin/reservations/*", rule: p("settings.manage") },
  { methods: R, path: "/admin/reservations/*", rule: p("inventory.read") },
  // Kho hàng (địa chỉ kho của shop, không PII): màn tồn kho/giữ hàng, chi tiết đơn (kho của vận đơn), form tạo vận đơn.
  { methods: R, path: "/admin/stock-locations/*", rule: p("inventory.read") },
  // Form tạo vận đơn native (fulfillment.create) đọc biến thể kèm tồn từng kho → cùng quyền đọc tồn (đơn/kho/catalog).
  // Vai trò thiếu catalog.read chỉ nhận trường tồn kho (field-policy.ts: VARIANT_INVENTORY_FIELDS).
  { methods: R, path: NATIVE_VARIANT_INVENTORY_ROUTE, rule: p("inventory.read") },
  // Phương án giao: form tạo vận đơn native của nhân viên đơn (+ owner ở Cài đặt).
  { methods: R, path: "/admin/shipping-options/*", rule: p("fulfillment.create") },
  // Catalog / giá
  { methods: ["POST"], path: "/admin/products/import*", rule: p("catalog.import") },
  { methods: ["POST"], path: "/admin/products/imports/*", rule: p("catalog.import") },
  { methods: W, path: "/admin/products/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/product-variants/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/product-categories/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/collections/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/product-tags/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/product-types/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/product-options/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/uploads/*", rule: p("catalog.write") },
  { methods: W, path: "/admin/price-lists/*", rule: p("price.write") },
  { methods: W, path: "/admin/promotions/*", rule: p("price.write") },
  { methods: W, path: "/admin/campaigns/*", rule: p("price.write") },
  { methods: W, path: "/admin/price-preferences/*", rule: p("price.write") },
  // Đọc catalog (catalog_manager, kho, owner): sản phẩm/biến thể/danh mục/bộ sưu tập/tag/loại/tuỳ chọn, nhãn thuộc tính,
  // bản dịch nội dung, hồ sơ giao hàng + tuỳ chọn giá gồm thuế (form tạo/sửa sản phẩm, bảng giá).
  { methods: R, path: "/admin/products/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/product-variants/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/product-categories/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/collections/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/product-tags/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/product-types/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/product-options/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/property-labels/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/translations/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/shipping-profiles/*", rule: p("catalog.read") },
  { methods: R, path: "/admin/price-preferences/*", rule: p("catalog.read") },
  // Bảng giá / khuyến mãi / chiến dịch: chỉ người quản lý giá (catalog_manager, owner) — chưa có quyền `price.read` riêng.
  { methods: R, path: "/admin/price-lists/*", rule: p("price.write") },
  { methods: R, path: "/admin/promotions/*", rule: p("price.write") },
  { methods: R, path: "/admin/campaigns/*", rule: p("price.write") },
];

const READ = new Set(["GET", "HEAD", "OPTIONS"]);

function methodMatches(methods: NativeRoute["methods"], method: string): boolean {
  return methods.some((m) =>
    m === "READ" ? READ.has(method) : m === "WRITE" ? !READ.has(method) : m === method,
  );
}

export function resolveNativeRule(
  method: string,
  path: string,
  matchPath: (pattern: string, path: string) => boolean,
): NativeRule {
  for (const r of NATIVE_ADMIN_ROUTES) {
    if (!methodMatches(r.methods, method)) continue;
    // "import*" (không có "/") = tiền tố đoạn cuối: /admin/products/import, /admin/products/imports…
    if (r.path.endsWith("*") && !r.path.endsWith("/*")) {
      if (path.startsWith(r.path.slice(0, -1))) return r.rule;
      continue;
    }
    if (matchPath(r.path, path)) return r.rule;
  }
  return READ.has(method)
    ? { kind: "deny", reason: "UNDECLARED_ROUTE" }
    : { kind: "permission", permission: "settings.manage" };
}
