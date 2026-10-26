import { loadEnvOrExit } from "./src/lib/env";
import { installProcessErrorHandlers } from "./src/lib/errors/process";
import { installGracefulShutdown } from "./src/lib/lifecycle/shutdown";

/**
 * Medusa gọi `register()` của file này khi `medusa start` (server và worker), trước khi dựng ứng dụng và TRƯỚC khi gắn
 * handler SIGTERM/SIGINT của nó. Cài:
 *  - handler lỗi cấp tiến trình (T-088, BASE-ERR-002): `unhandledRejection`/`uncaughtException` → log JSON một dòng + thoát
 *    mã 1;
 *  - tắt êm (T-094, BE-REL-004): SIGTERM → readiness 503 → chờ → chuyển cho handler của Medusa (đóng listener, chờ request/
 *    job dở, đóng pool Postgres/Redis, thoát 0) với trần cứng — src/lib/lifecycle/shutdown.ts.
 * Không cài trong test tích hợp (test runner không nạp file này) — Jest tự quản lỗi của nó.
 */
export function register(): void {
  installProcessErrorHandlers();
  installGracefulShutdown(loadEnvOrExit(process.env).shutdown);
}
