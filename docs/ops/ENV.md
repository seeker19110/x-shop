# Biến môi trường (thay cho `.env.example`)

> Quyền ghi file `.env*` bị chặn trong môi trường agent (bảo vệ bí mật) — danh sách biến được giữ ở đây và trong schema
> zod (`apps/backend/src/lib/env/index.ts`, `apps/storefront/src/lib/env/index.ts`) là nguồn chuẩn. Tạo `.env` cục bộ từ các khối dưới
> (đã gitignore). **Mọi giá trị dưới đây là GIẢ** — không commit bí mật thật (BASE-CFG-003).

## Backend (`apps/backend/.env`)
Kiểm khi khởi động: thiếu/sai → in tên biến và thoát mã 1, không in giá trị. Production (`NODE_ENV=production`) bắt buộc
mọi biến trừ mục tùy chọn; dev/test chỉ bắt buộc `DATABASE_URL` (D-007).

```dotenv
NODE_ENV=development
# bash scripts/dev-services.sh in ra đúng hai URL này cho máy dev.
DATABASE_URL=postgres://xshop:xshop@localhost:5432/xshop
# Có REDIS_URL → event bus, cache, workflow engine, Locking Module chạy trên Redis (bắt buộc ở production).
REDIS_URL=redis://localhost:6379
# ≥ 32 ký tự ngẫu nhiên, JWT_SECRET khác COOKIE_SECRET. Sinh: openssl rand -base64 48
JWT_SECRET=thay-bang-chuoi-ngau-nhien-it-nhat-32-ky-tu-jwt
COOKIE_SECRET=thay-bang-chuoi-ngau-nhien-it-nhat-32-ky-tu-cookie
# Khoá mã hoá bí mật TOTP của Auth Module (MFA admin). Thiếu → đăng ký TOTP thất bại (route nhạy cảm không dùng được).
# Đổi khoá = mọi TOTP đã đăng ký không giải mã được nữa → phải đăng ký lại.
AUTH_MFA_ENCRYPTION_KEY=thay-bang-chuoi-ngau-nhien-it-nhat-32-ky-tu-mfa
# Chính sách phiên admin (SEC02, T-024) — tùy chọn, số nguyên giây; vắng = mặc định.
# ADMIN_SESSION_MAX_AGE_SECONDS=28800   # hết hạn tuyệt đối từ lúc xác thực (8 giờ); [300, 86400]
# ADMIN_SESSION_IDLE_SECONDS=1800       # nhàn rỗi tối đa (30 phút); [60, 28800]
# ADMIN_REAUTH_MAX_AGE_SECONDS=300      # xác thực lại cho đổi quyền / hoàn tiền vượt ngưỡng (5 phút); [30, 900]
# Origin http(s) hoặc /regex/, phẩy, không đường dẫn. Regex khớp origin "null" bị từ chối. CÙNG danh sách dùng cho chống
# CSRF (request ghi có cookie phải đến từ origin trong danh sách của namespace: /store, /admin, /auth — T-034). Admin
# dashboard native phục vụ ở backend (/app) → ADMIN_CORS và AUTH_CORS phải có origin của chính backend.
STORE_CORS=http://localhost:3000
ADMIN_CORS=http://localhost:5173,http://localhost:9000
AUTH_CORS=http://localhost:5173,http://localhost:9000,http://localhost:3000
# Khoá ký token phiên đơn / liên kết tra cứu đơn (T-021). ≥ 32 ký tự ngẫu nhiên; production bắt buộc, khác khoá giả của dev
# (dev/test vắng → ORDER_LOOKUP_DEV_SECRET trong env/index.ts). Đổi khoá = mọi phiên đơn/liên kết đang có mất hiệu lực.
ORDER_LOOKUP_SECRET=thay-bang-chuoi-ngau-nhien-it-nhat-32-ky-tu-order
# Proxy tin cậy được phép báo IP khách qua X-Forwarded-For (rate limit theo IP, vnp_IpAddr, IP băm trong audit — T-034).
# Danh sách IP/CIDR (v4/v6) hoặc từ khoá loopback|private|linklocal, phẩy; `none` = không tin proxy nào. Vắng (dev/test)
# = không tin header nào: IP = địa chỉ socket. Production BẮT BUỘC khai: phải gồm LB/CDN phía trước backend VÀ địa chỉ
# storefront (storefront gọi backend từ server) — thiếu storefront thì mọi khách dùng chung IP của storefront trong rate
# limit (nghẽn toàn site). Request từ chính proxy tin cậy mà không có khách đứng sau (vd. storefront nạp catalog đã cache)
# được miễn giới hạn theo IP; giới hạn theo giỏ/mã/SĐT vẫn áp. IPv6 được gộp theo /64 khi đếm.
XS_TRUSTED_PROXIES=10.0.0.0/8
# Gốc URL storefront để dựng liên kết gửi khách — hiện là liên kết tra cứu đơn `<gốc>/tra-cuu-don/xac-thuc?token=…`
# (T-149, D-089): token một lần phát hành LÚC GỬI ở bộ xử lý thông báo, không lưu trong outbox. http(s), không query/
# fragment/thông tin đăng nhập; cho phép tiền tố đường dẫn; `/` cuối bị bỏ. Production BẮT BUỘC và phải https://; vắng
# (dev/test) = http://localhost:3000 (DEV_STOREFRONT_URL trong env/index.ts, cổng mặc định của `next dev`). Giá trị thô có
# khoảng trắng/xuống dòng/tab, `\`, `@`, `?`, `#` bị từ chối lúc khởi động (hay gặp: newline thừa khi tạo từ file/echo);
# gốc dùng thật được chuẩn hoá từ URL đã parse (scheme/host viết thường, bỏ cổng mặc định).
STOREFRONT_URL=https://shop.example.vn
# Webhook vô hiệu hoá cache catalog → storefront (T-142, D-070; docs/ops/CACHE.md). BÍ MẬT, ≥ 32 ký tự ngẫu nhiên (sinh:
# openssl rand -base64 48), PHẢI TRÙNG CATALOG_REVALIDATE_SECRET của storefront. Vắng = tắt: không ghi outbox, storefront
# chỉ hết hạn theo TTL 60 giây (đường lùi của D-070). Đổi khoá: đặt cùng giá trị mới ở storefront rồi backend (webhook gửi
# trong lúc lệch khoá bị 401 → outbox `dead` + ngoại lệ `outbox_dead`; dữ liệu vẫn tươi lại sau TTL).
# CATALOG_REVALIDATE_SECRET=
# Đích webhook: danh sách ≤ 8 URL http(s) cách dấu phẩy, không thông tin đăng nhập/query/fragment; chỉ đặt khi đã đặt khoá.
# Vắng = `<STOREFRONT_URL>/api/revalidate`. Chạy NHIỀU bản storefront → liệt kê URL nội bộ của TỪNG bản (cache dữ liệu của
# Next nằm trong từng tiến trình; gửi qua LB chỉ tới một bản).
# CATALOG_REVALIDATE_URLS=http://storefront-1:3000/api/revalidate,http://storefront-2:3000/api/revalidate
# Thư mục file PRIVATE của File Module (T-141, BE-FILE-005): xuất khách hàng/đơn (PII), xuất tồn/sản phẩm, chunk nhập sản
# phẩm. Phải RỜI thư mục công khai `static/` (Express phục vụ `/static`) — không trùng, không nằm trong, không chứa nó; không
# ký tự điều khiển. Production BẮT BUỘC, đường dẫn tuyệt đối trên volume bền, chỉ user chạy backend đọc/ghi được (vd.
# `install -d -m 700`); vắng (dev/test) = `<cwd>/private-uploads` (đã gitignore). Sai → in tên biến, thoát mã 1. File
# private KHÔNG có URL công khai: chỉ tải qua `GET /admin/x/files/<khoá>` (đăng nhập admin + `settings.manage` + MFA, ghi
# audit `data.accessed`); link trong thông báo xuất của Medusa trỏ về route này. Ảnh sản phẩm vẫn ở `static/` như cũ.
# Đổi thư mục = file cũ không còn tải được (chuyển file sang thư mục mới trước). Server và worker phải thấy CÙNG thư mục
# (worker ghi file xuất, server phục vụ) — nhiều máy: dùng chung volume hoặc chờ kho S3-compatible (T-154).
# Nâng cấp từ bản trước T-141: file `static/private-*` cũ VẪN công khai — chuyển sang thư mục này rồi xoá khỏi `static/`.
# Lúc khởi động provider: chưa có → tạo với quyền 700; có sẵn mà mở quyền group/other, KHÔNG thuộc user chạy backend
# (euid), hoặc user đó không đọc/ghi/duyệt được → TỪ CHỐI khởi động (không tự chmod/chown — sửa `chmod 700`/`chown`); kiểm
# rời `static/` cả sau khi theo symlink (`realpath`), đường dẫn thật được ghim lúc khởi động. File private ghi ra quyền 600.
# Thư mục dev cũ tạo trước bản này có thể là 755 → `chmod 700 apps/backend/private-uploads` (hoặc xoá).
# Triển khai: MỌI tiến trình dựng File Module phải thấy cùng volume và cùng giá trị biến — server, worker, script
# `medusa exec` (`seed`, `seed:catalog`, `rbac:grant-owner`, `catalog:reindex`) và cả `medusa db:migrate` (đã kiểm
# 2026-10-27 qua `pnpm check:schema`: migrate dựng provider và tạo thư mục). Thiếu volume ở job migrate/script → thư mục
# bị tạo trên đĩa tạm của container (vô hại nhưng gây nhầm) hoặc lỗi quyền làm job dừng.
# Trỏ biến vào THƯ MỤC CON trong volume (vd. volume gắn ở `/var/lib/xshop`, biến = `/var/lib/xshop/private-uploads`) để
# provider tự tạo với quyền 700 và đúng chủ. KHÔNG trỏ thẳng vào điểm mount: điểm mount Docker thường thuộc root quyền 755,
# volume Kubernetes có `fsGroup` mở quyền group (2770/775) → backend từ chối khởi động.
PRIVATE_UPLOAD_DIR=/var/lib/xshop/private-uploads
# Tùy chọn
# MEDUSA_BACKEND_URL=http://localhost:9000
# MEDUSA_WORKER_MODE=shared   # shared | server | worker (production tách server và worker)
# DISABLE_MEDUSA_ADMIN=false
# Tắt êm (T-094): SIGTERM → /x/readyz 503 trong DRAIN_DELAY (vẫn phục vụ) → đóng listener, chờ request/job dở, đóng pool
# Postgres/Redis → thoát 0. Quá TIMEOUT (tính từ SIGTERM) → thoát mã 1. TIMEOUT phải < grace period của nền tảng
# (Kubernetes terminationGracePeriodSeconds mặc định 30 s); DRAIN_DELAY < TIMEOUT.
# SHUTDOWN_DRAIN_DELAY_MS=5000   # vắng: 5000 ở production, 0 ở dev/test; [0, 60000]
# SHUTDOWN_TIMEOUT_MS=25000      # [1000, 300000]
# Log (T-090): JSON một dòng/stdout, đã che bí mật + PII. Ngưỡng: error|warn|info|http|verbose|debug|silly; vắng = info.
# LOG_LEVEL=info
# Mặc định an toàn (T-098, BASE-CFG-007, BASE-SEC-010). Bind: scripts `dev`/`start` của backend VÀ storefront chạy `medusa|next … -H "${HOST:-127.0.0.1}"` —
# vắng HOST = chỉ loopback (trước đây Node nghe mọi giao diện). Container/sau LB phải ĐẶT `HOST=0.0.0.0` tường minh (và
# không publish cổng DB/Redis); tên máy hoặc IP, không kèm cổng (cổng = `-p`). DEBUG: vắng/false/0 = tắt; bật ở dev
# (true/1/namespace) được; NODE_ENV=production + DEBUG bật → từ chối khởi động.
# Xem cấu hình hiệu lực đã che (không cần DB chạy): pnpm --filter @x-shop/backend config:print
# HOST=127.0.0.1
# DEBUG=false
# Che bí mật khi in cấu hình (T-098, BASE-CFG-005): `redactConfig`/`formatEffectiveConfig` (src/lib/env/redact.ts); đối
# tượng `Env` (và `ghn`, `vnpay` lồng trong đó) tự che khi JSON.stringify/console.log/util.inspect; `{ ...env }` hay
# Object.entries sao chép GIÁ TRỊ THẬT — nơi dump phải qua `redactConfig`. Trường bí mật rỗng in "(chưa đặt)". Danh sách bí mật `SECRET_ENV_KEYS`: DATABASE_URL, REDIS_URL (có mật
# khẩu), JWT_SECRET, COOKIE_SECRET, AUTH_MFA_ENCRYPTION_KEY, ORDER_LOOKUP_SECRET, VNPAY_HASH_SECRET(_PREVIOUS), GHN_TOKEN,
# CATALOG_REVALIDATE_SECRET.
# Thêm biến bí mật mới → thêm vào danh sách. Hàng rào test duyệt MỌI khoá của schema (cả biến optional vắng mặt): tên
# giống bí mật (secret/token/password/…/_KEY) hoặc `*_URL` chưa xếp vào "bí mật" hay danh sách URL đã xác minh không
# chứa user:pass → test đỏ.

# VNPAY (SPEC-payment). Bật mặc định (VNPAY_ENABLED=true). Production + bật → BẮT BUỘC đủ 5 biến dưới, URL phải https,
# không được dùng khoá giả của dev. Dev/test vắng biến → dùng giá trị GIẢ trong env/index.ts (VNPAY_DEV_DEFAULTS) — chỉ ký/kiểm
# chữ ký cục bộ với MockVnpayGateway, không gọi cổng thật.
# VNPAY_ENABLED=true
# Cách gọi VNPAY từ server (querydr): mock = cổng giả lập cục bộ (mặc định dev/test) · sandbox | live = HTTP tới
# VNPAY_API_URL. Production + bật: BẮT BUỘC khai rõ sandbox|live, không được mock.
VNPAY_MODE=sandbox
VNPAY_TMN_CODE=MAMERCHANT          # mã website do VNPAY cấp (chữ/số, ≤ 32 ký tự)
VNPAY_HASH_SECRET=thay-bang-khoa-bi-mat-vnpay-it-nhat-32-ky-tu   # ≥ 32 ký tự (độ dài thật: chưa xác minh với tài liệu merchant)
# Xoay khoá (T-099): khoá TRƯỚC, chỉ dùng XÁC MINH chữ ký IPN/return/querydr trong cửa sổ xoay; ký gửi đi luôn bằng
# VNPAY_HASH_SECRET. ≥ 32 ký tự, khác khoá hiện tại, chỉ đặt khi đã đặt VNPAY_HASH_SECRET. Bỏ khi hết cửa sổ (RUNBOOK §9).
# VNPAY_HASH_SECRET_PREVIOUS=
VNPAY_PAYMENT_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNPAY_API_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
VNPAY_RETURN_URL=https://shop.example.vn/thanh-toan/ket-qua

# GHN — giao vận (T-026, SPEC-fulfillment). mock = GHN giả lập cục bộ (mặc định dev/test, biểu phí P0 cố định) ·
# sandbox | live = HTTP tới GHN_BASE_URL. sandbox|live → BẮT BUỘC đủ GHN_BASE_URL, GHN_TOKEN, GHN_SHOP_ID. Production:
# BẮT BUỘC khai rõ GHN_MODE=sandbox|live (không được mock), URL phải https. Token CHỈ ở server (header `Token`).
# Đường dẫn API/URL sandbox: CHƯA XÁC MINH với tài liệu GHN (developer.ghn.vn 403 lúc nghiên cứu) — đối chiếu khi có khoá.
# Callback: cấu hình ở GHN trỏ về POST <MEDUSA_BACKEND_URL>/x/webhooks/shipping/ghn (không chữ ký — hệ thống tra lại API).
GHN_MODE=sandbox
GHN_BASE_URL=https://dev-online-gateway.ghn.vn/shiip/public-api   # (chưa xác minh)
GHN_TOKEN=thay-bang-token-ghn
GHN_SHOP_ID=123456
```

Thời hạn checkout (báo giá 10 phút, giữ hàng online 15 phút, xác nhận COD 24 giờ, lease attempt 2 phút, chờ khóa 15 giây)
là hằng cấu hình trong `apps/backend/src/lib/checkout/config.ts` (D-002) — không phải biến môi trường. Hạn báo phí GHN
(10 phút) và hạn chờ mỗi lời gọi GHN (10 giây) ở `apps/backend/src/lib/shipping/config.ts`.

`medusa build` nạp config nên cần `DATABASE_URL` dù không kết nối — build image truyền URL giả (D-007).

## Storefront (`apps/storefront/.env`)
```dotenv
NEXT_PUBLIC_SITE_URL=http://localhost:3000
# Publishable key do seed tạo ("Storefront x-shop") — công khai theo thiết kế của Medusa.
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=
# CÔNG KHAI (schema client, T-098): none | beacon; vắng = none. beacon = `track()` gửi sendBeacon tới /api/analytics khi
# người dùng đã đồng ý. Giá trị khác → getClientEnv() ném lỗi (layout/proxy không lên); `track()` thì coi như none.
# NEXT_PUBLIC_ANALYTICS_TRANSPORT=none
# Bind (BASE-SEC-010): `next dev`/`next start` chạy với -H "${HOST:-127.0.0.1}" (mặc định của Next là 0.0.0.0). Sau LB/
# container đặt HOST=0.0.0.0 tường minh. E2E (playwright) gọi thẳng `next start -p` nên không bị ảnh hưởng.
# HOST=127.0.0.1
# Chỉ server.
MEDUSA_BACKEND_URL=http://localhost:9000
# Nguồn dữ liệu catalog: backend | fixtures. Bỏ trống → `backend` nếu MEDUSA_BACKEND_URL được đặt thật,
# ngược lại `fixtures` (bộ demo cục bộ trong src/lib/catalog/fixtures.ts + ảnh SVG ở public/demo/).
# XS_DATA_SOURCE=fixtures
# true = storefront đứng sau proxy tin cậy (LB/CDN) đặt x-real-ip / x-forwarded-for → chuyển tiếp IP khách cho rate limit
# của backend. Vắng/false = không tin (client gọi thẳng tự khai được): không chuyển tiếp IP (T-034).
# XS_TRUST_PROXY_HEADERS=false
# BÍ MẬT (chỉ server, `SECRET_SERVER_ENV_KEYS` trong src/lib/env — T-098): khoá HMAC của webhook `/api/revalidate` (T-142),
# ≥ 32 ký tự, TRÙNG CATALOG_REVALIDATE_SECRET của backend. Vắng = route trả 503, cache catalog chỉ theo TTL. Sai độ dài →
# getServerEnv() ném lỗi nêu tên biến (không in giá trị). Không bao giờ đặt tiền tố NEXT_PUBLIC_.
# CATALOG_REVALIDATE_SECRET=
```

Bảo mật HTTP (T-034, không phải biến môi trường): ngưỡng rate limit ở `apps/backend/src/lib/security/rate-limit.ts`
(`STORE_RATE_LIMITS`) và `apps/backend/src/lib/orders/rate-limit.ts`; giới hạn upload ở `apps/backend/src/lib/security/upload.ts`
(`UPLOAD_LIMITS`); CSP storefront ở `apps/storefront/src/lib/security/csp.ts` (nonce mỗi request qua `src/proxy.ts`).
Chỉ tiền tố `NEXT_PUBLIC_` vào bundle client; bí mật không bao giờ có tiền tố này (BASE-CFG-008).

## Quản trị: vai trò, MFA, phiên (T-023/T-024)
- Owner đầu tiên: tạo admin (`medusa user -e <email>` hoặc lời mời) rồi chạy trên máy chủ
  `pnpm --filter @x-shop/backend rbac:grant-owner <email>` — không có route công khai để tự cấp owner.
- Mọi route `/admin/*` đi qua `src/lib/admin-security/guard.ts`: quyền theo `src/api/admin/x/permissions.ts` (route
  `/admin/x/*`, không khai báo = 403) và `src/lib/admin-security/native-permissions.ts` (route native). Quyền nhạy cảm
  (`user.manage`, `refund.*`, `settings.manage`, `customer.export`, `settlement.import`) đòi TOTP đã bật + đã xác minh
  trong phiên. Trạng thái nhàn rỗi phiên và bộ đếm rate limit đăng nhập/MFA nằm trong Redis (`REDIS_URL`, tiền tố
  `xs:sec:`), không lưu email/IP thô.

## Dữ liệu staging / preview / dev

Chỉ dùng dữ liệu tổng hợp; **cấm** copy hoặc khôi phục dữ liệu production (PII khách, đơn, log) vào staging, preview hay máy dev. Nguồn được phép:
`apps/backend/src/scripts/seed*.ts`, `scripts/ops/drill/seed-*.sql`, `scripts/load/dataset.mjs`. Chi tiết và việc còn thiếu (môi trường staging,
script ẩn danh hoá/quét PII): `docs/ops/RUNBOOK.md` §11. Xoay và xử lý lộ từng biến bí mật ở trên: RUNBOOK §9–§10.
