# Chế độ render từng route storefront

> Nguồn sự thật: cây `apps/storefront/src/app`. `node scripts/check-routes.mjs` so bảng dưới với cây đó (thiếu/thừa route, chế độ ngoài tập cho phép, thiếu lý do → exit 1). Yêu cầu: `FE-RENDER-001`.
> Cập nhật: 2026-10-26.

## Tiền đề chung

- `app/layout.tsx` gọi `await connection()` (CSP nonce mỗi request cấp bởi `src/proxy.ts`; trang tĩnh sẽ mang script không nonce → bị CSP chặn). Vì vậy **mọi trang dưới layout gốc render lúc request**, không có trang prerender tĩnh thật. Chế độ ghi dưới đây là chế độ **dữ liệu**: `cache dùng chung` = dữ liệu công khai cache 60 giây ở tầng `fetch` (`next.revalidate`, `lib/catalog/client.ts`) hoặc `Cache-Control` công khai; `stream động` = render mỗi request, dữ liệu theo phiên/khách, không cache dùng chung.
- Đường riêng tư (`/gio-hang`, `/thanh-toan/*`, `/don-hang/*`, `/tra-cuu-don/*`, `/api/cart/*`) có `Cache-Control` riêng tư ở `next.config.ts` (`PRIVATE_SOURCES`).
- Chế độ hợp lệ: `tĩnh`, `cache dùng chung`, `stream động`, `CSR`. Không có route nào thuần `CSR` (không có trang client-only); `not-found.tsx` không phải route.

## Bảng route

| Route | Tệp | Chế độ | Lý do |
| --- | --- | --- | --- |
| `/` | `page.tsx` | cache dùng chung | Trang chủ: hàng mới + danh mục là dữ liệu công khai, `revalidate = 60`. |
| `/bao-mat` | `(shop)/bao-mat/page.tsx` | stream động | Nội dung chính sách cố định nhưng HTML vẫn render theo request vì CSP nonce của layout. |
| `/danh-muc/[slug]` | `(shop)/danh-muc/[slug]/page.tsx` | cache dùng chung | Danh sách công khai theo danh mục + bộ lọc (`searchParams`), dữ liệu cache 60 giây. |
| `/doi-tra-hoan-tien` | `(shop)/doi-tra-hoan-tien/page.tsx` | stream động | Chính sách cố định; HTML theo request vì CSP nonce. |
| `/don-hang/[ref]` | `(shop)/don-hang/[ref]/page.tsx` | stream động | Đơn của khách, `force-dynamic`, riêng tư, không cache. |
| `/giao-hang` | `(shop)/giao-hang/page.tsx` | stream động | Chính sách cố định; HTML theo request vì CSP nonce. |
| `/gio-hang` | `(shop)/gio-hang/page.tsx` | stream động | Giỏ theo cookie HttpOnly, `force-dynamic`, riêng tư. |
| `/san-pham/[slug]` | `(shop)/san-pham/[slug]/page.tsx` | cache dùng chung | Chi tiết sản phẩm công khai, dữ liệu cache 60 giây; chọn biến thể qua `searchParams`. |
| `/thanh-toan` | `(shop)/thanh-toan/page.tsx` | stream động | Thanh toán gắn giỏ của phiên, `force-dynamic`, riêng tư. |
| `/thanh-toan/ket-qua` | `(shop)/thanh-toan/ket-qua/route.ts` | stream động | Route handler nhận redirect VNPAY, `force-dynamic`, không Referer, không cache. |
| `/tim-kiem` | `(shop)/tim-kiem/page.tsx` | cache dùng chung | Kết quả tìm công khai theo truy vấn, dữ liệu cache 60 giây; meta `noindex,follow`. |
| `/tra-cuu-don` | `(shop)/tra-cuu-don/page.tsx` | stream động | Tra cứu đơn, `force-dynamic`, riêng tư. |
| `/tra-cuu-don/xac-thuc` | `(shop)/tra-cuu-don/xac-thuc/page.tsx` | stream động | Xác thực liên kết tra cứu mang token trên URL, `force-dynamic`, không Referer. |
| `/offline` | `offline/page.tsx` | stream động | Trang dự phòng của service worker; nội dung cố định nhưng HTML theo request vì CSP nonce. |
| `/api/address/wards` | `api/address/wards/route.ts` | cache dùng chung | Phường/xã công khai, `Cache-Control: public, s-maxage=86400`. |
| `/api/analytics` | `api/analytics/route.ts` | stream động | Nhận sự kiện (POST), `force-dynamic`. |
| `/api/cart/count` | `api/cart/count/route.ts` | stream động | Đếm giỏ theo cookie phiên, `private, no-store`. |
| `/api/catalog/count` | `api/catalog/count/route.ts` | cache dùng chung | Đếm kết quả lọc công khai, `public, s-maxage=60`. |
| `/api/catalog/suggest` | `api/catalog/suggest/route.ts` | cache dùng chung | Gợi ý tìm kiếm công khai, `Cache-Control` công khai. |
| `/manifest.webmanifest` | `manifest.ts` | tĩnh | Manifest PWA, không phụ thuộc request. |
| `/robots.txt` | `robots.ts` | stream động | `force-dynamic`: URL site lấy từ biến môi trường lúc chạy. |
| `/sitemap.xml` | `sitemap.ts` | stream động | `force-dynamic`: liệt kê sản phẩm/danh mục hiện có từ backend. |
