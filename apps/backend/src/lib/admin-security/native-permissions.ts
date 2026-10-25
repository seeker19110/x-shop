import type { Permission } from "@x-shop/domain";

/**
 * RBAC cho route admin NATIVE của Medusa (T-023). RBAC native là Enterprise (`MEDUSA_FF_RBAC`) — không bật; bảng này
 * áp ma trận vai trò của dự án lên route native nhạy cảm. Tra theo thứ tự, mục đầu tiên khớp thắng (cụ thể → chung).
 *
 * Route native KHÔNG có trong bảng:
 *   - đọc (GET/HEAD) → cần có ít nhất một vai trò (`any_role`);
 *   - ghi (POST/PUT/PATCH/DELETE) → `settings.manage` (chỉ owner, kèm MFA) — fail-closed cho mọi route native mới.
 * User chưa có vai trò nào chỉ được đọc hồ sơ mình (`GET /admin/users/me`).
 */
export type NativeRule =
  | { kind: "public" }
  | { kind: "self" }
  | { kind: "any_role" }
  | { kind: "permission"; permission: Permission };

export interface NativeRoute {
  methods: readonly ("READ" | "WRITE" | "GET" | "POST" | "PUT" | "PATCH" | "DELETE")[];
  path: string;
  rule: NativeRule;
}

const p = (permission: Permission): NativeRule => ({ kind: "permission", permission });
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
  { methods: ALL, path: "/admin/notifications/*", rule: p("settings.manage") },
  // Tiền: capture/refund/đánh dấu đã trả/credit line
  { methods: ["POST"], path: "/admin/payments/:id/capture", rule: p("refund.execute") },
  { methods: ["POST"], path: "/admin/payments/:id/refund", rule: p("refund.execute") },
  { methods: W, path: "/admin/payments/*", rule: p("refund.execute") },
  { methods: R, path: "/admin/payments/*", rule: p("payment.read") },
  { methods: W, path: "/admin/payment-collections/*", rule: p("refund.execute") },
  { methods: R, path: "/admin/payment-collections/*", rule: p("payment.read") },
  { methods: ["POST"], path: "/admin/orders/:id/credit-lines", rule: p("refund.execute") },
  // Đơn hàng
  { methods: ["POST"], path: "/admin/orders/:id/cancel", rule: p("order.cancel") },
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
  { methods: W, path: "/admin/reservations/*", rule: p("settings.manage") },
  { methods: R, path: "/admin/reservations/*", rule: p("inventory.read") },
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
  return READ.has(method) ? { kind: "any_role" } : { kind: "permission", permission: "settings.manage" };
}
