import { loadEnv } from "@medusajs/framework/utils";
import { renderEffectiveConfig } from "../lib/env";

/**
 * In cấu hình hiệu lực (mặc định + biến môi trường, nạp `.env` như medusa-config), bí mật thay bằng `***`
 * (BASE-CFG-005/007):
 *   pnpm --filter @x-shop/backend config:print
 * Không khởi động Medusa, không cần DB/Redis đang chạy; chỉ cần DATABASE_URL hợp lệ (như lúc khởi động). Sai cấu hình →
 * in tên biến + lý do, thoát mã 1.
 */
loadEnv(process.env.NODE_ENV ?? "development", process.cwd());
try {
  process.stdout.write(`${renderEffectiveConfig(process.env)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
