import { z } from "zod";

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

export const clientEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: httpUrl,
  NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: z.string().trim().min(1, "không được rỗng"),
});

export const DATA_SOURCES = ["backend", "fixtures"] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

export const serverEnvSchema = z.object({
  MEDUSA_BACKEND_URL: httpUrl,
  /** Nguồn dữ liệu catalog. Bỏ trống: `backend` nếu `MEDUSA_BACKEND_URL` được đặt thật, ngược lại `fixtures`. */
  XS_DATA_SOURCE: z.enum(DATA_SOURCES).optional(),
});

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
  if (explicit) {
    if ((DATA_SOURCES as readonly string[]).includes(explicit)) return explicit as DataSource;
    throw new Error(`XS_DATA_SOURCE phải là ${DATA_SOURCES.join(" | ")}, nhận "${explicit}"`);
  }
  return source.MEDUSA_BACKEND_URL?.trim() ? "backend" : "fixtures";
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
