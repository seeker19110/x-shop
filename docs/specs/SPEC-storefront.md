# SPEC-storefront — Giao diện, 6 màn hình cốt lõi, SEO, PWA

| Trường | Giá trị |
|---|---|
| ID tính năng | F-002, F-011 (yêu cầu gốc: §3, WEB01–02, PDP01–05, CHK05–06, A11Y01–03, §12, §13.1) |
| Trạng thái | Approved for implementation (D-001) |
| Thiết kế | `DESIGN.md` (token từ đặc tả §3.1) |

## 6 màn hình cốt lõi
`/` trang chủ · `/danh-muc/[slug]` (+ `/tim-kiem`) · `/san-pham/[slug]` · `/gio-hang` · `/thanh-toan` · `/don-hang/[ref]`.

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
