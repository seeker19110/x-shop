# API-CONTRACT — storefront ↔ backend (P0)

> Hợp đồng dự án (đặc tả §9.1), không phải route native Medusa. Tiền: số nguyên VND. Thời gian: ISO 8601 UTC.
> Lỗi: `application/problem+json` `{ type, title, status, code, detail, field? }` — `code` ổn định, `detail` tiếng Việt.
> Mọi request store gửi header `x-publishable-api-key`. Route riêng tư (giỏ, checkout, đơn) trả `Cache-Control: private, no-store`.
> Bản OpenAPI sinh ở T-038; khi lệch, file này + test tích hợp là chuẩn.

## Catalog (T-014) — shape THẬT của backend (đã đối chiếu bằng fixture phản hồi thật ở `apps/storefront/src/lib/catalog/__fixtures__/backend/`)
Storefront ánh xạ sang kiểu nội bộ ở `lib/catalog/backend-map.ts`; backend là nguồn chuẩn.
### `GET /store/x/products` và `GET /store/x/search`
Query: `q, color, size, material, price_min, price_max, in_stock=1, sort=newest|price_asc|price_desc, page, page_size≤48, category`.
`Cache-Control: public, s-maxage=60, stale-while-revalidate=300`.
```json
{ "items": [{ "product_id": "prod_…", "handle": "that-lung-da-bo", "title": "Thắt lưng da bò", "price_min": 450000, "price_max": 450000,
   "compare_at": null, "colors": [{ "value": "den", "label": "Đen", "hex": "#1A1A1A" }],
   "thumbnail": "/static/demo/den.svg?view=front", "in_stock": true }],
  "facets": { "color": [{ "value": "den", "label": "Đen", "count": 3, "hex": "#1A1A1A" }], "size": [], "material": [] },
  "total": 24, "page": 1, "page_size": 24, "filter": "", "category": null }
```
`thumbnail` là chuỗi URL (tương đối `/static/...` chỉ có ở dev) hoặc null; `compare_at` (không phải `compare_at_max`). `/search` thêm `query` và
`suggestions: { "categories": [{ "handle", "name" }] }` (rỗng khi có kết quả). 422 `INVALID_QUERY` (`errors:[{param,reason}]`).
### `GET /store/x/products/:handle`
Object phẳng: `product_id, handle, title, description, kind, attributes{material(nhãn), composition, stretch, fit, care, origin},
category{handle,name}|null, options{colors:[{value,label,hex|null}], sizes:[{value,label}]}, variants[{variant_id, sku, color, size, price, compare_at, in_stock}],
images[{url, alt|null, color|null, width|null, height|null}], size_chart{code,name,version,unit,columns:[{key,label,basis}],rows:[{size,label,values:{key: số|[min,max]}}]}|null,
model_measurements[{image_set,color,height_cm,chest_cm,waist_cm,hip_cm,size_worn,note}], updated_at`. 404 `NOT_FOUND`.
### `GET /store/x/categories` (T-040)
`{ "categories": [{ "handle": "ao-nu", "name": "Áo nữ", "parent_handle": "nu"|null, "product_count": 5 }] }` — chỉ danh mục có sản phẩm published
trong kênh của publishable key (đếm gồm danh mục con); cùng Cache-Control catalog.
### `GET /store/x/addresses/provinces` và `/provinces/:code/wards` (T-020)
`{ "provinces": [{ "code": "01", "name": "Thành phố Hà Nội" }] }` · `{ "province_code": "01", "wards": [{ "code": "00004", "name": "Phường Ba Đình" }] }`
(404 `NOT_FOUND` khi mã tỉnh sai). `Cache-Control: public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`.

## Giỏ (Medusa native Store API, bọc ở storefront)
`POST /store/carts` (region VN, sales channel web) · `POST /store/carts/:id/line-items` · `POST /store/carts/:id/line-items/:line_id` · `DELETE …`
Cart id giữ trong cookie HttpOnly `xs_cart` ở storefront (không localStorage). Phiên bản giỏ: `GET /store/x/carts/:id/version` → `{ "cart_version": 3 }` (T-010).

## Checkout (T-010) — shape thật (fixture: `apps/storefront/src/lib/checkout/__fixtures__/`)
Lỗi: `application/problem+json` `{ type, title, status, code, detail, field?, action?, …khóa riêng }`; `field` dạng `contact.phone`, `address.ward_code`.
### `POST /store/x/checkout/quote`
Body: `{ cart_id, payment_method: "cod"|"vnpay", address: { province_code, ward_code, line }, discount_code? }`
200: `{ "quote": { id, cart_id, cart_version, payment_method, discount_code, expires_at, currency_code, lines: [{ line_item_id, variant_id, unit_price, quantity, subtotal, discount, total }],
subtotal, discount_total, shipping_fee, shipping_discount, shipping_total, total, address{…snapshot} } }`.
Lỗi: 422 `VALIDATION`(+field) · `DISCOUNT_NOT_APPLICABLE` · `CART_EMPTY` · 409 `INSUFFICIENT_STOCK` · `DISCOUNT_EXHAUSTED` · 404 giỏ không thuộc phiên.
### `POST /store/x/checkout/submit` — header `Idempotency-Key` (16–128 ký tự `[A-Za-z0-9_-]`)
Body: `{ cart_id, cart_version, quote_id, payment_method, contact: { name, phone, email? }, address: { province_code, ward_code, line } }`
- **200** (không phải 201): `{ checkout_attempt_id, state:"ready", cart_id, cart_version, payment_method, order:{ id, display_ref, state:"placed"|"awaiting_payment", total, payment_method, hold_expires_at|null, cod_confirm_by|null }, payment_url|null, error:null, status_url }`
- **202**: `{ checkout_attempt_id, state:"preparing", …, status_url }` + `Location`, `Retry-After` → poll attempts.
- **409** `PRICE_CHANGED | SHIPPING_CHANGED | DISCOUNT_CHANGED` kèm `quote` (shape như trên) · `CART_CHANGED` (+`current_cart_version`) · `QUOTE_EXPIRED` · `INSUFFICIENT_STOCK` (+`lines:[{line_item_id,variant_id,requested,available}]`) · `DISCOUNT_EXHAUSTED` · `IDEMPOTENCY_CONFLICT` · `BUSY_RETRY` (header `Retry-After`) · `ATTEMPT_ABORTED`.
- 422 `VALIDATION` · 404 giỏ không thuộc phiên.
### `GET /store/x/checkout/attempts/:id?cart_id=…`
Cùng shape view như 200 của submit (`state`: `preparing|ready|failed|compensated`, `error:{code,message}|null`).
Storefront: id giỏ luôn lấy từ cookie HttpOnly ở server (client không gửi); không dùng `GET /store/x/carts/:id/version` — `cart_version` có trong quote.

## Thanh toán (T-011)
- `GET /x/webhooks/vnpay/ipn` — chỉ VNPAY gọi; phản hồi JSON `{ RspCode, Message }`.
- Trang return storefront `/thanh-toan/ket-qua?attempt=…` KHÔNG đổi trạng thái; gọi `POST /store/x/checkout/attempts/:id/recheck` (giới hạn tần suất) → server có thể `querydr`.

## Đơn hàng sau mua (T-021)
- `GET /store/x/orders/:display_ref` — chỉ khi cookie phiên đơn hợp lệ (đặt trong lúc submit) hoặc sau khi đổi token tra cứu.
- `POST /store/x/orders/lookup` `{ display_ref, phone }` → luôn 202 "Nếu thông tin đúng, chúng tôi đã gửi liên kết…" (không lộ tồn tại) — gửi link/OTP qua outbox.
- `POST /store/x/orders/session` `{ token }` → đặt cookie phiên đơn HttpOnly, trả `{ display_ref }`; token dùng một lần, rời khỏi URL.
- Đơn trả về: `{ display_ref, state, payment_state, shipment_state, timeline: [{ at, kind, label }], lines, totals, address (đã che một phần khi phiên chưa xác thực đầy đủ) }`.
