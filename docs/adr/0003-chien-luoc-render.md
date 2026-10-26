# ADR-0003 — Chiến lược render theo nhóm route (storefront Next.js)

## Trạng thái

Accepted (2026-10-26) — ghi lại hiện trạng đã triển khai và cấm lệch.

## Ngày

2026-10-26

## Bối cảnh

PRF-WEB-001: chiến lược render chọn theo nhóm route; route theo người dùng không dùng cache chia sẻ. Dự án không có tài khoản người mua (mua không cần đăng nhập): "theo người dùng" nghĩa là giỏ (cookie phiên), thanh toán, xem/tra cứu đơn bằng mã/token. Dữ liệu catalog công khai đổi theo giá/tồn nên không được cũ quá lâu. Hiện trạng thật (đọc mã ngày 2026-10-26):

- Trang chủ: `export const revalidate = 60` (`apps/storefront/src/app/page.tsx`).
- Catalog: `lib/catalog/client.ts` gọi backend bằng `fetch` phía server với `next: { revalidate: 60 }` (hoặc `no-store` khi cần dữ liệu tươi); trang danh mục/tìm kiếm đọc `searchParams` nên được dựng theo yêu cầu.
- Riêng tư: `/gio-hang`, `/thanh-toan`, `/thanh-toan/ket-qua`, `/don-hang/[ref]`, `/tra-cuu-don`, `/tra-cuu-don/xac-thuc` đặt `dynamic = "force-dynamic"`; `next.config.ts` (`PRIVATE_SOURCES`) gắn `Cache-Control: private, no-store` cho các đường này và `/api/cart/*`, `/api/checkout/*`; trang mang token không gửi Referer (`NO_REFERRER_SOURCES`).
- API công khai nhẹ: `/api/catalog/suggest|count` dùng `public, s-maxage=60, stale-while-revalidate=300`; `/api/address/wards` cache dài (danh mục hành chính).
- Service worker/manifest: `public, max-age=0, must-revalidate`; `/offline` là trang không phụ thuộc phiên.

## Phương án đã cân nhắc

1. SSR toàn bộ, không cache — loại: tốn tải backend cho trang đọc công khai, TTFB cao trên mạng di động (mục tiêu mobile-first).
2. SSG/ISR toàn bộ kể cả giỏ/đơn — loại: sai và không an toàn (lộ dữ liệu phiên/đơn qua cache chung).
3. Theo nhóm route — chọn: công khai dùng ISR ngắn; riêng tư luôn động + `private, no-store`; CSR chỉ cho tương tác nhỏ (biến thể, lọc, giỏ) với dữ liệu tiền dựng lại từ server.

## Quyết định

| Nhóm route                                                                    | Chiến lược                                                              | Cache-Control / cơ chế                                                 |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Trang chủ                                                                     | ISR                                                                     | `revalidate = 60`                                                      |
| Catalog: sản phẩm, danh mục, tìm kiếm                                         | ISR ở tầng dữ liệu 60 s; trang dựng theo yêu cầu khi có `searchParams`  | `next.revalidate = 60`; một canonical cho PDP                          |
| `/api/catalog/*`, `/api/address/wards`                                        | Route handler công khai                                                 | `public, s-maxage` + `stale-while-revalidate`                          |
| Giỏ, thanh toán, kết quả thanh toán, xem đơn, tra cứu đơn                     | SSR động                                                                | `force-dynamic` + `private, no-store`; không `Referer` cho trang token |
| `/api/cart/*`, `/api/checkout/*`, `/api/analytics`                            | Động                                                                    | `private, no-store` / `force-dynamic`                                  |
| `sw.js`, `manifest.webmanifest`                                               | Tĩnh                                                                    | `public, max-age=0, must-revalidate`                                   |

Quy tắc: route mới phải được xếp vào một dòng của bảng này; route theo phiên/đơn bắt buộc có `private, no-store` trong `PRIVATE_SOURCES`.

## Hệ quả

- Giá/tồn hiển thị có thể cũ tối đa ~60 s; giá cuối luôn tính lại ở server khi giỏ/thanh toán (không tin giá trang cache).
- Kiểm bằng test: `apps/storefront/src/lib/cart/private-cache.test.ts` và `pwa/cache-policy.test.ts` (header riêng tư, chính sách SW).
- Khoảng trống còn mở (BLUEPRINT `PRF-WEB-001 — Thiếu`): chưa có E2E "hai phiên khác nhau không thấy dữ liệu của nhau".

## Điều kiện đọc lại

- Thêm tài khoản người mua hoặc nội dung cá nhân hóa trên trang công khai.
- Số đo thật (Lighthouse/RUM) cho thấy catalog vượt ngân sách LCP/TTFB, hoặc độ cũ 60 s gây bán sai giá/tồn.
- Nâng chính Next.js đổi mặc định cache/rendering (đọc lại ghi chú phát hành).
- Thêm CDN production: xác nhận CDN tôn trọng `private, no-store` và `s-maxage` như bảng trên.
