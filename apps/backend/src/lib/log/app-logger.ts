import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../env";
import { createLogger, type AppLogger } from "./logger";

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

export function appLoggerFromEnv(env: Pick<Env, "NODE_ENV" | "LOG_LEVEL">): AppLogger {
  return createLogger({
    service: SERVICE_NAME,
    version: serviceVersion(),
    env: env.NODE_ENV,
    level: env.LOG_LEVEL,
  });
}
