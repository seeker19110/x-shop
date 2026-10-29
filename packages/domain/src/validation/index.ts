/**
 * `@x-shop/domain/validation` — subpath THUẦN cho client và server (FE-FORM-001, Q-03): chỉ phụ thuộc `zod/mini`, không
 * import mã khác của domain (tiền, sổ cái, máy trạng thái, provider, `node:*`). Thêm import ra ngoài thư mục này làm đỏ
 * storefront `client-bundle.test.ts`.
 */
export * from "./checkout.js";
export * from "./phone.js";
export * from "./text.js";
