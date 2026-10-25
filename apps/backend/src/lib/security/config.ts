import type { MedusaRequest } from "@medusajs/framework/http";
import { parseCorsOrigins } from "@medusajs/framework/utils";
import { parseEnv } from "../env";
import {
  NO_TRUSTED_PROXIES,
  parseTrustedProxies,
  resolveClientIp,
  type ClientIp,
  type TrustedProxies,
} from "./client-ip";

/**
 * Cấu hình bảo mật HTTP đọc từ env (đã kiểm ở medusa-config khi khởi động, docs/ops/ENV.md): proxy tin cậy, danh sách
 * origin cho CSRF (CÙNG nguồn với CORS của Medusa: STORE_CORS/ADMIN_CORS/AUTH_CORS, cùng hàm `parseCorsOrigins`).
 */
export type OriginList = ReadonlyArray<string | RegExp>;

export interface HttpSecurityConfig {
  production: boolean;
  trustedProxies: TrustedProxies;
  origins: { store: OriginList; admin: OriginList; auth: OriginList };
}

let cached: HttpSecurityConfig | null = null;

export function getHttpSecurityConfig(): HttpSecurityConfig {
  if (cached) return cached;
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error("[security] Cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  const env = parsed.env;
  const proxies = parseTrustedProxies(env.XS_TRUSTED_PROXIES);
  cached = {
    production: env.NODE_ENV === "production",
    trustedProxies: proxies.ok ? proxies.value : NO_TRUSTED_PROXIES,
    origins: {
      store: parseCorsOrigins(env.STORE_CORS),
      admin: parseCorsOrigins(env.ADMIN_CORS),
      auth: parseCorsOrigins(env.AUTH_CORS),
    },
  };
  return cached;
}

/** Chỉ cho test: đọc lại env ở lần gọi sau. */
export function resetHttpSecurityConfigForTests(): void {
  cached = null;
}

/** IP khách của request theo `XS_TRUSTED_PROXIES` (không dùng `req.ip` — xem client-ip.ts). */
export function clientIpOf(req: MedusaRequest): ClientIp {
  return resolveClientIp(
    { remoteAddress: req.socket?.remoteAddress, forwardedFor: req.headers["x-forwarded-for"] },
    getHttpSecurityConfig().trustedProxies,
  );
}
