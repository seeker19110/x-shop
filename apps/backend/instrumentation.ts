import { installProcessErrorHandlers } from "./src/lib/errors/process";

/**
 * Medusa gọi `register()` của file này khi `medusa start` (server và worker), trước khi dựng ứng dụng. Hiện chỉ cài handler
 * lỗi cấp tiến trình (T-088, BASE-ERR-002): `unhandledRejection`/`uncaughtException` → log JSON một dòng + thoát mã 1.
 * Không cài trong test tích hợp (test runner không nạp file này) — Jest tự quản lỗi của nó.
 */
export function register(): void {
  installProcessErrorHandlers();
}
