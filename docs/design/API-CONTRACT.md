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

## Đơn hàng sau mua (T-021) — shape thật (test: `apps/backend/integration-tests/http/order-lookup.spec.ts`)
Mọi route: `Cache-Control: private, no-store`. Quyền xem/thao tác đơn = header `x-order-access: <token phiên đơn>` (storefront đọc từ
cookie HttpOnly `xs_order_<mã đơn>` ở server; token KHÔNG bao giờ nằm trên URL). Token thiếu/sai/hết hạn/của đơn khác → 404
`NOT_FOUND` giống hệt mã không tồn tại (AT20). Token: HMAC (`signLookupToken`, khóa dẫn xuất theo loại từ `ORDER_LOOKUP_SECRET`) —
`access` 7 ngày dùng lại được; `link` 15 phút, đổi một lần.
- `POST /store/x/checkout/submit` (200) và `GET /store/x/checkout/attempts/:id` (khi `state:"ready"`) trả thêm
  `order_access`, `order_access_expires_at` để storefront đặt cookie.
- `GET /store/x/orders/:display_ref` → 200
  `{ display_ref, state, payment_method, payment_state: cod|pending|unknown|paid|refund_pending|expired|void,
  shipment_state: unfulfilled|picking|packed|shipped|delivered, created_at, hold_expires_at|null, cod_confirm_by|null,
  cancel_reason|null, timeline: [{ at, kind, label }], lines: [{ title, variant_title, quantity, unit_price, total, thumbnail }],
  totals: { subtotal, discount_total, shipping_total, total, paid }, address: { province_name, ward_name, line },
  contact: { name, phone (đã che: 0912***678) }, actions: { can_cancel, can_recheck } }` — không trả email/id nội bộ.
- `POST /store/x/orders/:display_ref/recheck` → cùng shape + `payment_check` (`paid|not_paid|failed|unknown|skipped`); server
  querydr CÙNG giao dịch, không đổi trạng thái theo tham số trình duyệt; 1 lần/10 giây mỗi lần đặt (429 `RATE_LIMITED`).
- `POST /store/x/orders/:display_ref/cancel` → cùng shape + `cancel: { outcome: cancelled|already_cancelled, refund_requested }`
  (idempotent). 409 `NOT_CANCELLABLE` (đã có vận đơn / trạng thái kết thúc) · 409 `PAYMENT_PENDING` (cổng chưa trả lời rõ).
  Đơn đã thu tiền → ngoại lệ `refund_request`; hủy native + hoàn thật ở T-027.
- `POST /store/x/orders/lookup` `{ display_ref, phone }` → luôn 202 `{ accepted: true, message }` cùng thông điệp; khớp → outbox
  `order.lookup_link` `{ order_id, display_ref, token, expires_at }` (gửi thật ở T-029, URL `/tra-cuu-don/xac-thuc?token=…`).
  422 `VALIDATION` (`field`: `display_ref|phone`) khi sai định dạng · 429 khi vượt 5/giờ/SĐT, 10/giờ/mã, 20/giờ/IP.
- `POST /store/x/orders/session` `{ token }` → 200 `{ display_ref, order_access, order_access_expires_at }`; token hết hạn/giả/đã
  dùng → 404. Storefront đổi bằng Server Action (khách bấm nút, không tự đổi khi GET) rồi chuyển tới `/don-hang/:ref`.
- Giới hạn tần suất dùng chung ở Postgres (`rate_limit_counter`): (IP, mã) 60/10 phút cho xem/kiểm tra lại, 10/10 phút cho hủy;
  20 lần bị từ chối/10 phút mỗi IP → 429.
