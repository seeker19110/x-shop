/**
 * Danh mục MỌI endpoint server của storefront (BE-AUTH-009, PRF-WEB-004): mỗi export của file `"use server"` (Server
 * Action = endpoint POST công khai, ai cũng gọi được với tham số tuỳ ý), mỗi phương thức HTTP của `app/**\/route.ts` và
 * mỗi metadata route (`robots`, `sitemap`, `manifest`, `opengraph-image`, `twitter-image`, `icon`, `apple-icon` → `#GET`).
 * `server-actions.test.ts` quét mã nguồn và đỏ khi: có endpoint chưa khai ở đây, mục ở đây không còn trong mã, mục thiếu
 * lý do/kiểu quyền, hoặc file bằng chứng không nhắc tới endpoint. Thêm action/route mới → thêm mục kèm test quyền.
 *
 * Chống CSRF áp chung ở `proxy.ts` (lib/security/csrf.ts) cho mọi request ghi; danh mục này nói về QUYỀN trên dữ liệu.
 */

export type AccessKind =
  /** Chỉ thao tác trên giỏ có id trong cookie HttpOnly `xs_cart`; id giỏ KHÔNG nhận từ client. */
  | "cart_cookie"
  /**
   * Chỉ đọc/ghi đơn có token phiên đơn trong cookie HttpOnly `xs_order_<mã đơn>` (backend ký và kiểm). Mã đơn từ client
   * chỉ dùng để chọn cookie; không có cookie → `not_found` như đơn không tồn tại, không gọi backend.
   */
  | "order_cookie"
  /** Liên kết tra cứu một lần (token do backend cấp, kiểm và tiêu ở backend); thất bại mọi kiểu → cùng một kết quả. */
  | "link_token"
  /** Webhook máy-với-máy: chữ ký HMAC + dấu thời gian + nonce chống phát lại. */
  | "hmac"
  /** Công khai có chủ đích: không đọc/ghi dữ liệu riêng của ai; lý do ghi ở `reason`. */
  | "public";

export interface EndpointEntry {
  /** Một hoặc nhiều cơ chế quyền cùng áp (vd trang trở về VNPAY: giỏ của phiên → đơn của phiên). */
  access: readonly [AccessKind, ...AccessKind[]];
  /** Vì sao kiểu quyền này đủ — đọc được bởi người review. */
  reason: string;
  /** File test (tương đối `apps/storefront/src`) kiểm hành vi quyền; phải nhắc tên export (action) hoặc đường URL (route). */
  proof: string;
}

const PROOF = "lib/security/server-actions.test.ts";

/** Khoá: `<file tương đối src>#<tên export>` (Server Action) hoặc `<file route.ts>#<PHƯƠNG THỨC>`. */
export const ENDPOINT_ALLOWLIST: Readonly<Record<string, EndpointEntry>> = {
  /* ---------------------------------------------------------------- Server Action: giỏ */
  "lib/cart/actions.ts#addToCart": {
    access: ["cart_cookie"],
    reason:
      "Thêm vào giỏ của cookie (không có thì tạo giỏ mới và đặt cookie); biến thể kiểm lại bằng catalog không cache.",
    proof: PROOF,
  },
  "lib/cart/actions.ts#updateLineQuantity": {
    access: ["cart_cookie"],
    reason: "lineId phải thuộc giỏ của cookie, không thì NOT_FOUND và không ghi.",
    proof: PROOF,
  },
  "lib/cart/actions.ts#removeCartLine": {
    access: ["cart_cookie"],
    reason: "lineId phải thuộc giỏ của cookie, không thì NOT_FOUND và không ghi.",
    proof: PROOF,
  },
  "lib/cart/actions.ts#changeLineVariant": {
    access: ["cart_cookie"],
    reason: "lineId phải thuộc giỏ của cookie, không thì NOT_FOUND và không ghi.",
    proof: PROOF,
  },
  "lib/cart/actions.ts#refreshCartLine": {
    access: ["cart_cookie"],
    reason: "lineId phải thuộc giỏ của cookie, không thì NOT_FOUND và không ghi.",
    proof: PROOF,
  },
  "lib/cart/actions.ts#forgetCart": {
    access: ["cart_cookie"],
    reason: "Chỉ xoá cookie giỏ của chính trình duyệt gọi; không gọi backend.",
    proof: PROOF,
  },
  /* ---------------------------------------------------------------- Server Action: checkout */
  "lib/checkout/actions.ts#quoteCheckout": {
    access: ["cart_cookie"],
    reason: "cart_id gửi backend luôn từ cookie; trường cart_id client chèn vào bị bỏ qua.",
    proof: PROOF,
  },
  "lib/checkout/actions.ts#submitCheckout": {
    access: ["cart_cookie"],
    reason: "cart_id gửi backend luôn từ cookie; backend kiểm giỏ/quote/phiên bản (giỏ người khác → 404).",
    proof: PROOF,
  },
  "lib/checkout/actions.ts#pollCheckout": {
    access: ["cart_cookie"],
    reason: "Attempt chỉ xem được kèm cart_id của cookie; attempt của giỏ khác → như không tồn tại.",
    proof: PROOF,
  },
  "lib/checkout/actions.ts#finishCheckout": {
    access: ["cart_cookie"],
    reason: "Chỉ xoá cookie giỏ của chính trình duyệt gọi; không gọi backend.",
    proof: PROOF,
  },
  /* ---------------------------------------------------------------- Server Action: đơn */
  "lib/orders/actions.ts#recheckOrderAction": {
    access: ["order_cookie"],
    reason: "Mã đơn chỉ chọn cookie token phiên đơn; không có/không hợp lệ → not_found, không gọi backend.",
    proof: PROOF,
  },
  "lib/orders/actions.ts#cancelOrderAction": {
    access: ["order_cookie"],
    reason:
      "Mã đơn chỉ chọn cookie token phiên đơn; token của đơn khác → backend 404 → not_found, không huỷ.",
    proof: PROOF,
  },
  "lib/orders/actions.ts#lookupOrderAction": {
    access: ["public"],
    reason:
      "Tra cứu bằng mã đơn + SĐT: luôn cùng một thông điệp (không lộ đơn tồn tại), không trả dữ liệu đơn; liên kết gửi tới liên hệ của đơn; backend giới hạn tần suất.",
    proof: PROOF,
  },
  "lib/orders/actions.ts#redeemLinkAction": {
    access: ["link_token"],
    reason:
      "Đổi token liên kết một lần thành cookie phiên đơn; mọi thất bại → cùng trang lỗi, không ghi cookie.",
    proof: PROOF,
  },
  /* ---------------------------------------------------------------- Route handler */
  "app/(shop)/thanh-toan/ket-qua/route.ts#GET": {
    access: ["cart_cookie", "order_cookie"],
    reason:
      "Trở về từ VNPAY: attempt chỉ tra theo giỏ của cookie, đơn chỉ mở khi có cookie phiên đơn; tham số vnp_* không cấp quyền.",
    proof: PROOF,
  },
  "app/api/cart/count/route.ts#GET": {
    access: ["cart_cookie"],
    reason: "Số lượng của giỏ trong cookie; bỏ qua mọi tham số query; private, no-store.",
    proof: PROOF,
  },
  "app/api/revalidate/route.ts#POST": {
    access: ["hmac"],
    reason:
      "Webhook backend → storefront vô hiệu cache catalog; HMAC + chống phát lại (lib/catalog/revalidate.ts).",
    proof: "app/api/revalidate/revalidate-route.test.ts",
  },
  "app/api/analytics/route.ts#POST": {
    access: ["public"],
    reason: "Nhận sự kiện ẩn danh theo schema đóng, từ chối dữ liệu giống PII, chỉ đếm; không đọc cookie.",
    proof: "app/api/analytics/analytics-route.test.ts",
  },
  "app/api/address/wards/route.ts#GET": {
    access: ["public"],
    reason: "Danh mục phường/xã công khai, cache dài.",
    proof: PROOF,
  },
  "app/api/catalog/count/route.ts#GET": {
    access: ["public"],
    reason: "Đếm sản phẩm đang bán theo bộ lọc; chỉ trả { total }.",
    proof: PROOF,
  },
  "app/api/catalog/suggest/route.ts#GET": {
    access: ["public"],
    reason: "Gợi ý tên sản phẩm đang bán; chỉ trả { suggestions }.",
    proof: PROOF,
  },
  /* ---------------------------------------------------------------- Metadata route (GET qua export default) */
  "app/robots.ts#GET": {
    access: ["public"],
    reason: "robots.txt cho bot: quy tắc tĩnh + URL sitemap; không đọc cookie.",
    proof: PROOF,
  },
  "app/sitemap.ts#GET": {
    access: ["public"],
    reason: "Sitemap các trang công khai (sản phẩm/danh mục đang bán); không đọc cookie.",
    proof: PROOF,
  },
  "app/manifest.ts#GET": {
    access: ["public"],
    reason: "Web app manifest tĩnh (PWA); không đọc cookie.",
    proof: PROOF,
  },
};
