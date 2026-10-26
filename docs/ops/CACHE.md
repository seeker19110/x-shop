# Chiến lược cache và vô hiệu hoá (BE-CACHE-007, FE-STATE-005)

Cập nhật 2026-10-26. Mọi số dưới đây có một nơi khai báo duy nhất ở `apps/storefront/src/lib/cache-policy.ts`;
`apps/storefront/src/lib/cache-policy.test.ts` kiểm tài liệu này khớp mã và kiểm "cập nhật nguồn → đọc lại không nhận bản
cũ quá ngưỡng". Đổi số trong mã mà quên sửa tài liệu thì test đỏ.

Ba cơ chế vô hiệu hoá, mỗi loại cache dùng ít nhất một:

- **TTL**: hết hạn theo thời gian; chấp nhận dữ liệu cũ tới ngưỡng ghi ở cột "Cũ tối đa".
- **Sự kiện**: ai đó chủ động xoá khi dữ liệu đổi (`revalidatePath`, huỷ cache lúc `activate`…).
- **Phiên bản**: khoá/tên cache chứa phiên bản; đổi phiên bản = bỏ toàn bộ bản cũ (tên tệp băm nội dung, `CACHE_VERSION`).

Nguyên tắc chung: chỉ cache dữ liệu **công khai**; mọi thứ gắn với khách (giỏ, thanh toán, đơn, tra cứu) là
`private, no-store` và không bao giờ vào cache dùng chung hay service worker.

## Bảng tóm tắt

| Loại cache | Cơ chế | Giá trị | Ai vô hiệu hoá, khi nào | Cũ tối đa sau khi nguồn đổi |
| --- | --- | --- | --- | --- |
| Dữ liệu catalog (fetch phía server) | TTL | `next.revalidate` = 60 giây | Next tự làm mới sau TTL; đường cần đúng tuyệt đối dùng `no-store` | 60 giây |
| Trang chủ (ISR) | TTL | `export const revalidate = 60` | Next dựng lại nền sau TTL | 60 giây (+ tuổi dữ liệu catalog, cùng 60 giây) |
| API công khai của storefront | TTL (CDN/trình duyệt) | `public, s-maxage=60, stale-while-revalidate=300` | CDN theo `s-maxage`; không có purge thủ công | 420 giây |
| Danh mục tỉnh/phường | TTL | 86400 giây (+ `max-age=3600` ở trình duyệt) | Next sau TTL; đổi bản dữ liệu hành chính → xem mục riêng | 86400 giây (server) |
| Service worker | Phiên bản + sự kiện | `CACHE_VERSION = "v1"` | Trình duyệt, ở sự kiện `activate` | tới lần tải kế tiếp có mạng |
| Tài nguyên tĩnh | Phiên bản | `/_next/static/*` tên băm nội dung | Mỗi lần build đổi tên tệp | 0 (URL mới) |
| Ảnh sản phẩm | TTL | `images.minimumCacheTTL` mặc định của Next 16 = 14400 giây | Next sau TTL; đổi ảnh → đổi URL ảnh | 14400 giây |
| Dữ liệu riêng tư | Không cache | `private, no-store` | Không áp dụng; sự kiện ghi → `revalidatePath` | 0 |

## Dữ liệu catalog (fetch phía server)

- **Mã:** `apps/storefront/src/lib/catalog/client.ts` (`backendGet`): `fetch(..., { next: { revalidate: CATALOG_REVALIDATE_S } })`
  = **60 giây** cho danh sách, tìm kiếm, chi tiết sản phẩm, danh mục. `getProductFresh` dùng `cache: "no-store"`.
- **Cơ chế:** TTL. Khoá cache của Next gồm URL đầy đủ, nên bộ lọc/trang/sắp xếp khác nhau là các mục khác nhau.
  Tìm kiếm chuyển tiếp IP khách (chống lạm dụng) nên khoá tách theo IP — chấp nhận vì truy vấn tìm kiếm vốn phân tán.
- **Ai/khi nào vô hiệu hoá:** Next, sau 60 giây, làm mới nền (stale-while-revalidate nội bộ). Không có purge theo sự
  kiện: backend không gọi ngược storefront khi sửa sản phẩm.
- **Ngưỡng chấp nhận được:** sửa sản phẩm/giá hiện trên trang danh mục, tìm kiếm, PDP chậm tối đa **60 giây**.
- **Không được cũ:** giá và tồn dùng để thêm vào giỏ, báo giá và đặt hàng. Giỏ gọi `getProductFresh` (`no-store`);
  checkout do server báo giá lại ở từng bước và lúc đặt (đặc tả §7.4). Giá trên PDP chỉ là thông tin tham khảo tới 60 giây.
- **Test:** `cache-policy.test.ts` ("cache dữ liệu catalog"): sửa nguồn → trong TTL còn bản cũ, đúng 60 giây thì bản
  mới; độ cũ quan sát được không vượt 60 giây; `getProductFresh` thấy bản mới ngay; nguồn lỗi sau khi hết hạn thì báo lỗi.

## Trang chủ (ISR)

- **Mã:** `apps/storefront/src/app/page.tsx` — `export const revalidate = 60` (phải là literal tĩnh để Next đọc lúc build).
  Layout gốc gọi `connection()` để gắn nonce CSP nên trang vẫn render lúc request; phần dữ liệu thật sự được cache
  là các `fetch` catalog ở trên.
- **Cơ chế:** TTL, 60 giây, cùng nguồn với mục trước nên trần tổng không cộng dồn thêm khi trang dựng từ cache dữ liệu
  còn hạn; trường hợp xấu nhất là hai lớp lệch pha (tối đa 120 giây).
- **Test:** `cache-policy.test.ts` kiểm `revalidate` của trang chủ bằng `CATALOG_REVALIDATE_S`.

## API công khai của storefront

- **Mã:** `/api/catalog/suggest`, `/api/catalog/count` trả `Cache-Control` =
  `public, s-maxage=60, stale-while-revalidate=300` (hằng `CATALOG_API_CACHE_CONTROL`). Lỗi (422/503) không mang
  header công khai.
- **Cơ chế:** TTL ở CDN/proxy dùng chung. Trình duyệt không giữ riêng (không có `max-age`).
- **Ai/khi nào vô hiệu hoá:** CDN theo `s-maxage`; sau 60 giây còn được phát bản cũ tối đa thêm 300 giây trong lúc
  làm mới nền. Không có purge.
- **Ngưỡng chấp nhận được:** tuổi dữ liệu origin (60 giây) + `s-maxage` (60) + `stale-while-revalidate` (300) =
  **420 giây** (hàm `maxStalenessS`). Chỉ là gợi ý tìm kiếm và số đếm kết quả; trang kết quả thật vẫn đọc nguồn qua
  mục catalog (≤ 60 giây), nên số đếm lệch tạm thời không làm sai giá hay tồn.
- **Test:** `cache-policy.test.ts` ("API công khai dùng đúng hằng số"; `maxStalenessS` = 420).

## Danh mục tỉnh/phường

- **Mã:** `apps/storefront/src/lib/checkout/address.ts` (`next.revalidate` = `ADDRESS_REVALIDATE_S` = 86400 giây);
  `/api/address/wards` trả `public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`
  (`ADDRESS_API_CACHE_CONTROL`, khớp `PUBLIC_ADDRESS_CACHE` của backend).
- **Cơ chế:** TTL dài vì dữ liệu hành chính chỉ đổi theo bản phát hành (docs đặc tả địa chỉ 2 cấp).
- **Ai/khi nào vô hiệu hoá:** Next sau 86400 giây. Khi nhập bản dữ liệu hành chính mới: triển khai lại storefront
  (xoá cache dữ liệu của bản chạy) hoặc chờ hết TTL; người vận hành ghi vào RUNBOOK khi đổi bản dữ liệu.
- **Ngưỡng chấp nhận được:** 86400 giây ở server; trình duyệt giữ thêm tối đa 3600 giây. Địa chỉ cũ vẫn gửi được vì
  backend kiểm lại mã tỉnh/phường khi báo giá và đặt hàng.
- **Test:** `cache-policy.test.ts` ("cache danh mục tỉnh/phường"): cũ trước 86400 giây, mới đúng 86400 giây; lỗi
  nguồn không bị lưu thành kết quả.

## Service worker

- **Mã:** `apps/storefront/public/sw.js`. Chỉ cache theo danh sách cho phép: tài nguyên tĩnh và vài trang công khai;
  đường riêng tư, có `Authorization`, `Set-Cookie`, `private`/`no-store`, `Vary: Cookie` không bao giờ được lưu.
  Chính sách có test riêng (`lib/pwa/cache-policy.test.ts`).
- **Cơ chế:** phiên bản + sự kiện. Tên cache `xshop-public-` + `CACHE_VERSION = "v1"`.
- **Ai/khi nào vô hiệu hoá:** trình duyệt chạy sự kiện `activate` của bản SW mới: xoá mọi cache có tiền tố
  `xshop-public-` khác phiên bản hiện tại và xoá mục không còn hợp lệ theo chính sách. Bản mới không `skipWaiting`
  (chỉ nhận quản lý khi tab cũ đóng, để không đổi giữa lúc khách đang thanh toán). **Đổi chiến lược cache hoặc
  danh sách cho phép thì phải tăng `CACHE_VERSION`.** `/sw.js` và manifest phát `max-age=0, must-revalidate`.
- **Ngưỡng chấp nhận được:** trang công khai chỉ được phát từ cache khi mất mạng (mạng trước, cache sau); tài nguyên tĩnh
  cache-first an toàn vì URL có băm.

## Tài nguyên tĩnh

- **Mã:** Next phát `/_next/static/*` với tên băm nội dung và `Cache-Control: public, max-age=31536000, immutable`
  (hành vi mặc định của Next, không cấu hình thêm ở dự án).
- **Cơ chế:** phiên bản. Mỗi lần build đổi tên tệp nên không cần vô hiệu hoá; tệp cũ hết dùng.

## Ảnh sản phẩm

- **Mã:** `next/image` (tối ưu qua `/_next/image`); `images.minimumCacheTTL` không đặt nên theo mặc định của Next 16
  là **14400 giây** (xác minh 2026-10-26 trong `node_modules/next/dist/shared/lib/image-config.js`).
- **Cơ chế:** TTL + đổi URL. Sửa ảnh phải đi kèm URL ảnh mới (backend trả đường dẫn theo tệp); sửa tại chỗ chỉ thấy
  sau tối đa 14400 giây.
- **Ai vô hiệu hoá:** Next sau TTL; không có purge thủ công.

## Dữ liệu riêng tư

- **Mã:** `next.config.ts` (`PRIVATE_SOURCES`: giỏ, thanh toán, đơn hàng, tra cứu đơn, `/api/cart/*`, `/api/checkout/*`)
  phát `Cache-Control: private, no-store`; `/api/cart/count` tự đặt thêm; service worker không bao giờ lưu.
- **Cơ chế:** không cache. Phía server dựng lại trang sau khi ghi (sự kiện): `revalidatePath("/gio-hang")` và
  `revalidatePath("/thanh-toan")` trong `apps/storefront/src/lib/cart/actions.ts` sau mỗi thao tác giỏ.
- **Test:** `lib/cart/private-cache.test.ts`.

## Retry phía client

Mã: `apps/storefront/src/lib/http/retry.ts` (`fetchWithRetry`), test `retry.test.ts`. Đang dùng cho ba lời gọi GET
công khai ở trình duyệt: tải phường/xã (`CheckoutForm`), đếm kết quả bộ lọc (`FilterDrawer`), gợi ý tìm kiếm
(`SearchCombobox`, tối đa 1 lần thử lại vì gõ tiếp sẽ huỷ).

| Quy tắc | Giá trị |
| --- | --- |
| Lỗi được retry | lỗi mạng (`TypeError`), `TimeoutError`, HTTP 408, 429, 500, 502, 503, 504 |
| Không retry | mọi 4xx khác (400/401/403/404/409/410/422…), 501, 505, 2xx/3xx; `AbortError` do người dùng huỷ |
| Phương thức | chỉ GET/HEAD/OPTIONS, hoặc yêu cầu có header `Idempotency-Key`, hoặc người gọi khai `idempotent: true`. POST/PUT/PATCH/DELETE thường không retry |
| Trần | 3 lần thử lại (tối đa 4 lần gọi); hết lượt trả phản hồi lỗi cuối / ném lỗi mạng cuối |
| Backoff | `random() × min(4000 ms, 250 ms × 2^lần)` (jitter đầy đủ để khách không dồn cùng lúc) |
| `Retry-After` | giây hoặc ngày HTTP: chờ ít nhất bấy lâu; bắt chờ quá 10 000 ms thì không retry, trả lỗi để giao diện báo; giá trị rỗng/sai không bị coi là 0 |
| Huỷ | `AbortSignal` của người gọi đã huỷ (kể cả giữa lúc chờ backoff) → dừng ngay |

Ngoài phạm vi (có cơ chế riêng): đặt hàng `POST /store/x/checkout/submit` dùng khóa idempotency giữ trong bộ nhớ trang
và tự đọc `Retry-After` của 503 `LOCK_UNAVAILABLE` (`lib/checkout/idempotency.ts`, `checkout-lib.ts`); gọi server-side
tới backend (`backendGet`) chưa retry — lỗi trả về `CatalogError("UNAVAILABLE")` để trang hiện trạng thái lỗi nhẹ.
