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
# Khoá mã hoá bí mật TOTP của Auth Module (MFA admin).
AUTH_MFA_ENCRYPTION_KEY=thay-bang-chuoi-ngau-nhien-it-nhat-32-ky-tu-mfa
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
