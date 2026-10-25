import { MetadataStorage } from "@medusajs/framework/mikro-orm/core";

// Mỗi file test nạp lại model MikroORM — xoá metadata cũ để tránh trùng entity giữa các file (mẫu dtc-starter).
MetadataStorage.clear();

// Bộ đếm rate limit/phiên admin (lib/admin-security/store.ts) dùng chung Redis giữa các suite và các lần chạy, cửa sổ
// 15 phút: mỗi file test một namespace riêng để request của suite trước không làm suite sau chạm ngưỡng theo IP.
process.env.XS_SECURITY_KEY_NAMESPACE = `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
