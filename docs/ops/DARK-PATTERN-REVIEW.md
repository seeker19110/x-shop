# Biên bản rà dark pattern — x-shop · 2026-10-26

> Phạm vi: UX-CONTENT-005 (không dark pattern), UX-CONTENT-006 (giá/chi phí hiện đủ trước bước xác nhận). Căn cứ:
> Luật 19/2023/QH15 Đ.10; DSA Art. 25; FTC "Bringing Dark Patterns to Light" (09/2022). Rà bằng đọc mã nguồn thật
> (`apps/storefront/src`) + E2E tự động `e2e/checkout-total.spec.ts`. Chưa rà trên bản chạy thật với người dùng thật.

## Danh mục kiểm (áp cho từng màn)
1. Tuỳ chọn bất lợi bật sẵn (đăng ký nhận tin, chia sẻ dữ liệu, bảo hiểm/quà tặng thêm tiền).
2. Confirmshaming (nút từ chối viết để làm khách thấy có lỗi).
3. Đếm ngược / khan hiếm giả; thông báo "người khác đang xem".
4. Phí ẩn, cộng thêm khoản ở bước cuối, giá khác giữa các bước.
5. Hủy khó hơn mua; hỏi lại liên tục sau khi đã từ chối; che nút từ chối/hủy.
6. Ép tạo tài khoản; cản trở mua một lần.

## Màn 1 — Giỏ hàng (`components/cart/CartContents.tsx`, `/gio-hang`)
| Mục | Kết quả | Bằng chứng |
|---|---|---|
| 1 | Đạt: không có ô chọn/tùy chọn nào ngoài số lượng, màu, size | `grep -rn "checkbox\|defaultChecked" apps/storefront/src` chỉ thấy bộ lọc danh mục (`FilterFields.tsx`), không phải mua hàng |
| 3 | Đạt: không có bộ đếm, không có nhãn "sắp hết"/"nhiều người đang xem" | không có `setInterval`, không chuỗi khan hiếm trong `components/` và `app/` |
| 4 | Đạt: chỉ hiển thị "Tạm tính" và nói rõ "Phí vận chuyển và mã giảm giá được tính ở bước thanh toán" (không giấu việc còn khoản sau) | `CartContents.tsx` khối `Tóm tắt` |
| 5 | Đạt: xóa dòng là một thao tác | `CartContents.tsx` |
| 6 | Đạt: giỏ và mua dùng khách vãng lai, không yêu cầu tài khoản | E2E `checkout-cod.spec.ts` ("Mua không cần tài khoản.") |

## Màn 2 — Checkout một trang (`components/checkout/CheckoutForm.tsx`, `Totals.tsx`, `/thanh-toan`)
| Mục | Kết quả | Bằng chứng |
|---|---|---|
| 1 | Đạt: không có ô đồng ý marketing/chia sẻ dữ liệu; phương thức mặc định là COD (không phát sinh khoản trả trước) | `useState<PaymentMethod>("cod")`; không ô checkbox trong form |
| 2 | Đạt: nút chính "Đặt hàng"; không có nút từ chối bằng chữ gây áy náy | `submitLabel` |
| 3 | Đạt: không đếm ngược. Chỉ có câu trung thực "Đơn được giữ hàng trong thời gian có hạn" khi chọn VNPAY (giữ hàng thật ở server). Chữ "chỉ còn N" chỉ xuất hiện trong thông báo xung đột tồn do server báo (số thật), không dùng làm thúc giục | `CheckoutForm.tsx` (nhóm "3. Thanh toán", banner tồn) |
| 4 | Đạt: Tiền hàng, từng loại giảm giá, phí vận chuyển, giảm phí vận chuyển, Tổng phải trả, phương thức thanh toán nằm ngay trên nút đặt hàng; do server báo giá. Khi báo giá hết hạn hoặc đổi, nút đổi thành "Xác nhận tổng mới và đặt hàng" — không thu ngầm số khác | `Totals.tsx`; E2E `checkout-total.spec.ts` |
| 5 | Đạt: "Bỏ mã" giảm giá một cú bấm; không hỏi lại | `CheckoutForm.tsx` |
| 6 | Đạt: không cần tài khoản; không chèn bước đăng ký | E2E |
| Ghi chú | Dòng "Bằng việc đặt hàng, bạn đồng ý với chính sách giao hàng và đổi trả" là đồng ý điều khoản dịch vụ, không phải đồng ý xử lý dữ liệu cho mục đích phụ; chấp nhận được | `CheckoutForm.tsx` |

## Màn 3 — Xác nhận / trang đơn (`components/orders/OrderDetail.tsx`, `OrderActions.tsx`, `/don-hang/[ref]`)
| Mục | Kết quả | Bằng chứng |
|---|---|---|
| 4 | Đạt: Tạm tính, Giảm giá, Phí giao hàng, Tổng cộng đúng bằng tổng ở checkout, không có khoản mới | E2E `checkout-total.spec.ts` (so từng dòng) |
| 2, 5 | Đạt: hủy đơn là 2 bước (nút "Hủy đơn" → hộp thoại); nút trong hộp thoại trung tính "Giữ đơn" / "Xác nhận hủy"; nêu rõ hệ quả (hoàn tiền / trả hàng về kho); không bị che nút | `OrderActions.tsx` |
| 1 | Đạt: không có ô chọn bật sẵn | đọc mã |

## Kết luận và việc còn mở
- Không phát hiện dark pattern ở giỏ, checkout, xác nhận trong mã hiện tại.
- Tự động hóa: E2E `checkout-total.spec.ts` chống phí ẩn/lệch tổng (UX-CONTENT-006). Chưa có kiểm tự động cho các mục 1–3 và 5; hàng rào hiện là biên bản này, cần rà lại khi thêm: ô đồng ý/marketing, nhãn khan hiếm, bộ đếm, cross-sell.
- Còn thiếu cho UX-CONTENT-005: mục kiểm dark pattern trong mẫu PR (`.github/pull_request_template.md`) — thuộc cấu hình CI/GitHub, ngoài phạm vi task này, cần người duyệt. Tiêu chí "E2E luồng hủy gói ≤ số bước đăng ký" chưa áp dụng được: dự án không có gói thuê bao; thay bằng "hủy đơn" (hai bước, như trên) — chưa có E2E riêng cho luồng hủy.
- Tính trung thực của dữ liệu khan hiếm/giảm giá phía server (nhãn "giảm %" của `Price.tsx` chỉ hiện khi có giá gốc từ catalog) chưa rà với dữ liệu thật của chủ shop.
