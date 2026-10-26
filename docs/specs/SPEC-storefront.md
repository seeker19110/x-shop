# SPEC-storefront — Giao diện, 6 màn hình cốt lõi, SEO, PWA

| Trường | Giá trị |
|---|---|
| ID tính năng | F-002, F-011 (yêu cầu gốc: §3, WEB01–02, PDP01–05, CHK05–06, A11Y01–03, §12, §13.1) |
| Trạng thái | Approved for implementation (D-001) |
| approved_by | Phiên chính, tự duyệt theo AGENTS.md §5 (D-001) |
| approved_at | 2026-10-24 |
| Thiết kế | `DESIGN.md` (token từ đặc tả §3.1) |

## 6 màn hình cốt lõi
`/` trang chủ · `/danh-muc/[slug]` (+ `/tim-kiem`) · `/san-pham/[slug]` · `/gio-hang` · `/thanh-toan` · `/don-hang/[ref]`.

## Ca biên
| Nhóm | Ca | Hành vi | Scenario |
|---|---|---|---|
| Rỗng/null | danh mục/tìm kiếm không có kết quả; giỏ rỗng | trang rỗng có đường về trang 1 / thông báo giỏ rỗng; không cho đặt đơn (422 `CART_EMPTY` ở SPEC-checkout) | S-504 |
| Cực đại | `page_size` > 48; quantity > 99/dòng | kẹp 48 (SPEC-catalog); 422 `LIMIT` (SPEC-checkout) | S-504 |
| Trùng/idempotency | bấm đặt hàng nhiều lần, hai tab | cùng `Idempotency-Key` → một đơn (SPEC-checkout S-003); `purchase` dedupe theo `order_id` | S-504, S-508 |
| Song song | hai tab cùng giỏ; sửa giỏ khi giá đổi | thao tác trang được dựng lại từ server, client không tự cộng tiền; giá đổi → xác nhận lại (SPEC-checkout S-002) | S-504 |
| Mất mạng giữa chừng | offline khi điều hướng; mất mạng sau khi gửi đơn | trang công khai đã lưu hoặc `/offline`; service worker không phát lại request ghi; `202` + `GET status`, không tạo đơn mới | S-507, S-505 |
| Thời gian/múi giờ | dữ liệu cache cũ; đơn hết hạn giữ hàng | giá/tồn trang công khai cũ tối đa ~60 s (ADR-0003), giá cuối luôn tính lại ở server; mốc hết hạn tính UTC, `now >= expires_at` là hết | S-505 |
| Quyền | tra cứu đơn bằng mã đơn + SĐT; link tra cứu sai/hết hạn | không trả dữ liệu đơn, chỉ gửi liên kết một lần 15 phút tới SĐT/email đã dùng, luôn `202` cùng thông điệp; trang xác thực không gửi Referer; sai → 404 đồng nhất (`docs/ops/DPIA.md`, `order-lookup.spec.ts`) | S-505 |
| Tiền/đơn vị/Unicode | VND số nguyên; tên có dấu NFD/NFC, chữ `đ` | hiển thị `format-vnd` không số lẻ; chuỗi người dùng nhập chuẩn hóa NFC ở server | S-504, S-506 |

## Tiêu chí chấp nhận
### S-501 Chọn size (PDP03, AT02)
- Given PDP đang chọn đen-M; màu trắng không có M
- When chọn trắng
- Then size bị bỏ chọn, thông báo "Màu Trắng không có size M — vui lòng chọn lại size" (aria-live polite); CTA "Chọn size".

### S-502 Nút size
- Then size là `button` có `aria-pressed`; hết hàng có chữ "hết hàng" (không chỉ màu), vẫn focus được nhưng không thêm giỏ.

### S-503 Sticky CTA mobile
- Then chỉ hiện khi khối mua chính ra khỏi viewport (IntersectionObserver); có `env(safe-area-inset-bottom)`; ẩn khi input có focus.

### S-504 Checkout một trang (CHK05–06)
- Then 3 nhóm (liên hệ, giao hàng, thanh toán), nhãn thật, `autocomplete`, `inputmode=tel`, lỗi gắn trường (`aria-describedby`); không lưu địa chỉ vào localStorage; trang kết quả tách "đặt đơn" / "thanh toán" / "giao hàng".

### S-505 Không cache riêng tư (AT22)
- Then `/gio-hang`, `/thanh-toan`, `/don-hang/*`, API cart/checkout/order trả `Cache-Control: private, no-store`; service worker không cache các đường này.

### S-506 SEO (AT26)
- Then PDP có HTML server-render, canonical về `/san-pham/[slug]`, JSON-LD `ProductGroup` + `hasVariant` `Product` + `Offer` khớp giá/tồn UI; `?color=&size=` mở đúng biến thể; sitemap chỉ sản phẩm/danh mục publish; URL lọc tùy ý `noindex,follow`.

### S-507 PWA
- Then manifest, icon, trang `/offline`; offline không cho đặt hàng/thanh toán, nhãn "dữ liệu có thể đã cũ".

### S-508 Telemetry (AT29)
- Then sự kiện §13.1 không chứa PII (test quét payload); `purchase` dedupe theo order_id.

### S-509 Tiếp cận (AT25)
- Then axe không lỗi serious/critical trên 6 màn; điều hướng bàn phím trọn luồng mua; focus không bị sticky che; tương phản token đạt AA.
