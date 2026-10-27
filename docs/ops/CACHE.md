# Chiến lược cache và vô hiệu hoá (BE-CACHE-007, FE-STATE-005)

Cập nhật 2026-10-27 (T-142: vô hiệu hoá catalog theo sự kiện). Mọi số dưới đây có một nơi khai báo duy nhất ở `apps/storefront/src/lib/cache-policy.ts`;
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
| Dữ liệu catalog (fetch phía server) | Sự kiện + TTL | `next.tags` + `next.revalidate` = 60 giây | Backend gửi webhook ký HMAC → `/api/revalidate` gọi `revalidateTag(tag, { expire: 0 })` khi sản phẩm/giá/tồn đổi; Next làm mới nền sau TTL (lưới an toàn); đường cần đúng tuyệt đối dùng `no-store` | webhook chạy: vài giây (cửa sổ gộp 2 giây + lượt xả read model + gửi); webhook lỗi/tắt: 60 giây + 1 lần đọc |
| Trang chủ (ISR) | TTL | `export const revalidate = 60` | Next dựng lại nền sau TTL (cũng SWR) | như dòng catalog; hai lớp cùng 60 giây có thể lệch pha |
| API công khai của storefront | TTL (CDN/trình duyệt) | `public, s-maxage=60, stale-while-revalidate=300` | CDN theo `s-maxage`; không có purge thủ công | 420 giây + 1 lần đọc ở lớp Next phía sau |
| Danh mục tỉnh/phường | TTL | 86400 giây (+ `max-age=3600` ở trình duyệt) | Next làm mới nền sau TTL; đổi bản dữ liệu hành chính → xem mục riêng | 86400 giây + 1 lần đọc (server) |
| Service worker | Phiên bản + sự kiện | `CACHE_VERSION = "v1"` | Trình duyệt, ở sự kiện `activate` | tới lần tải kế tiếp có mạng |
| Tài nguyên tĩnh | Phiên bản | `/_next/static/*` tên băm nội dung | Mỗi lần build đổi tên tệp | 0 (URL mới) |
| Ảnh sản phẩm | TTL | `images.minimumCacheTTL` mặc định của Next 16 = 14400 giây | Next sau TTL; đổi ảnh → đổi URL ảnh | 14400 giây |
| Dữ liệu riêng tư | Không cache | `private, no-store` | Không áp dụng; sự kiện ghi → `revalidatePath` | 0 |

## Dữ liệu catalog (fetch phía server)

- **Mã:** `apps/storefront/src/lib/catalog/client.ts` (`backendGet`):
  `fetch(..., { next: { revalidate: CATALOG_REVALIDATE_S, tags } })` = **60 giây** cho danh sách, tìm kiếm, chi tiết sản
  phẩm, danh mục; `getProductFresh` dùng `cache: "no-store"`. Route nhận webhook: `apps/storefront/src/app/api/revalidate/`.
- **Cơ chế:** sự kiện + TTL. Khoá cache của Next gồm URL đầy đủ, nên bộ lọc/trang/sắp xếp khác nhau là các mục khác nhau.
  Tìm kiếm chuyển tiếp IP khách (chống lạm dụng) nên khoá tách theo IP — chấp nhận vì truy vấn tìm kiếm vốn phân tán.
- **Ai/khi nào vô hiệu hoá:** (1) **sự kiện** — backend báo storefront qua webhook khi sản phẩm/biến thể/giá/price list/
  tồn đổi (mục dưới), storefront hết hạn NGAY các mục mang tag tương ứng: lần đọc kế tiếp nạp lại từ backend, không phát bản
  cũ thêm lần nào; (2) **TTL** — lưới an toàn khi webhook lỗi/tắt: mục quá 60 giây thì request kế tiếp NHẬN NGAY BẢN CŨ và
  kích làm mới nền (stale-while-revalidate, `patch-fetch.js` của Next 16, nhánh `entry.isStale`); request sau đó mới thấy bản
  mới. Làm mới nền lỗi thì giữ bản cũ và thử lại ở request sau; chỉ khi chưa có mục nào thì lỗi nguồn mới báo ra.
- **Tag** (`next.tags`, tên khai một nơi ở `@x-shop/domain` `catalogRevalidate`): mọi fetch catalog mang `catalog`; danh
  sách/tìm kiếm/danh mục thêm `catalog:list`; PDP thêm `product:<handle đã encodeURIComponent>`.
- **Ngưỡng chấp nhận được:** webhook chạy → sửa sản phẩm/giá/tồn hiện trên PDP, danh mục, tìm kiếm sau **vài giây** (cửa sổ
  gộp 2 giây + lượt xả read model + một POST; E2E `e2e/catalog-revalidate.spec.ts` đòi < 15 giây trên hệ thật). Webhook lỗi
  hoặc tắt → như trước: **60 giây cộng thêm tới lần đọc kế tiếp của cùng khoá** (khoá ít người xem có thể cũ hơn nhiều).
  Chấp nhận được vì giá/tồn lúc mua luôn kiểm lại tươi.
- **Không được cũ:** giá và tồn dùng để thêm vào giỏ, báo giá và đặt hàng. Giỏ gọi `getProductFresh` (`no-store`);
  checkout do server báo giá lại ở từng bước và lúc đặt (đặc tả §7.4). Giá trên PDP chỉ là thông tin tham khảo (vài giây
  khi webhook chạy, tới 60 giây khi webhook lỗi).
- **Test:** `cache-policy.test.ts` ("cache dữ liệu catalog"): sửa nguồn → trong TTL còn bản cũ; hết TTL lần đọc đầu vẫn
  trả bản cũ rồi lần sau mới (mô hình SWR của Next); khoá ít người xem; `getProductFresh` thấy bản mới ngay; nguồn lỗi
  sau khi hết hạn vẫn phát bản cũ, chưa có mục mà lỗi thì báo lỗi. `lib/catalog/revalidate-cache.test.ts`: sửa giá → webhook
  → đọc PDP ngay thấy giá mới (không webhook thì còn giá cũ), chỉ làm mới đúng tag, chữ ký sai không đụng cache.

### Vô hiệu hoá theo sự kiện: webhook backend → storefront (T-142, D-070)

- **Luồng:** workflow ghi (sản phẩm, biến thể, giá, price list, tồn/giữ hàng, danh mục) → sự kiện Medusa → subscriber
  `catalog-index-sync` đánh dấu sản phẩm bẩn → lượt xả đồng bộ read model (`lib/catalog/indexer.ts`) → **sau khi** read model
  đã mới, `lib/catalog/revalidate.ts` ghi outbox `catalog.revalidate` (rebuild toàn phần → một dòng "cả catalog"). Ghi SAU
  read model để danh sách/tìm kiếm nạp lại đọc được bản mới (PDP đọc nguồn trực tiếp). Giá khuyến mãi hết hạn (job mỗi phút
  `markExpiredPrices`) đi cùng đường.
- **Không chặn ghi backend:** workflow đã commit trước khi sự kiện chạy; lỗi ghi outbox chỉ log (storefront dựa TTL); lỗi
  gửi nằm trong outbox (retry backoff, quá 8 lần hoặc 4xx → `dead`). Dòng `catalog.revalidate` chết mở MỘT ngoại lệ
  `outbox_dead` đang mở cho loại này (`openOpsExceptionIfNoneActive`, phạm vi `type`, ưu tiên `normal` — dữ liệu vẫn tươi
  lại theo TTL), không mỗi dòng một ngoại lệ; loại sự kiện khác giữ hành vi cũ.
- **Không chặn khe outbox-dispatch dùng chung (D-081):** mỗi POST có hạn 2 giây; storefront không trả lời (timeout/từ chối
  kết nối) → ngắt 30 giây trong tiến trình: mọi lần gửi catalog sau đó thất bại NGAY (tạm thời, hẹn lại sau phần ngắt còn
  lại), nên một lượt dispatcher chỉ mất tối đa một timeout cho cả loạt dòng catalog; 4xx/5xx trả về nhanh, không ngắt.
- **Gộp + trần tần suất** (`CATALOG_REVALIDATE_POLICY`): cửa sổ 2 giây; mỗi (sản phẩm, cửa sổ) đúng một dòng outbox (khoá sự
  kiện chứa mốc cửa sổ, idempotent); quá 20 sản phẩm trong một cửa sổ → một dòng "cả catalog". Cuối cửa sổ tiến trình gửi
  MỘT webhook gộp các dòng rồi đánh dấu `sent` — chỉ các dòng có trong bản chụp lúc gửi; dòng ghi xong giữa lúc gửi được gửi
  bằng lượt riêng ngay sau đó (không bao giờ bị đánh dấu `sent` bởi webhook không mang tag của nó). Gửi lỗi/tiến trình chết →
  dòng đến hạn sau 10 giây và job `outbox-dispatch` gửi từng dòng.
- **Webhook:** `POST <CATALOG_REVALIDATE_URLS | STOREFRONT_URL/api/revalidate>` thân `{ id, tags }`, header
  `x-xshop-timestamp`, `x-xshop-nonce`, `x-xshop-signature: v1=<HMAC-SHA256(khoá, "v1:<ts>:<nonce>:<thân thô>")>`. Khoá
  `CATALOG_REVALIDATE_SECRET` chung hai phía (docs/ops/ENV.md). Storefront: thiếu header chữ ký → 401 không đọc thân; chữ ký
  sai/lệch giờ > 300 giây → 401; nonce đã dùng → 409; thân sai → 400; > 16 KiB → 413 (đọc luồng có trần, kể cả thân chunked
  không `Content-Length`); chưa cấu hình khoá → 503. Gọi lại cùng nội dung với nonce mới (retry) → 200 lần nữa (revalidate
  idempotent).
- **Trước khi chạy nhiều bản storefront (bắt buộc):** cache dữ liệu của Next nằm trong từng tiến trình → phải liệt kê URL
  nội bộ của TỪNG bản trong `CATALOG_REVALIDATE_URLS` (backend gửi tới mọi URL) hoặc chuyển sang cache handler dùng chung;
  gửi qua LB chỉ làm mới một bản.
- **Giới hạn đã biết:** bộ nhớ nonce chỉ nằm trong RAM của từng tiến trình: request bị phát lại sang bản khác, hoặc tới chính
  bản đó sau khi restart (còn trong cửa sổ 300 giây), vẫn được nhận — hậu quả chỉ là một lần revalidate thừa (không đổi dữ
  liệu). Đổi handle: tag tính theo handle hiện tại → URL handle cũ còn bản cũ tới TTL. `catalog:list` được làm mới ở mọi cửa
  sổ có thay đổi, kể cả thay đổi chỉ do giữ hàng (reservation lúc checkout) — lúc đông đơn, cache danh sách thực chất còn
  ~2 giây (backend đọc read model, rẻ); chỉ gắn `catalog:list` khi dòng read model thật sự đổi là việc sau nếu đo thấy tải.
  API công khai `/api/catalog/*` sau CDN không có purge — vẫn theo ngưỡng 420 giây ở mục dưới (chỉ là gợi ý/số đếm).
- **Bật/tắt:** production BẮT BUỘC có `CATALOG_REVALIDATE_SECRET`; đường lùi (D-070) là khai tường minh
  `CATALOG_REVALIDATE_ENABLED=false` → không ghi outbox, storefront về thuần TTL, backend in cảnh báo lúc khởi động. Dev/test
  vắng khoá = tắt.
- **Test:** backend `lib/catalog/__tests__/revalidate.unit.spec.ts` (gộp, trần, đồng thời, race gửi gộp ↔ ghi outbox,
  storefront treo không chặn dispatcher, ngắt, ngoại lệ dead, env production, ký, phân loại lỗi),
  `indexer-revalidate-order.unit.spec.ts` (read model trước, outbox sau), `integration-tests/http/catalog-revalidate.spec.ts`
  (sửa giá → webhook đã ký; storefront 500/401 → ghi vẫn thành công, outbox giữ/dead + một ngoại lệ; gộp); storefront
  `app/api/revalidate/revalidate-route.test.ts` (401/409/400/413/503, đồng thời phát lại, thân chunked); E2E
  `e2e/catalog-revalidate.spec.ts` (hệ thật, Next 16 thật).

## Trang chủ (ISR)

- **Mã:** `apps/storefront/src/app/page.tsx` — `export const revalidate = 60` (phải là literal tĩnh để Next đọc lúc build).
  Layout gốc gọi `connection()` để gắn nonce CSP nên trang vẫn render lúc request; phần dữ liệu thật sự được cache
  là các `fetch` catalog ở trên.
- **Cơ chế:** TTL 60 giây, cũng theo SWR như mục trước. Trang dựng từ cache dữ liệu catalog (cũng 60 giây) nên hai lớp
  có thể lệch pha và cộng dồn tối đa khoảng hai chu kỳ cộng lần đọc kế tiếp. Vì trang render lúc request, dữ liệu catalog
  của nó (fetch có tag) cũng hết hạn theo webhook như mục trước.
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
  `/api/address/wards` (404 mã tỉnh sai, 503 nguồn lỗi không cache) trả `public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800`
  (`ADDRESS_API_CACHE_CONTROL`, khớp `PUBLIC_ADDRESS_CACHE` của backend).
- **Cơ chế:** TTL dài vì dữ liệu hành chính chỉ đổi theo bản phát hành (docs đặc tả địa chỉ 2 cấp).
- **Ai/khi nào vô hiệu hoá:** Next sau 86400 giây. Khi nhập bản dữ liệu hành chính mới: triển khai lại storefront
  (xoá cache dữ liệu của bản chạy) hoặc chờ hết TTL; người vận hành ghi vào RUNBOOK khi đổi bản dữ liệu.
- **Ngưỡng chấp nhận được:** 86400 giây cộng tới lần đọc kế tiếp (SWR) ở server; trình duyệt giữ thêm tối đa 3600 giây. Địa chỉ cũ vẫn gửi được vì
  backend kiểm lại mã tỉnh/phường khi báo giá và đặt hàng.
- **Test:** `cache-policy.test.ts` ("cache danh mục tỉnh/phường"): cũ trước 86400 giây, hết hạn lần đọc đầu vẫn cũ rồi
  mới; mã sai = `not_found`, nguồn lỗi = `unavailable` (không bị lưu thành kết quả).

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
| Lỗi được retry | lỗi mạng (`TypeError`), `TimeoutError`, HTTP 408, 429, 500, 502, 503, 504 (429 chỉ khi `Retry-After` ≤ 10 giây) |
| Không retry | mọi 4xx khác (400/401/403/404/409/410/422…), 501, 505, 2xx/3xx; `AbortError` do người dùng huỷ |
| Phương thức | chỉ GET/HEAD/OPTIONS, hoặc yêu cầu có header `Idempotency-Key`, hoặc người gọi khai `idempotent: true`. POST/PUT/PATCH/DELETE thường không retry |
| Trần | 3 lần thử lại (tối đa 4 lần gọi); hết lượt trả phản hồi lỗi cuối / ném lỗi mạng cuối |
| Backoff | `random() × min(4000 ms, 250 ms × 2^lần)` (jitter đầy đủ để khách không dồn cùng lúc) |
| `Retry-After` | giây hoặc ngày HTTP: chờ ít nhất bấy lâu; bắt chờ quá 10 000 ms (kể cả số nguyên rất lớn > 2^53) thì không retry, trả lỗi để giao diện báo; giá trị rỗng/sai không bị coi là 0 |
| Huỷ | `AbortSignal` của người gọi đã huỷ (kể cả giữa lúc chờ backoff) → dừng ngay |

Giới hạn tốc độ: backend trả 429 + `Retry-After` (tìm kiếm theo IP, 60 lần/60 giây) → `backendGet` giữ nguyên status và
`Retry-After` trong `CatalogError`, các route `/api/catalog/suggest` và `/api/catalog/count` trả 429 + `Retry-After` (mặc
60 giây, `no-store`) thay vì 503, nên client không retry — mỗi lần gõ/đếm đúng một lượt gọi backend (test
`app/api/catalog/retry-rate-limit.test.ts`). `/api/address/wards` trả 404 cho mã sai (không retry) và 503 cho nguồn lỗi
(retry).

Ngoài phạm vi (có cơ chế riêng): đặt hàng `POST /store/x/checkout/submit` dùng khóa idempotency giữ trong bộ nhớ trang
và tự đọc `Retry-After` của 503 `LOCK_UNAVAILABLE` (`lib/checkout/idempotency.ts`, `checkout-lib.ts`); gọi server-side
tới backend (`backendGet`) chưa retry — lỗi trả về `CatalogError("UNAVAILABLE")` để trang hiện trạng thái lỗi nhẹ.
