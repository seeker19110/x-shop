# Kho phía trình duyệt của storefront

> Yêu cầu `FE-STATE-008`: không lưu token phiên, PII hay dữ liệu nhạy cảm trong kho bền (localStorage/IndexedDB/persist) ngoài danh sách đã duyệt dưới đây. Test `apps/storefront/src/lib/client-storage.test.ts` đối chiếu tài liệu này với mã nguồn (tệp dùng API kho phải nằm trong bảng) và chạy các luồng ghi thật để khoá rằng mọi khoá/giá trị nằm trong danh sách, khoá không chứa `token|session|email|...`, giá trị không giống email/điện thoại/địa chỉ.
> Cập nhật: 2026-10-26.

## Khoá đã duyệt

| Khoá | Kho | Tệp | Giá trị | Mục đích | Vòng đời |
| --- | --- | --- | --- | --- | --- |
| `xs_analytics_consent` | localStorage | `lib/analytics/track.ts` | `"granted"` (khoá bị xoá khi từ chối) | Nhớ đồng ý gửi phân tích qua beacon | Bền đến khi khách rút đồng ý |
| `xs_purchase_<mã đơn hiển thị>` | localStorage (dự phòng sessionStorage, rồi bộ nhớ) | `lib/analytics/track.ts` | `"1"` | Dedupe sự kiện `purchase` khi mở lại trang đơn | Bền; mã đơn hiển thị không phải PII |
| `xs:scroll` | sessionStorage | `components/catalog/scroll-restore.ts` | JSON `{ "<đường dẫn+query>": số }`, tối đa 20 mục | Khôi phục vị trí cuộn khi Back từ trang sản phẩm | Theo tab, mất khi đóng tab |

## Tệp được dùng API kho

Tệp ngoài danh sách này gọi `localStorage` / `sessionStorage` / `indexedDB` / `persist(` / `document.cookie` thì test đỏ — thêm vào bảng khoá ở trên kèm lý do trước.

| Tệp | Ghi chú |
| --- | --- |
| `components/catalog/ScrollRestorer.tsx` | Lấy `window.sessionStorage` đưa cho `scroll-restore.ts`. |
| `lib/analytics/track.ts` | Đồng ý phân tích + dedupe `purchase`. |

## Không lưu ở kho trình duyệt

- Token/phiên giỏ: cookie `HttpOnly` đặt ở server (`lib/cart/cookie.ts`); JS không đọc được.
- Form thanh toán (họ tên, SĐT, email, địa chỉ): chỉ ở state của trang (`CheckoutForm.tsx`), không ghi kho.
- Khoá idempotency thanh toán: chỉ ở bộ nhớ trang (`lib/checkout/idempotency.ts`).
- Cache API của service worker (`public/sw.js`): theo chính sách của `public/sw.js` (test `lib/pwa/cache-policy.test.ts`), không cache đường riêng tư.
