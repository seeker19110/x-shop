/**
 * Biến môi trường của logger server (T-190), đọc ở đây vì mọi `process.env.X` phải nằm trong lib/env/ (FE-BUILD-005).
 * Không bắt buộc, không làm ứng dụng hỏng khi sai: giá trị không hợp lệ rơi về mặc định (logger không được làm sập tiến trình).
 *  - `version`: `npm_package_version` (pnpm/npm đặt khi chạy script) hoặc `undefined`.
 *  - `env`: `NODE_ENV`.
 *  - `level`: `LOG_LEVEL` ∈ trace|debug|info|warn|error|fatal, khác → `undefined` (logger dùng `info`).
 */
export const LOG_LEVEL_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevelName = (typeof LOG_LEVEL_NAMES)[number];

export interface LogEnv {
  version: string | undefined;
  env: string | undefined;
  level: LogLevelName | undefined;
}

export function readLogEnv(): LogEnv {
  const level = process.env.LOG_LEVEL;
  return {
    version: process.env.npm_package_version,
    env: process.env.NODE_ENV,
    level: LOG_LEVEL_NAMES.find((l) => l === level),
  };
}
