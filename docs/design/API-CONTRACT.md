# API-CONTRACT — storefront ↔ backend (P0)

> Hợp đồng dự án (đặc tả §9.1), không phải route native Medusa. Tiền: số nguyên VND. Thời gian: ISO 8601 UTC.
> Lỗi: `application/problem+json` `{ type, title, status, code, detail, field? }` — `code` ổn định, `detail` tiếng Việt.
> Mọi request store gửi header `x-publishable-api-key`. Route riêng tư (giỏ, checkout, đơn) trả `Cache-Control: private, no-store`.
> Bản OpenAPI sinh ở T-038; khi lệch, file này + test tích hợp là chuẩn.

## Catalog (T-014)
### `GET /store/x/products`
Query: `q, color, size, material, price_min, price_max, in_stock=1, sort=newest|price_asc|price_desc, page, page_size≤48, category`
(chuẩn hóa bằng `parseFilter` của `@x-shop/domain`). `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`.
```json
{
  "items": [{ "product_id": "prod_…", "handle": "ao-so-mi-lua", "title": "Áo sơ mi lụa",
              "price_min": 700000, "price_max": 700000, "compare_at_max": null,
              "colors": [{ "value": "den", "label": "Đen", "hex": "#111111" }],
              "thumbnail": { "url": "…", "alt": "…", "width": 800, "height": 1000 }, "in_stock": true }],
  "facets": { "color": [{ "value": "den", "label": "Đen", "count": 12 }], "size": [], "material": [] },
  "total": 37, "page": 1, "page_size": 24
}
```
422 `VALIDATION` (tham số sai) · 422 `INVALID_RANGE` (price_min > price_max).

### `GET /store/x/products/:handle`
```json
{ "product_id": "prod_…", "handle": "…", "title": "…", "description": "…", "kind": "apparel",
  "attributes": { "material": "Lụa", "composition": "100% lụa tơ tằm", "stretch": null, "fit": "Suông", "care": "Giặt tay", "origin": "Việt Nam" },
  "category": { "handle": "ao", "name": "Áo" },
  "options": { "color": [{ "value": "den", "label": "Đen", "hex": "#111111" }], "size": [{ "value": "m", "label": "M" }] },
  "variants": [{ "variant_id": "variant_…", "sku": "SM-DEN-M", "color": "den", "size": "m", "price": 700000, "compare_at": null, "in_stock": true }],
  "images": [{ "url": "…", "alt": "Mặt trước áo màu đen", "color": "den", "width": 1600, "height": 2000 }],
  "size_chart": { "version": 2, "unit": "cm", "columns": ["Size", "Ngực", "Dài áo"], "rows": [["M", "92", "68"]] },
  "model_measurements": [{ "image_set": "den", "height_cm": 168, "bust_cm": 82, "wearing_size": "S" }],
  "updated_at": "2026-10-24T09:00:00Z" }
```
404 `NOT_FOUND` (không có hoặc chưa publish).

### `GET /store/x/search?q=`
Như `/store/x/products` + `suggestions: [{ "type": "category", "handle": "…", "name": "…" }]` khi không có kết quả.

## Giỏ (Medusa native Store API, bọc ở storefront)
`POST /store/carts` (region VN, sales channel web) · `POST /store/carts/:id/line-items` · `POST /store/carts/:id/line-items/:line_id` · `DELETE …`
Cart id giữ trong cookie HttpOnly `xs_cart` ở storefront (không localStorage). Phiên bản giỏ: `GET /store/x/carts/:id/version` → `{ "cart_version": 3 }` (T-010).

## Checkout (T-010)
### `POST /store/x/checkout/quote`
Body: `{ cart_id, payment_method: "cod"|"vnpay", address: { province_code, ward_code, line }, discount_code? }`
200: `{ quote_id, expires_at, cart_version, breakdown: { lines: [{ line_id, variant_id, title, sku, unit_price, quantity, line_subtotal, allocated_discount, line_total }], subtotal, order_discount_total, order_discount_code, shipping_fee, shipping_discount_total, shipping_total, total } }`
Lỗi: 422 `VALIDATION`(+field) · 422 `DISCOUNT_NOT_APPLICABLE` · 409 `INSUFFICIENT_STOCK` · 422 `ADDRESS_NOT_SERVED`.

### `POST /store/x/checkout/submit` — header `Idempotency-Key` (16–128 ký tự `[A-Za-z0-9_-]`)
Body: `{ cart_id, cart_version, quote_id, payment_method, contact: { name, phone, email? }, address: { province_code, ward_code, line } }`
- 201: `{ checkout_attempt_id, order: { id, display_ref, state: "placed"|"awaiting_payment", total, hold_expires_at? }, payment_url? }`
- 202: `{ checkout_attempt_id, state: "preparing" }` → poll status.
- 409: `CART_CHANGED | PRICE_CHANGED | SHIPPING_CHANGED | DISCOUNT_CHANGED` kèm `quote` mới (khách xác nhận lại) · `QUOTE_EXPIRED` · `INSUFFICIENT_STOCK` (+`lines`) · `DISCOUNT_EXHAUSTED` · `IDEMPOTENCY_CONFLICT` · `BUSY_RETRY` (+`retry_after_ms`).
- 404 giỏ không thuộc phiên.

### `GET /store/x/checkout/attempts/:id`
`{ checkout_attempt_id, state, order: { id, display_ref, state, payment_state, total, hold_expires_at }|null, payment_url? }`

## Thanh toán (T-011)
- `GET /x/webhooks/vnpay/ipn` — chỉ VNPAY gọi; phản hồi JSON `{ RspCode, Message }`.
- Trang return storefront `/thanh-toan/ket-qua?attempt=…` KHÔNG đổi trạng thái; gọi `POST /store/x/checkout/attempts/:id/recheck` (giới hạn tần suất) → server có thể `querydr`.

## Đơn hàng sau mua (T-021)
- `GET /store/x/orders/:display_ref` — chỉ khi cookie phiên đơn hợp lệ (đặt trong lúc submit) hoặc sau khi đổi token tra cứu.
- `POST /store/x/orders/lookup` `{ display_ref, phone }` → luôn 202 "Nếu thông tin đúng, chúng tôi đã gửi liên kết…" (không lộ tồn tại) — gửi link/OTP qua outbox.
- `POST /store/x/orders/session` `{ token }` → đặt cookie phiên đơn HttpOnly, trả `{ display_ref }`; token dùng một lần, rời khỏi URL.
- Đơn trả về: `{ display_ref, state, payment_state, shipment_state, timeline: [{ at, kind, label }], lines, totals, address (đã che một phần khi phiên chưa xác thực đầy đủ) }`.
