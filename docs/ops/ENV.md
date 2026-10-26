# Biến môi trường (thay cho `.env.example`)

> Quyền ghi file `.env*` bị chặn trong môi trường agent (bảo vệ bí mật) — danh sách biến được giữ ở đây và trong schema
> zod (`apps/backend/src/lib/env.ts`, `apps/storefront/src/lib/env.ts`) là nguồn chuẩn. Tạo `.env` cục bộ từ các khối dưới
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
# (dev/test vắng → ORDER_LOOKUP_DEV_SECRET trong env.ts). Đổi khoá = mọi phiên đơn/liên kết đang có mất hiệu lực.
ORDER_LOOKUP_SECRET=thay-bang-chuoi-ngau-nhien-it-nhat-32-ky-tu-order
# Proxy tin cậy được phép báo IP khách qua X-Forwarded-For (rate limit theo IP, vnp_IpAddr, IP băm trong audit — T-034).
# Danh sách IP/CIDR (v4/v6) hoặc từ khoá loopback|private|linklocal, phẩy; `none` = không tin proxy nào. Vắng (dev/test)
# = không tin header nào: IP = địa chỉ socket. Production BẮT BUỘC khai: phải gồm LB/CDN phía trước backend VÀ địa chỉ
# storefront (storefront gọi backend từ server) — thiếu storefront thì mọi khách dùng chung IP của storefront trong rate
# limit (nghẽn toàn site). Request từ chính proxy tin cậy mà không có khách đứng sau (vd. storefront nạp catalog đã cache)
# được miễn giới hạn theo IP; giới hạn theo giỏ/mã/SĐT vẫn áp. IPv6 được gộp theo /64 khi đếm.
XS_TRUSTED_PROXIES=10.0.0.0/8
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

# VNPAY (SPEC-payment). Bật mặc định (VNPAY_ENABLED=true). Production + bật → BẮT BUỘC đủ 5 biến dưới, URL phải https,
# không được dùng khoá giả của dev. Dev/test vắng biến → dùng giá trị GIẢ trong env.ts (VNPAY_DEV_DEFAULTS) — chỉ ký/kiểm
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
# Chỉ server.
MEDUSA_BACKEND_URL=http://localhost:9000
# Nguồn dữ liệu catalog: backend | fixtures. Bỏ trống → `backend` nếu MEDUSA_BACKEND_URL được đặt thật,
# ngược lại `fixtures` (bộ demo cục bộ trong src/lib/catalog/fixtures.ts + ảnh SVG ở public/demo/).
# XS_DATA_SOURCE=fixtures
# true = storefront đứng sau proxy tin cậy (LB/CDN) đặt x-real-ip / x-forwarded-for → chuyển tiếp IP khách cho rate limit
# của backend. Vắng/false = không tin (client gọi thẳng tự khai được): không chuyển tiếp IP (T-034).
# XS_TRUST_PROXY_HEADERS=false
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
