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
# Vai trò migration (T-184, DB-SEC-002) — tuỳ chọn, vắng = DATABASE_URL. CHỈ lệnh `medusa db:*` (migrate, rollback,
# sync-links, setup…) kết nối bằng URL này; server/worker/`medusa exec` dùng DATABASE_URL. Phải cùng máy chủ/cổng/database
# với DATABASE_URL (chỉ khác vai trò) — lệch thì từ chối khởi động. Production: DATABASE_URL = xshop_app (chỉ DML),
# MIGRATION_DATABASE_URL = xshop_migrator (owner/DDL). Xem mục "Vai trò DB" bên dưới.
# MIGRATION_DATABASE_URL=postgres://xshop_migrator:xshop-migrator-dev-SENTINEL@localhost:5432/xshop
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
# openssl rand -base64 48), PHẢI TRÙNG CATALOG_REVALIDATE_SECRET của storefront. Production BẮT BUỘC (thiếu → in tên biến,
# thoát mã 1) trừ khi tắt tường minh CATALOG_REVALIDATE_ENABLED=false (đường lùi D-070: không ghi outbox, storefront chỉ hết
# hạn theo TTL 60 giây, backend in CẢNH BÁO lúc khởi động). Dev/test vắng khoá = tắt. Đổi khoá: RUNBOOK §9 (webhook gửi
# trong lúc lệch khoá bị 401 → outbox `dead` + MỘT ngoại lệ `outbox_dead` đang mở; dữ liệu vẫn tươi lại sau TTL).
# CATALOG_REVALIDATE_ENABLED=true
CATALOG_REVALIDATE_SECRET=thay-bang-chuoi-ngau-nhien-it-nhat-32-ky-tu-revalidate
# Đích webhook: danh sách ≤ 8 URL http(s) cách dấu phẩy (production: https), không thông tin đăng nhập/query/fragment; chỉ
# đặt khi đã đặt khoá. Vắng = `<STOREFRONT_URL>/api/revalidate`. Chạy NHIỀU bản storefront → liệt kê URL nội bộ của TỪNG bản (cache dữ liệu của
# Next nằm trong từng tiến trình; gửi qua LB chỉ tới một bản).
# CATALOG_REVALIDATE_URLS=https://sf-1.internal.example.vn/api/revalidate,https://sf-2.internal.example.vn/api/revalidate
# Kho file của File Module (T-154, ARC-RES-005): local | s3.
#  - local = đĩa của MÁY ĐANG CHẠY (`static/` công khai + PRIVATE_UPLOAD_DIR). Ảnh upload ở bản sao A KHÔNG có ở bản sao B;
#    file xuất do worker ghi KHÔNG tải được qua server ở máy khác. Chỉ dev/test một tiến trình — mặc định khi vắng ở dev/test
#    (provider in cảnh báo lúc khởi động). Production đặt local → backend từ chối khởi động.
#  - s3 = kho S3-compatible DÙNG CHUNG giữa mọi bản sao (server, worker, script). BẮT BUỘC ở production (vắng → thoát mã 1).
# Đặt bất kỳ biến S3_* nào mà FILE_STORAGE không phải s3 → lỗi (tránh tưởng đã dùng kho chung trong khi file vẫn ở đĩa máy).
FILE_STORAGE=s3
# Hai bucket RỜI nhau, cùng một khoá truy cập (chỉ quyền đọc/ghi/xoá object trên đúng hai bucket này):
#  - S3_BUCKET (công khai): ảnh sản phẩm/nội dung (`POST /admin/uploads`). Cho đọc NẶC DANH bằng POLICY của bucket
#    (s3:GetObject cho `*`, hoặc website endpoint/CDN của kho) — provider KHÔNG gửi ACL theo object (AWS mặc định chặn ACL).
#  - S3_PRIVATE_BUCKET: xuất khách hàng/đơn (PII), xuất tồn/sản phẩm, chunk nhập (T-141). KHÔNG policy đọc nặc danh, KHÔNG
#    website/CDN; file chỉ tải qua `GET /admin/x/files/<khoá>` (phiên + `settings.manage` + MFA, audit) — URL trả ra luôn là
#    route này, không URL ký, không URL bucket. Phải khác S3_BUCKET; S3_FILE_URL trỏ vào bucket này → từ chối khởi động.
# Tên bucket: a-z, 0-9, `.`, `-`, 3–63 ký tự. Khoá object do server sinh (`[private-]<ms>-<ULID><đuôi>`), không có tên client.
# S3_ENDPOINT: gốc URL kho tự host (không đường dẫn); vắng = AWS S3 theo S3_REGION. Production: https://.
# S3_REGION: mã vùng (AWS: vd. ap-southeast-1; Cloudflare R2: auto; kho tự host: theo cấu hình kho, vd. garage / us-east-1).
# S3_FILE_URL: gốc URL CÔNG KHAI của S3_BUCKET mà trình duyệt tải ảnh (CDN, website endpoint, hoặc `<endpoint>/<bucket>`);
#   http(s), không query/fragment/thông tin đăng nhập, `/` cuối bị bỏ. Production: https://. URL ảnh = `<S3_FILE_URL>/<khoá>`.
# S3_FORCE_PATH_STYLE: true|false; vắng → true khi có S3_ENDPOINT (kho tự host thường cần), false khi dùng AWS.
# Production + s3 → MEDUSA_BACKEND_URL BẮT BUỘC và https (URL tải file private trong thông báo xuất dựng từ đây; thiếu = trỏ
# localhost). Khoá truy cập cần cả `s3:ListBucket` trên hai bucket (thiếu → khoá không có trả 403 → route tải private 500).
# Mọi lời gọi kho có hạn (S3_TIMEOUTS, src/lib/infra/timeouts.ts) — không phải biến môi trường.
# Kho tự host đề xuất (chủ dự án chọn; MinIO bản cộng đồng đã ngừng bảo trì — xem RUNBOOK §8.2b): Garage (AGPL-3.0) hoặc
# SeaweedFS (Apache-2.0), chạy như DỊCH VỤ RIÊNG, không nhúng/sửa mã.
S3_ENDPOINT=https://s3.shop.example.vn
S3_REGION=garage
S3_BUCKET=xshop-public
S3_PRIVATE_BUCKET=xshop-private
S3_FILE_URL=https://media.shop.example.vn
# Bí mật (che khi in cấu hình). Ký tự in được, không khoảng trắng; ID 3–256, secret 8–256 ký tự. Xoay: RUNBOOK §9.
S3_ACCESS_KEY_ID=thay-bang-access-key-id
S3_SECRET_ACCESS_KEY=thay-bang-secret-access-key
# S3_FORCE_PATH_STYLE=true
# Thư mục file PRIVATE của File Module (T-141, BE-FILE-005): xuất khách hàng/đơn (PII), xuất tồn/sản phẩm, chunk nhập sản
# phẩm. Phải RỜI thư mục công khai `static/` (Express phục vụ `/static`) — không trùng, không nằm trong, không chứa nó; không
# ký tự điều khiển. CHỈ dùng khi FILE_STORAGE=local (dev/test — T-154): production dùng S3_PRIVATE_BUCKET; đặt biến này
# kèm FILE_STORAGE=s3 → từ chối khởi động. Vắng (dev/test) = `<cwd>/private-uploads` (đã gitignore). Sai → in tên biến,
# thoát mã 1. Các ghi chú triển khai volume bên dưới chỉ còn áp cho môi trường một máy chạy local. File
# private KHÔNG có URL công khai: chỉ tải qua `GET /admin/x/files/<khoá>` (đăng nhập admin + `settings.manage` + MFA, ghi
# audit `data.accessed`); link trong thông báo xuất của Medusa trỏ về route này. Ảnh sản phẩm vẫn ở `static/` như cũ.
# Đổi thư mục = file cũ không còn tải được (chuyển file sang thư mục mới trước). Server và worker phải thấy CÙNG thư mục
# (worker ghi file xuất, server phục vụ) — nhiều máy: FILE_STORAGE=s3 (T-154).
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
# PRIVATE_UPLOAD_DIR=/var/lib/xshop/private-uploads   # chỉ khi FILE_STORAGE=local
# Gốc URL backend (dashboard, URL route tải file private). Tùy chọn ở dev; BẮT BUỘC khi production + FILE_STORAGE=s3.
MEDUSA_BACKEND_URL=https://api.shop.example.vn
# Tùy chọn
# MEDUSA_WORKER_MODE=shared   # shared | server | worker (production tách server và worker)
# DISABLE_MEDUSA_ADMIN=false
# Tắt êm (T-094): SIGTERM → /x/readyz 503 trong DRAIN_DELAY (vẫn phục vụ) → đóng listener, chờ request/job dở, đóng pool
# Postgres/Redis → thoát 0. Quá TIMEOUT (tính từ SIGTERM) → thoát mã 1. TIMEOUT phải < grace period của nền tảng
# (Kubernetes terminationGracePeriodSeconds mặc định 30 s); DRAIN_DELAY < TIMEOUT.
# SHUTDOWN_DRAIN_DELAY_MS=5000   # vắng: 5000 ở production, 0 ở dev/test; [0, 60000]
# SHUTDOWN_TIMEOUT_MS=25000      # [1000, 300000]
# Pool Postgres MỖI tiến trình (T-092, DB-PERF-004; docs/db/connections.md): tổng DB_POOL_MAX × số tiến trình + dự phòng ≤
# max_connections của Postgres. statement_timeout của phiên ứng dụng (mili giây); migration dài → nâng tạm cho lệnh migrate.
# DB_POOL_MAX=10                 # kết nối; [1, 100]
# DB_STATEMENT_TIMEOUT_MS=30000  # [1000, 3600000]
# CHỈ TEST (không qua schema, không đặt ở production): tiền tố khoá Redis của rate limit admin để các lần chạy test tích hợp
# dùng chung một Redis không rò bộ đếm sang nhau (apps/backend/src/lib/admin-security/store.ts).
# XS_SECURITY_KEY_NAMESPACE=it-local
# BIẾN CỦA NODE/LIBUV (không qua schema): số luồng thread pool libuv, mặc định 4, [1, 1024]. Phải đặt ở env THẬT của tiến
# trình (Dockerfile/systemd/k8s), KHÔNG đặt trong .env — libuv đọc lúc tạo thread pool, trước khi Medusa nạp .env. Trần
# scrypt đồng thời của đăng nhập admin = max(1, giá trị − 1) (lib/admin-security/scrypt-gate.ts, ADR-0006): tăng giá trị
# thì bộ nhớ đỉnh tăng ≈ 128 MiB mỗi luồng scrypt thêm — định cỡ container theo đó.
# UV_THREADPOOL_SIZE=4
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
# CATALOG_REVALIDATE_SECRET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY (đối tượng `fileStorage` lồng trong Env cũng tự che).
# Thêm biến bí mật mới → thêm vào danh sách. Hàng rào test duyệt MỌI khoá của schema (cả biến optional vắng mặt): tên
# giống bí mật (secret/token/password/…/_KEY) hoặc `*_URL` chưa xếp vào "bí mật" hay danh sách URL đã xác minh không
# chứa user:pass → test đỏ.

# VNPAY (SPEC-payment). Bật mặc định (VNPAY_ENABLED=true). Production + bật → BẮT BUỘC đủ 5 biến dưới, URL phải https,
# không được dùng khoá giả của dev. Dev/test vắng biến → dùng giá trị GIẢ trong env/index.ts (VNPAY_DEV_DEFAULTS) — chỉ ký/kiểm
# chữ ký cục bộ với MockVnpayGateway, không gọi cổng thật.
# VNPAY_ENABLED=false (T-166) CHỈ chặn tạo thanh toán VNPAY mới: GIỮ VNPAY_TMN_CODE + VNPAY_HASH_SECRET để IPN của giao dịch
# đã tạo vẫn xác minh được (thiếu khoá → IPN trả 99, không ghi nhận); đơn đang chờ được giữ hàng, không bị hủy (RUNBOOK §1).
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

### Vai trò DB (T-184, Q-02, D-138 — DB-SEC-002, DB-PERF-005)

| Vai trò | Thuộc tính | Quyền trên DB | Dùng ở |
|---|---|---|---|
| `xshop_app` | LOGIN; không SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS | `SELECT/INSERT/UPDATE/DELETE` bảng `public` (bảng sổ migration `mikro_orm_migrations`, `script_migrations`, `link_module_migrations`: CHỈ `SELECT`), `USAGE/SELECT` sequence; không CREATE/owner/TRUNCATE | `DATABASE_URL` (server, worker) |
| `xshop_migrator` | LOGIN; không SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS; membership `xshop_app` chỉ `SET` (không ADMIN, không INHERIT) | owner/DDL của DB do hạ tầng giao | `MIGRATION_DATABASE_URL` (`medusa db:*`) |

- `xshop_migrator` không có CREATEROLE/ADMIN OPTION (review T-184): không tạo được vai trò, không đổi mật khẩu/thuộc tính/
  membership của `xshop_app`. Membership `SET` chỉ để migration chạy `ALTER ROLE xshop_app SET <timeout>` dưới chính
  `xshop_app` (vai trò thường tự đặt mặc định của nó được). Hệ quả còn lại: qua `SET ROLE xshop_app`, migrator làm được mọi
  việc `xshop_app` làm được — kể cả đổi mật khẩu của nó (không lấy thêm dữ liệu: migrator đã là owner).
- Thứ tự production (RUNBOOK §8.2): hạ tầng tạo hai vai trò + mật khẩu (kho bí mật) TRƯỚC lần `medusa db:migrate` đầu. Migration
  `Migration20261029120000` (module checkout) đặt trên MỖI DB được migrate: GRANT DML + default privileges, thu hồi ghi bảng
  sổ đang có, `ALTER ROLE xshop_app SET statement_timeout = '30s'`, `idle_in_transaction_session_timeout = '60s'` (khớp
  `DB_STATEMENT_TIMEOUT_MS` mặc định và `DB_TIMEOUTS`). Cuối `db:migrate`, migration script
  `src/migration-scripts/app-role-bookkeeping-readonly.ts` thu hồi ghi trên bảng sổ tạo SAU migration module (link sync, runner
  script) — chạy một lần.
- Vai trò tạo SAU lần migrate đầu (migration/script đã ghi là chạy, chỉ để lại `WARNING` trong log), hoặc DB đã chạy
  `db:migrate --skip-links`/`--skip-scripts` rồi sync link sau: áp lại bằng vai trò migration, lũy đẳng —
  `psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-app-grants.sql`.
- Timeout cấp vai trò là LƯỚI AN TOÀN (mặc định cho mọi phiên đăng nhập bằng `xshop_app`, kể cả psql/job ngoài ứng dụng),
  KHÔNG phải kiểm soát bảo mật: `xshop_app` tự `SET`/`RESET` được trong phiên của nó. Hạn thật của ứng dụng vẫn là
  `DB_STATEMENT_TIMEOUT_MS` + `DB_TIMEOUTS` gửi trong gói startup.
- Dev/CI: `scripts/db-roles.sh` (cấp cluster `scripts/db-roles.sql` + cấp DB `scripts/db-app-grants.sql`, lũy đẳng; sửa luôn vai
  trò do bản trước của script tạo). Máy dev: `bash scripts/dev-services.sh` gọi sẵn; CI: bước "Vai trò DB tách quyền" của
  `ci.yml`. Mật khẩu dev/CI là giá trị GIẢ (`XS_PG_APP_PASSWORD`, `XS_PG_MIGRATOR_PASSWORD`, mặc định chứa `SENTINEL`) —
  production đặt mật khẩu thật qua kho bí mật, không qua script.
- Máy dev mặc định VẪN dùng `xshop` (superuser) cho cả hai URL (D-138: tách vai trò là opt-in): test tích hợp và các script
  tạo DB tạm cần quyền tạo DB, và DB dev cũ do `xshop` sở hữu nên `xshop_migrator` không ALTER được bảng của nó. Chạy thử ứng
  dụng bằng vai trò hẹp trên DB dev đã migrate: `DATABASE_URL=postgres://xshop_app:xshop-app-dev-SENTINEL@localhost:5432/xshop`
  (giữ migrate bằng `xshop`). Test kiểm: `pnpm --filter @x-shop/backend test:integration -- db-roles`.

Test tích hợp `upload` (T-154, `apps/backend/integration-tests/http/upload-shared-storage.spec.ts`) mặc định dùng kho S3 giả
trong tiến trình (CI không cần dịch vụ thêm). Giới hạn của kho giả: không multipart (file > 5 MiB qua stream thất bại), không kiểm
chữ ký SigV4, không policy/ACL thật — xanh trên kho giả KHÔNG đủ để tick BE-FILE-004/ARC-RES-005. Chạy cùng suite với kho thật (bucket đã tạo; bucket công khai cho đọc nặc danh,
bucket private thì không):

```bash
XS_TEST_S3_ENDPOINT=http://127.0.0.1:3900 XS_TEST_S3_REGION=garage \
XS_TEST_S3_ACCESS_KEY_ID=<id> XS_TEST_S3_SECRET_ACCESS_KEY=<secret> \
XS_TEST_S3_BUCKET=xshop-it-public XS_TEST_S3_PRIVATE_BUCKET=xshop-it-private \
XS_TEST_S3_FILE_URL=<gốc URL công khai của bucket công khai> \
pnpm --filter @x-shop/backend test:integration -- upload
```

## Storefront (`apps/storefront/.env`)
```dotenv
NEXT_PUBLIC_SITE_URL=http://localhost:3000
# Publishable key do seed tạo ("Storefront x-shop") — công khai theo thiết kế của Medusa.
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=
# CÔNG KHAI (schema client, T-098): none | beacon; vắng = none. beacon = `track()` gửi sendBeacon tới /api/analytics khi
# người dùng đã đồng ý. Giá trị khác → getClientEnv() ném lỗi (layout/proxy không lên); `track()` thì coi như none.
# NEXT_PUBLIC_ANALYTICS_TRANSPORT=none
# CÔNG KHAI (schema client, D-131): origin cổng thanh toán bổ sung ngoài allowlist https VNPAY, phân tách dấu phẩy, so khớp
# chính xác scheme+host+port. CHỈ dev/E2E (cổng giả lập, vd. http://localhost:3300); e2e/env.mjs đặt sẵn. Chỉ nhận origin
# http/localhost khi NEXT_PUBLIC_SITE_URL cũng là localhost; triển khai thật có origin http/localhost → getClientEnv() ném lỗi.
# NEXT_PUBLIC_VNPAY_EXTRA_ORIGINS=
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
# Gốc URL ảnh của kho dùng chung (T-154) = S3_FILE_URL của backend. Chỉ server; ĐỌC LÚC `next build` (images.remotePatterns
# đóng vào bản build — đổi = build lại). http(s), không query/fragment/thông tin đăng nhập; production phải https:// (sai →
# build/start dừng, nêu tên biến). Vắng = chỉ ảnh `<MEDUSA_BACKEND_URL>/static/**` (backend FILE_STORAGE=local — dev).
# XS_MEDIA_URL=https://media.shop.example.vn
```

Bảo mật HTTP (T-034, không phải biến môi trường): ngưỡng rate limit ở `apps/backend/src/lib/security/rate-limit.ts`
(`STORE_RATE_LIMITS`) và `apps/backend/src/lib/orders/rate-limit.ts`; giới hạn upload ở `apps/backend/src/lib/security/upload.ts`
(`UPLOAD_LIMITS`); CSP storefront ở `apps/storefront/src/lib/security/csp.ts` (nonce mỗi request qua `src/proxy.ts`).
Chỉ tiền tố `NEXT_PUBLIC_` vào bundle client; bí mật không bao giờ có tiền tố này (BASE-CFG-008).

## Telemetry của công cụ (PM-RISK-006, T-218)

Biến của Medusa/Next.js, không thuộc schema zod của app (nên không nằm trong khối `dotenv` mà `pnpm check:env-doc` khoá). Đặt ở môi
trường chạy thật (systemd/container/PaaS) và máy dev; CI đã đặt ở `env:` cấp workflow của `.github/workflows/ci.yml`.

| Biến | Giá trị | Áp dụng | Tác dụng | Nguồn xác minh (2026-10-30) |
| --- | --- | --- | --- | --- |
| `MEDUSA_DISABLE_TELEMETRY` | `true` | backend (`medusa start/develop/build`) | Tắt thu thập số liệu ẩn danh của Medusa | https://docs.medusajs.com/learn/resources/usage (bảng env: "Whether to disable analytics data collection"); mã đọc biến: `@medusajs/telemetry` `dist/store.js` |
| `NEXT_TELEMETRY_DISABLED` | `1` | storefront (`next dev/build/start`) | Tắt telemetry ẩn danh của Next.js | https://nextjs.org/telemetry ("opt-out by setting an environment variable: `NEXT_TELEMETRY_DISABLED=1`") |

Không sửa script `start/dev/build` trong `apps/*/package.json`: chúng đã dùng cú pháp shell POSIX (`${HOST:-127.0.0.1}`), và đặt
biến ngay trong script cần `cross-env` (phụ thuộc mới, không thêm trong task này). Cách đặt: xuất biến trong môi trường tiến trình
(`export MEDUSA_DISABLE_TELEMETRY=true NEXT_TELEMETRY_DISABLED=1`) hoặc `.env` cục bộ của từng app (Medusa nạp `.env`; Next đọc
`.env*` cho biến runtime); tách bạch với `next telemetry disable` (ghi cấu hình vào máy dev, không có tác dụng trên CI/container).

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
