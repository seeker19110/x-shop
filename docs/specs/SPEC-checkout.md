# SPEC-checkout — Giỏ, báo giá, đơn chờ thanh toán, giữ hàng

| Trường | Giá trị |
|---|---|
| ID tính năng | F-005, F-006 (yêu cầu gốc: CHK01–06, PRICE01–04, INV02–03, DATA01–06, §6.2, §9.1) |
| Trạng thái | Approved for implementation (D-001) |
| approved_by | Phiên chính, tự duyệt theo AGENTS.md §5 (D-001) |
| approved_at | 2026-10-24 |
| Nguồn | `docs/specs/DAC-TA-GOC.md` §4.4, §5.2–5.3, §6.1–6.2, §8, §9.1 — file này chỉ bổ sung tiêu chí kiểm được và quyết định lấp chỗ hở |

## 1. User story
Là khách (không cần tài khoản), tôi muốn xem đúng tổng tiền do server tính rồi đặt hàng một lần duy nhất dù bấm nhiều
lần, để không bị thu thêm ngầm và không mất hàng đã giữ.

## 2. Tiêu chí chấp nhận
### S-001 Báo giá do server tính (CHK04, PRICE01)
- Given giỏ có 2 dòng (đen-M 700.000đ ×1, trắng-S 300.000đ ×2), mã giảm 10% cấp đơn, phí ship GHN báo 30.000đ
- When `POST /store/x/checkout/quote`
- Then trả `quote_id`, `expires_at`, `cart_version`, breakdown số nguyên VND: `subtotal=1300000`, `discount=130000`
  phân bổ theo dòng (tổng phân bổ = 130000 đúng tuyệt đối), `shipping=30000`, `total=1200000`.

### S-002 Giá/phí đổi → xác nhận lại (AT03)
- Given quote Q1 total 1.200.000đ; giá đen-M đổi thành 750.000đ
- When submit với `quote_id=Q1`
- Then `409 PRICE_CHANGED` kèm quote mới; không tạo đơn, không giữ hàng; khách phải xác nhận tổng mới.

### S-003 Idempotency (AT05, DATA01–02)
- Given cùng `Idempotency-Key` K và cùng payload
- When submit 2 lần tuần tự, hoặc 10 lần song song, hoặc từ 2 tab cùng cart_version
- Then đúng 1 đơn, 1 bộ reservation; mọi response cùng `checkout_attempt_id`/`order_id`.
- And cùng K khác payload → `409 IDEMPOTENCY_CONFLICT`; khác K cùng cart_version đã tiêu thụ → trả lại attempt hiện có (không tạo đơn thứ hai).

### S-004 Tranh món cuối (AT04)
- Given SKU X còn `stocked=1, reserved=0`
- When 50 giỏ khác nhau submit đồng thời
- Then đúng 1 submit thành công; 49 nhận `409 INSUFFICIENT_STOCK` dạng hiểu được; `reserved_quantity=1`, không âm.

### S-005 Hết hạn giữ hàng (INV02, §6.2 bước 8)
- Given đơn online `awaiting_payment`, `hold_expires_at` đã qua, provider query trả "chưa trả"
- When job expiry chạy (kể cả chạy 2 lần song song)
- Then đơn `cancelled`, reservation được nhả đúng 1 lần, quota mã giảm hoàn lại 1 lần.
- And nếu provider trả `unknown` → không hủy; đánh dấu ngoại lệ có hạn xử lý.

### S-006 Expiry đồng thời callback paid (AT12)
- Given đơn sắp hết hạn
- When IPN paid và job expiry tới cùng lúc
- Then theo khóa đơn chỉ một nhánh thắng: hoặc `confirmed` (paid trước), hoặc `cancelled` + khoản thu đến sau thành ngoại lệ hoàn (AT09). Ledger luôn có khoản thu.

### S-007 Worker chết giữa chừng (AT10)
- Given attempt đã tạo reservation cho 1/2 dòng rồi tiến trình chết
- When job đối chiếu chạy
- Then attempt `preparing` quá hạn được bù trừ: nhả reservation đã tạo, quota mã giảm hoàn lại, đơn không xuất kho.

### S-008 Quota mã giảm cuối (AT33)
- Given mã giảm còn 1 lượt
- When 20 checkout đồng thời dùng mã
- Then đúng 1 dùng được; đơn đó hủy → quota hoàn đúng 1 lần.

### S-009 COD (§6.3)
- Given payment_method=cod
- When submit
- Then đơn `placed` + reservation; hạn xác nhận COD riêng (mặc định 24 giờ, D-004), không dùng TTL online.

### S-010 Giỏ (CHK01)
- Given giỏ 3 dòng, một dòng SKU vừa bị ẩn
- When xem giỏ
- Then 2 dòng còn lại nguyên; dòng lỗi có giải thích và không chặn xóa; không cho checkout tới khi xử lý.

## 3. Ca biên
| Nhóm | Ca | Hành vi | Scenario |
|---|---|---|---|
| Rỗng/null | giỏ rỗng; quantity 0; thiếu SĐT | 422 `CART_EMPTY` / `VALIDATION` kèm trường | S-010 |
| Cực đại | quantity > 99/dòng; > 50 dòng | 422 `LIMIT` | — |
| Trùng/idempotency | double click, retry, 2 tab | S-003 | S-003 |
| Song song | 50 checkout món cuối; quota mã | S-004, S-008 | |
| Mất mạng | timeout sau submit | 202 + `GET status`; không tạo đơn mới | S-003 |
| Thời gian | hạn giữ/khuyến mãi tính UTC; biên đúng giây hết hạn = hết hạn | `now >= expires_at` là hết | S-005 |
| Quyền | khách A dùng cart_id của B | 404 (không lộ tồn tại) | — |
| Tiền | VND số nguyên; giảm > subtotal | giảm bị kẹp ≤ subtotal; không tổng âm | S-001 |

## 4. Quyết định lấp chỗ hở
- Idempotency key: phạm vi (session/cart, `checkout.submit`), lưu `sha256(payload chuẩn hóa)`; giữ 24 giờ (D-002).
- Khóa: Locking Module của Medusa theo key `inventory_item:<id>` sắp tăng dần + khóa `cart:<id>`; ràng buộc UNIQUE
  `(cart_id, cart_version)` trên checkout attempt là lớp đỡ cuối (D-002).
- Làm tròn phân bổ giảm giá: largest remainder theo giá trị dòng, hòa thì theo thứ tự dòng (D-002).
- Làm tròn tiền (XC-UNITS-006): VND là số nguyên, không số lẻ; mọi phép chia ra số lẻ có mode ghi tại đây (D-002).
  - Giảm theo phần trăm (`percentOfVnd`, `packages/domain/src/money/money.ts`): tính bằng phép nguyên trên basis point (1% = 100 bp), làm tròn XUỐNG tới đồng (ROUND_DOWN = floor) — mức giảm "10%" không bao giờ vượt 10%. Ví dụ: 10% của 99.999 đ = 9.999 đ; 10% của 1.300.000 đ = 130.000 đ.
  - Giá trị phần trăm của mã giảm đọc từ Medusa (`quote.ts`) đổi sang basis point; nếu không khớp đúng một basis point (sai số > 1e-9) hoặc > 100% thì mã không áp dụng — không làm tròn lặng lẽ.
  - Phân bổ giảm giá theo dòng: largest remainder (đã nêu trên); tổng phân bổ = tổng giảm tuyệt đối.
  - Phí ship theo bậc khối lượng (`apps/backend/src/lib/checkout/shipping.ts`): số bậc làm tròn LÊN (ceil); khối lượng một dòng không số nguyên gram làm tròn lên.
  - Thuế/hóa đơn: hiện chưa tính thuế (đặc tả gốc §7.4: cấu hình theo mô hình kinh doanh, không hardcode). Khi thêm, phải ghi mode làm tròn (HALF_UP hay HALF_EVEN theo nghiệp vụ) vào spec này và ADR trước khi code.
  - Kiểm: `pnpm --filter @x-shop/domain exec vitest run src/money` (ca `percentOfVnd` làm tròn xuống, biên 0 và 10.000 bp, thuộc tính tổng phân bổ).

## 5. Câu hỏi mở — khuyến mãi (IND-ECOM-004, T-122)
Hành vi ĐANG CÓ (đã có test): tối đa MỘT mã cấp đơn (% có trần / tiền cố định, điều kiện đơn tối thiểu) + tối đa MỘT ưu đãi ship, cộng được; giảm đơn tính trên subtotal rồi kẹp ≤ subtotal; tổng ≥ 0; quota TỔNG lượt dùng mã (S-008). Kiểm: `pnpm --filter @x-shop/domain test -- quote coupon`. Chưa có trong đặc tả/code — chưa tự thêm, cần phiên chính quyết (`loop decide`):
- **Q-PROMO-1 Giới hạn lượt dùng/người.** Khách vãng lai không có định danh. (a) Khoá theo số điện thoại chuẩn hóa đã xác minh + email: đơn giản nhưng dễ né bằng số khác; (b) bỏ giới hạn/người, chỉ giữ quota tổng + giới hạn tốc độ: rẻ, chấp nhận rủi ro lạm dụng; (c) chỉ áp giới hạn/người cho mã dành cho tài khoản (cần tài khoản — ngoài phạm vi "mua không cần tài khoản").
- **Q-PROMO-2 Ngân sách khuyến mãi (tổng tiền giảm tối đa/mã hoặc chiến dịch).** (a) Cộng dồn `orderDiscountTotal` các đơn đã tính ở bảng sử dụng mã, chặn khi chạm trần (cần khóa như quota, hoàn khi huỷ); (b) dùng ngân sách của Medusa Campaign nếu bản đang dùng hỗ trợ (chưa xác minh); (c) không có ngân sách, chỉ quota lượt.
- **Q-PROMO-3 Chồng nhiều mã cấp đơn — ĐÃ CHỐT (D-061):** giữ một mã cấp đơn (PRICE02); thêm cờ `stackable` khi chủ sản phẩm yêu cầu.
- **Q-PROMO-4 Snapshot khuyến mãi trong đơn — ĐÃ CHỐT (D-061), đã có (T-134):** breakdown lưu `orderPromotion`/`shippingPromotion` (id khuyến mãi, mã, phạm vi, loại, giá trị, điều kiện đơn tối thiểu/trần giảm, số thực giảm) tại lúc đặt; đơn và đối soát đọc ảnh chụp trong `order_finance.quote`, mã bị sửa/tắt/xoá sau khi đặt không đổi đơn. `diffQuotes` vẫn chỉ so mã + số giảm; mã hết hạn giữa quote và submit → 422 `DISCOUNT_NOT_APPLICABLE` (D-109). Kiểm: `pnpm --filter @x-shop/domain test -- promotion-snapshot` · `pnpm --filter @x-shop/backend test:integration -- checkout-submit`.
