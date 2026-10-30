import { MetadataStorage } from "@medusajs/framework/mikro-orm/core";

// Mỗi file test nạp lại model MikroORM — xoá metadata cũ để tránh trùng entity giữa các file (mẫu dtc-starter).
MetadataStorage.clear();

// Bộ đếm rate limit/phiên admin (lib/admin-security/store.ts) dùng chung Redis giữa các suite và các lần chạy, cửa sổ
// 15 phút: mỗi file test một namespace riêng để request của suite trước không làm suite sau chạm ngưỡng theo IP.
process.env.XS_SECURITY_KEY_NAMESPACE = `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Test gọi backend qua loopback và giả IP khách bằng `x-forwarded-for` (mỗi ca một IP → bộ đếm theo IP không lẫn). Backend
// chỉ tin header này khi socket là proxy tin cậy (lib/security/client-ip.ts, mặc định không tin) → coi loopback là proxy
// tin cậy trong test. Suite `security` tự đổi giá trị để kiểm cả mặc định.
process.env.XS_TRUSTED_PROXIES ??= "loopback";

// T-146: test tích hợp phải chạy trên Redis DB do globalSetup giành độc quyền (hoặc DB index người gọi ghi sẵn trong
// REDIS_URL). URL không có DB index tức là globalSetup không chạy → chặn sớm thay vì lặng lẽ chạy chung DB 0.
const redisUrl = process.env.REDIS_URL;
if (process.env.TEST_TYPE?.startsWith("integration") === true && redisUrl !== undefined && redisUrl !== "") {
  const path = new URL(redisUrl).pathname;
  if (path === "" || path === "/") {
    throw new Error(
      "REDIS_URL chưa có DB index — globalSetup (integration-tests/global-setup.ts) chưa giành Redis DB test",
    );
  }
}
