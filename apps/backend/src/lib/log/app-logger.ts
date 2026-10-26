import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../env";
import { createLogger, type AppLogger } from "./logger";
import { setLogHashKey } from "./redact";

export const SERVICE_NAME = "x-shop-backend";

/**
 * Phiên bản dịch vụ cho trường `version` của log: `version` trong package.json của backend (mã nguồn: apps/backend/,
 * bản build: .medusa/server/ — `medusa build` chép package.json), không đọc được → biến npm của pnpm → "unknown".
 */
export function serviceVersion(dir: string = join(__dirname, "../../..")): string {
  try {
    const v = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
    if (typeof v === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(v)) return v;
  } catch {
    // không có package.json cạnh mã chạy
  }
  const npm = process.env.npm_package_version;
  return typeof npm === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(npm) ? npm : "unknown";
}

/**
 * Khoá băm ngắn của log dẫn xuất từ COOKIE_SECRET (HMAC với nhãn riêng — không dùng thẳng bí mật cho mục đích khác);
 * dev/test không đặt → khoá dev cố định.
 */
export function appLoggerFromEnv(
  env: Pick<Env, "NODE_ENV" | "LOG_LEVEL"> & { COOKIE_SECRET?: string },
): AppLogger {
  if (env.COOKIE_SECRET !== undefined)
    setLogHashKey(createHmac("sha256", env.COOKIE_SECRET).update("x-shop-log-hash-v1").digest("hex"));
  return createLogger({
    service: SERVICE_NAME,
    version: serviceVersion(),
    env: env.NODE_ENV,
    level: env.LOG_LEVEL,
  });
}
