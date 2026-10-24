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
# Origin http(s) hoặc /regex/, phẩy, không đường dẫn.
STORE_CORS=http://localhost:3000
ADMIN_CORS=http://localhost:5173,http://localhost:9000
AUTH_CORS=http://localhost:5173,http://localhost:9000,http://localhost:3000
# Tùy chọn
# MEDUSA_BACKEND_URL=http://localhost:9000
# MEDUSA_WORKER_MODE=shared   # shared | server | worker (production tách server và worker)
# DISABLE_MEDUSA_ADMIN=false

# VNPAY (SPEC-payment). Bật mặc định (VNPAY_ENABLED=true). Production + bật → BẮT BUỘC đủ 5 biến dưới, URL phải https,
# không được dùng khoá giả của dev. Dev/test vắng biến → dùng giá trị GIẢ trong env.ts (VNPAY_DEV_DEFAULTS) — chỉ ký/kiểm
# chữ ký cục bộ với MockVnpayGateway, không gọi cổng thật.
# VNPAY_ENABLED=true
VNPAY_TMN_CODE=MAMERCHANT          # mã website do VNPAY cấp (chữ/số, ≤ 32 ký tự)
VNPAY_HASH_SECRET=thay-bang-khoa-bi-mat-vnpay-it-nhat-32-ky-tu   # ≥ 32 ký tự (độ dài thật: chưa xác minh với tài liệu merchant)
VNPAY_PAYMENT_URL=https://sandbox.vnpayment.vn/paymentv2/vpcpay.html
VNPAY_API_URL=https://sandbox.vnpayment.vn/merchant_webapi/api/transaction
VNPAY_RETURN_URL=https://shop.example.vn/thanh-toan/ket-qua
```

Thời hạn checkout (báo giá 10 phút, giữ hàng online 15 phút, xác nhận COD 24 giờ, lease attempt 2 phút, chờ khóa 15 giây)
là hằng cấu hình trong `apps/backend/src/lib/checkout/config.ts` (D-002) — không phải biến môi trường.

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
```
Chỉ tiền tố `NEXT_PUBLIC_` vào bundle client; bí mật không bao giờ có tiền tố này (BASE-CFG-008).

## Quản trị: vai trò, MFA, phiên (T-023/T-024)
- Owner đầu tiên: tạo admin (`medusa user -e <email>` hoặc lời mời) rồi chạy trên máy chủ
  `pnpm --filter @x-shop/backend rbac:grant-owner <email>` — không có route công khai để tự cấp owner.
- Mọi route `/admin/*` đi qua `src/lib/admin-security/guard.ts`: quyền theo `src/api/admin/x/permissions.ts` (route
  `/admin/x/*`, không khai báo = 403) và `src/lib/admin-security/native-permissions.ts` (route native). Quyền nhạy cảm
  (`user.manage`, `refund.*`, `settings.manage`, `customer.export`, `settlement.import`) đòi TOTP đã bật + đã xác minh
  trong phiên. Trạng thái nhàn rỗi phiên và bộ đếm rate limit đăng nhập/MFA nằm trong Redis (`REDIS_URL`, tiền tố
  `xs:sec:`), không lưu email/IP thô.
