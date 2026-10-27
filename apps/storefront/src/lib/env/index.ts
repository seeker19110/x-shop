import { z } from "zod";
import { isNonEmpty } from "../presence";
import { mediaUrlSchema } from "./media";
import { ANALYTICS_TRANSPORTS } from "./public";

/**
 * Cấu hình môi trường, validate bằng zod, tách server / client.
 *
 * Cách làm (build không đòi env thật): validate LƯỜI — chỉ chạy khi `getServerEnv()` / `getClientEnv()`
 * được gọi lần đầu, không chạy ở thời điểm import. Mặc định cục bộ (localhost) áp dụng khi
 * không ở chế độ production hoặc đang `next build` (NEXT_PHASE=phase-production-build). Khi chạy production
 * thật (`next start`) thiếu/sai biến → ném lỗi rõ ràng, không dùng mặc định âm thầm.
 * Chỉ biến `NEXT_PUBLIC_*` được phép xuất hiện ở schema client.
 */

const DEFAULTS = {
  NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
  NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: "pk_dev_placeholder",
  MEDUSA_BACKEND_URL: "http://localhost:9000",
} as const;

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), "phải là URL http(s)")
  .transform((v) => v.replace(/\/+$/, ""));

// Phần công khai (không zod) nằm ở ./public để module client nhập được mà không kéo schema/tên biến server vào bundle.
export { ANALYTICS_TRANSPORTS, getAnalyticsTransport, type AnalyticsTransport } from "./public";

/**
 * Schema CLIENT: chỉ biến `NEXT_PUBLIC_*` (Next nhúng giá trị vào bundle trình duyệt lúc build — mọi thứ ở đây là CÔNG
 * KHAI, không bao giờ đặt bí mật). Biến server nằm ở `serverEnvSchema`; test `client-bundle.test.ts` chặn lẫn lộn.
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: httpUrl,
  NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: z.string().trim().min(1, "không được rỗng"),
  /** `beacon` = `track()` gửi sendBeacon tới /api/analytics khi đã đồng ý; vắng = `none` (chỉ dataLayer). */
  NEXT_PUBLIC_ANALYTICS_TRANSPORT: z.enum(ANALYTICS_TRANSPORTS).default("none"),
});

/** Độ dài tối thiểu của bí mật (≈ 256 bit nếu sinh ngẫu nhiên) — khớp MIN_SECRET_LENGTH của backend. */
export const MIN_SECRET_LENGTH = 32;

export const DATA_SOURCES = ["backend", "fixtures"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

export const serverEnvSchema = z.object({
  MEDUSA_BACKEND_URL: httpUrl,
  /** Nguồn dữ liệu catalog. Bỏ trống: `backend` nếu `MEDUSA_BACKEND_URL` được đặt thật, ngược lại `fixtures`. */
  XS_DATA_SOURCE: z.enum(DATA_SOURCES).optional(),
  /**
   * `true` = storefront đứng sau proxy tin cậy (LB/CDN) đặt `x-real-ip`/`x-forwarded-for` → chuyển tiếp IP khách cho rate
   * limit của backend. Vắng/`false` = không tin (client gọi thẳng tự khai được) — lib/security/client-ip.ts.
   */
  XS_TRUST_PROXY_HEADERS: z.enum(["true", "false"]).optional(),
  /**
   * Khoá HMAC chung với backend cho webhook vô hiệu hoá cache catalog (`/api/revalidate`, T-142, D-070). BÍ MẬT, ≥ 32 ký
   * tự. Vắng = route trả 503, cache catalog chỉ hết hạn theo TTL (đường lùi của D-070).
   */
  CATALOG_REVALIDATE_SECRET: z
    .string()
    .min(MIN_SECRET_LENGTH, `phải dài tối thiểu ${MIN_SECRET_LENGTH} ký tự`)
    .optional(),
  /**
   * Gốc URL ảnh của kho dùng chung (= S3_FILE_URL của backend, T-154) — `next.config.ts` mở host này cho `next/image`
   * (src/lib/env/media.ts; production phải https). Vắng = chỉ ảnh `/static/**` của backend (dev).
   */
  XS_MEDIA_URL: mediaUrlSchema.optional(),
});

/**
 * Biến server BÍ MẬT (T-098, SEC-SECRET-007 — cùng vai trò `SECRET_ENV_KEYS` của backend): không bao giờ in/log giá trị.
 * Thêm biến bí mật mới vào schema server → thêm vào đây; `env.test.ts` chặn tên giống bí mật chưa đăng ký.
 */
export const SECRET_SERVER_ENV_KEYS = ["CATALOG_REVALIDATE_SECRET"] as const;

export type ClientEnv = z.infer<typeof clientEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

type Source = Record<string, string | undefined>;

/** Chuỗi rỗng coi như chưa đặt (`.env` hay để `KEY=`). */
function clean(source: Source, keys: readonly string[]): Source {
  const out: Source = {};
  for (const k of keys) {
    const v = source[k];
    out[k] = v === undefined || v.trim() === "" ? undefined : v;
  }
  return out;
}

function withDefaults(raw: Source, useDefaults: boolean): Source {
  if (!useDefaults) return raw;
  const out: Source = { ...raw };
  for (const k of Object.keys(raw)) {
    out[k] ??= DEFAULTS[k as keyof typeof DEFAULTS];
  }
  return out;
}

function format(scope: string, error: z.ZodError): Error {
  const lines = error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
  return new Error(`Cấu hình môi trường ${scope} không hợp lệ:\n${lines.join("\n")}`);
}

export function parseClientEnv(source: Source, opts: { useDefaults: boolean }): ClientEnv {
  const raw = clean(source, Object.keys(clientEnvSchema.shape));
  const r = clientEnvSchema.safeParse(withDefaults(raw, opts.useDefaults));
  if (!r.success) throw format("client", r.error);
  return r.data;
}

export function parseServerEnv(source: Source, opts: { useDefaults: boolean }): ServerEnv {
  const raw = clean(source, Object.keys(serverEnvSchema.shape));
  const r = serverEnvSchema.safeParse(withDefaults(raw, opts.useDefaults));
  if (!r.success) throw format("server", r.error);
  return r.data;
}

/**
 * Chọn nguồn dữ liệu: `XS_DATA_SOURCE` tường minh thắng; không có thì nhìn `MEDUSA_BACKEND_URL` THÔ (không áp mặc
 * định localhost — mặc định đó không có nghĩa là có backend).
 */
export function resolveDataSource(source: Source = process.env): DataSource {
  const explicit = source.XS_DATA_SOURCE?.trim();
  // Biến rỗng/toàn khoảng trắng = không đặt.
  if (isNonEmpty(explicit)) {
    if ((DATA_SOURCES as readonly string[]).includes(explicit)) return explicit as DataSource;
    throw new Error(`XS_DATA_SOURCE phải là ${DATA_SOURCES.join(" | ")}, nhận "${explicit}"`);
  }
  return isNonEmpty(source.MEDUSA_BACKEND_URL?.trim()) ? "backend" : "fixtures";
}

/** Mặc định chỉ khi không phải production runtime. */
export function shouldUseDefaults(env: Source = process.env): boolean {
  return env.NODE_ENV !== "production" || env.NEXT_PHASE === "phase-production-build";
}

let clientCache: ClientEnv | undefined;
let serverCache: ServerEnv | undefined;

export function getClientEnv(): ClientEnv {
  // Tham chiếu tĩnh để Next nhúng giá trị NEXT_PUBLIC_* vào bundle client.
  clientCache ??= parseClientEnv(
    {
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
      NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
      NEXT_PUBLIC_ANALYTICS_TRANSPORT: process.env.NEXT_PUBLIC_ANALYTICS_TRANSPORT,
    },
    { useDefaults: shouldUseDefaults() },
  );
  return clientCache;
}

export function getServerEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("getServerEnv() chỉ được gọi ở server.");
  }
  serverCache ??= parseServerEnv(process.env, { useDefaults: shouldUseDefaults() });
  return serverCache;
}

/** Chỉ cho test. */
export function resetEnvCacheForTests(): void {
  clientCache = undefined;
  serverCache = undefined;
}
