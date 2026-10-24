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
```

`medusa build` nạp config nên cần `DATABASE_URL` dù không kết nối — build image truyền URL giả (D-007).

## Storefront (`apps/storefront/.env`)
```dotenv
NEXT_PUBLIC_SITE_URL=http://localhost:3000
# Publishable key do seed tạo ("Storefront x-shop") — công khai theo thiết kế của Medusa.
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=
# Chỉ server.
MEDUSA_BACKEND_URL=http://localhost:9000
```
Chỉ tiền tố `NEXT_PUBLIC_` vào bundle client; bí mật không bao giờ có tiền tố này (BASE-CFG-008).
