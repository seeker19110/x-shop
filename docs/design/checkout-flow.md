# Thiết kế — Checkout, đơn chờ thanh toán, giữ hàng, IPN (Lát 3)

> Nguồn: `docs/specs/SPEC-checkout.md`, `docs/specs/SPEC-payment.md`, đặc tả gốc §6.2, §8, §9; ADR-0001; D-002…D-005.
> Lõi thuần (tính tiền, máy trạng thái, ledger, protocol VNPAY) đã có ở `packages/domain` — backend chỉ điều phối I/O.

## 1. Ranh giới
| Việc | Ai sở hữu |
|---|---|
| Giỏ, line item, giá hiện hành, khuyến mãi gốc, order, reservation, inventory level, payment collection | Medusa native (module + workflow chính thức) |
| Checkout attempt, idempotency, payment attempt, ledger tiền, webhook inbox, outbox, ngoại lệ vận hành | Module tùy biến `checkout` (`apps/backend/src/modules/checkout`) — bảng riêng, link tới entity native bằng module link |
| Tính quote, so quote, quyết định sau khoản thu, chuyển trạng thái | `@x-shop/domain` (`computeQuote`, `diffQuotes`, `decideOnCapture`, `orderMachine`, `paymentMachine`, `checkRefundAllowed`) |
| Ký/xác minh VNPAY | `@x-shop/domain` `vnpay.*` (adapter backend chỉ gọi HTTP) |

Không dùng `completeCartWorkflow` cho checkout (nó tự giữ hàng + tạo đơn; webhook payment native lại gọi nó — AT35).
Không đăng ký VNPAY làm payment provider có webhook native; IPN đi route riêng `GET /x/webhooks/vnpay/ipn`.

## 2. Dữ liệu (module `checkout`, Postgres)
| Bảng | Cột chính | Ràng buộc |
|---|---|---|
| `checkout_attempt` | id, cart_id, cart_version, idempotency_scope, idempotency_key, payload_hash, state (`preparing`/`ready`/`failed`/`compensated`), order_id null, quote (jsonb breakdown), payment_method (`cod`/`vnpay`), hold_expires_at, error_code, lease_until | UNIQUE(idempotency_scope, idempotency_key); UNIQUE(cart_id, cart_version) — một checkout cho một phiên bản giỏ (DATA02) |
| `cart_version` | cart_id PK, version int, frozen_by_attempt null | tăng mỗi lần sửa giỏ; bị đóng băng khi attempt `preparing`/`ready` |
| `order_finance` | order_id PK, display_ref (XS-xxxxxx), state (domain `OrderState`), total, payment_method, hold_expires_at, cod_confirm_by, policy_version, quote snapshot, address snapshot, version (optimistic) | CHECK total ≥ 0 |
| `payment_attempt` | id, order_id, provider, txn_ref UNIQUE, amount, state (domain `PaymentState`), payment_url, expires_at, provider_txn_no null | 1 attempt `pending`/`created`/`unknown` hoạt động mỗi đơn: partial UNIQUE(order_id) WHERE state IN (...) |
| `payment_ledger` | id, order_id, kind (`capture`/`refund`), amount > 0, provider, provider_txn_id, refund_id null, state, created_at | UNIQUE(provider, provider_txn_id, kind) — chống ghi trùng khoản thu (AT06) |
| `webhook_inbox` | id, provider, event_key UNIQUE(provider,event_key), payload (đã lọc PII), payload_hash, verified bool, result, processed_at | lưu trước khi xử lý |
| `outbox_event` | id, event_key UNIQUE, aggregate_id, type, payload, state, attempts, next_attempt_at | gửi email/SMS/subscriber sau commit (DATA06) |
| `ops_exception` | id, kind (`late_payment`/`overpayment`/`payment_unknown`/`refund_unknown`/`webhook_rejected`/`checkout_stuck`), order_id, amount, state, owner, priority, due_at | dashboard ngoại lệ (§5.5) |
| `coupon_usage` | promotion_code, order_id, state (`held`/`used`/`released`) | UNIQUE(promotion_code, order_id); đếm `held+used` ≤ quota dưới khóa (AT33) |

Tiền: cột `bigint`/`numeric(20,0)` nguyên VND. Thời gian: `timestamptz` UTC.

## 3. Submit (S-003, S-004, S-009) — `submitCheckoutWorkflow`
```
POST /store/x/checkout/submit   Idempotency-Key: <uuid>
{ cart_id, cart_version, quote_id, payment_method, contact, address }
```
1. Xác thực quyền sở hữu giỏ (cart thuộc phiên/publishable key; không nhận customer_id từ client). Validate contact/address bằng domain (`normalizeVnPhone`, `validateAddress`).
2. **Idempotency**: tìm `checkout_attempt` theo (scope=`cart:<id>`, key). Có → cùng `payload_hash` thì trả kết quả hiện có (200/202), khác → `409 IDEMPOTENCY_CONFLICT`. Có attempt cho (cart_id, cart_version) với key khác → trả attempt đó (DATA02).
3. INSERT attempt `preparing` (lease_until = now + 2 phút). Va UNIQUE → quay lại bước 2 (đua giữa 2 request cùng key).
4. Khóa: `acquireLockStep` (Locking Module, provider Redis) theo `cart:<id>` + từng `inventory_item:<id>` **sắp tăng dần** (tránh deadlock), timeout ngắn → `409 BUSY_RETRY` có retry guidance. Hạ tầng khóa hỏng (lỗi kết nối Redis, lệnh khóa không trả lời > 3 s) → `503 LOCK_UNAVAILABLE` + `Retry-After`, dừng trước khi đọc tồn/giữ hàng, không khóa in-memory thay thế (đặc tả §13.2, T-042); attempt `failed` lỗi tạm → retry cùng key.
5. Đọc lại giỏ + giá hiện hành + promotion + phí ship → `computeQuote` (phí ship: dùng báo phí lưu trong `checkout_quote.shipping` khi quote còn hạn và đầu vào định phí — tỉnh/phường, khối lượng, giá trị khai, dịch vụ, phương thức thanh toán — không đổi, `reusableShippingFee`; ngược lại hỏi lại GHN — T-153, không phụ thuộc bộ nhớ tiến trình); so với quote khách đã xác nhận (`diffQuotes`) → khác → attempt `failed` + `409 PRICE_CHANGED|CART_CHANGED|SHIPPING_CHANGED|DISCOUNT_CHANGED` kèm quote mới.
6. Kiểm tồn khả dụng (stocked − reserved) của mỗi inventory item tại location bán; thiếu → `409 INSUFFICIENT_STOCK` (dòng nào).
7. Coupon: đếm `coupon_usage` held+used dưới khóa `promotion:<code>`; hết → `409 DISCOUNT_EXHAUSTED`; còn → INSERT `held`.
8. Tạo order native (`createOrderWorkflow`) với snapshot giá/địa chỉ/quote → `createReservationsWorkflow` với `line_item_id` từng dòng (đúng một bộ). Ghi `order_finance` state `preparing`.
9. Chuyển: COD → `placed` (cod_confirm_by = now + 24h, D-002); online → `awaiting_payment` (hold_expires_at = now + 15 phút, D-002). Attempt `ready`, order_id. Cart version đóng băng.
10. Online: tạo `payment_attempt` (txn_ref = `PA_<ulid>`), `buildPaymentUrl` với `vnp_ExpireDate = hold_expires_at`. Trả `payment_url`.
11. Nhả khóa. Outbox `order.placed_pending` (thông báo chỉ gửi sau finalization — AT34).

Lỗi ở bước 8–10 → bước bù trừ của workflow: xóa reservation đã tạo, hủy order native, `coupon_usage` → `released`, attempt `failed`. Tiến trình chết → job reconcile (mục 6). Bù trừ không xong (còn đơn native/reservation `checkout <attempt_id>` sau khi workflow trả lỗi — vd Redis mất nên không xoá được reservation) → attempt giữ `preparing`, không mở lại cho retry; job reconcile dọn sau lease. Nhả khóa ở bù trừ/bước 11 không ném (khóa tự hết hạn theo TTL).

## 4. IPN VNPAY (S-101…S-106, AT06–AT09, AT35, AT36) — route `GET /x/webhooks/vnpay/ipn`
1. `verifyNotification` → sai chữ ký → inbox (verified=false) + `ops_exception webhook_rejected` + `{"RspCode":"97"}`.
2. Inbox: event_key = `txn_ref|transactionNo|responseCode|transactionStatus`; đã xử lý → trả lại kết quả cũ (lặp 20 lần → 1 bút toán).
3. Tìm payment_attempt theo txn_ref → không có → `01`. Số tiền ≠ attempt.amount → `04` + exception.
4. Khóa `order:<id>`. Không thành công → attempt `failed` (nếu chuyển hợp lệ), `00`.
5. Thành công: INSERT ledger capture (UNIQUE provider_txn_id) — va → đã ghi → `02`. Rồi `decideOnCapture(order.state, total, ledgerAfter, amount)`:
   - `confirm_order` → order_finance `confirmed`, payment collection native đánh dấu đã thu (API module payment, không qua webhook native), outbox `order.confirmed`; `overpaid > 0` → exception `overpayment`.
   - `exception late_payment` (đơn đã hủy) → exception, KHÔNG phục hồi đơn/giao hàng (AT09).
   - `exception overpayment` (đơn đã xác nhận, giao dịch thật thứ hai) → exception, không xác nhận lại (AT36).
   - `record_only` (thu thiếu) → exception `payment_unknown` để CSKH xử lý.
6. Trả `00` (hoặc `02` khi đơn đã xác nhận trước đó bởi đúng giao dịch này).
Chứng minh AT35: test gọi IPN thật qua HTTP, kiểm `order_id`, số order, số reservation trước/sau bằng nhau; cart không bị `completed_at` bởi Medusa.

## 5. Return URL & status (S-104, AT08, AT24)
`GET /x/checkout/attempts/:id/status` (chỉ phiên sở hữu): trả state đơn + thanh toán. Trang return KHÔNG đổi trạng thái tiền; nút "Kiểm tra lại" → server có thể `querydr` (giới hạn tần suất) rồi đi cùng đường xử lý như IPN (ghi inbox với nguồn `query`).

## 6. Job (worker)
| Job | Chu kỳ | Việc |
|---|---|---|
| `expire-holds` | 1 phút | Đơn `awaiting_payment` quá `hold_expires_at`: khóa đơn → `querydr`; `paid` → xử lý như IPN; `not_paid`/`failed` sau hạn → hủy đơn native, xóa reservation, coupon `released`, attempt `failed` (đúng một lần — kiểm state dưới khóa); `unknown` → giữ, exception `payment_unknown` (due 30 phút) |
| `reconcile-attempts` | 1 phút | Attempt `preparing` quá `lease_until` → bù trừ (xóa reservation theo line_item, hủy order native nếu có, coupon released) → `compensated` (AT10) |
| `cod-confirm-timeout` | 15 phút | Đơn COD quá `cod_confirm_by` chưa xác nhận → exception cho nhân viên đơn (không tự hủy) |
| `outbox-dispatch` | 10 giây | Gửi sự kiện/notification có message key, retry lũy thừa có jitter, tối đa N lần; payload sai schema/lỗi vĩnh viễn → dead ngay (T-093) → exception |

## 7. Test bắt buộc (Gate)
- `checkout-module`: ràng buộc UNIQUE/CHECK bị DB từ chối khi chèn trực tiếp.
- `checkout-submit`: AT03 (giá đổi), AT04 (50 submit song song, 1 thành công, reserved=1), AT05 (cùng key ×10 song song, 2 tab), AT33 (20 checkout tranh coupon còn 1), COD.
- `payment-ipn`: AT06 (×20), AT07 (chữ ký/số tiền), AT08 (return không đổi trạng thái), AT35 (order_id/reservation không đổi, cart không bị complete), AT36 (hai giao dịch thật).
- `checkout-expiry`: AT09, AT10 (giết giữa chừng: attempt preparing có 1/2 reservation), AT11 (timeout → unknown → query), AT12 (expiry ∥ IPN chạy song song, lặp 20 lần ngẫu nhiên thứ tự: ledger luôn có tiền, đơn đúng một kết cục).
