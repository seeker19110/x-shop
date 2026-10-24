import { z } from "zod";

/**
 * Cấu hình môi trường của backend, kiểm bằng zod khi nạp `medusa-config.ts` (BASE-CFG-002).
 *
 * - Thiếu/sai → `loadEnvOrExit` in danh sách TÊN biến + lý do ra stderr rồi thoát mã 1. Không bao giờ in giá trị.
 * - `NODE_ENV=production`: mọi bí mật, CORS và REDIS_URL đều bắt buộc; VNPAY bật (mặc định) → đủ `VNPAY_REQUIRED`.
 * - `development`/`test`: chỉ DATABASE_URL bắt buộc; CORS vắng → `DEV_CORS_DEFAULTS` (localhost); bí mật vắng →
 *   Medusa dùng mặc định dev của nó ("supersecret", Medusa tự từ chối ở production); REDIS_URL vắng → module
 *   in-memory (một tiến trình). Biến CÓ đặt thì vẫn phải đúng định dạng.
 */

export const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const WORKER_MODES = ["shared", "worker", "server"] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];

/** Độ dài tối thiểu của bí mật (JWT/cookie/khoá mã hoá MFA) — 32 ký tự ≈ 256 bit nếu sinh ngẫu nhiên. */
export const MIN_SECRET_LENGTH = 32;

/** Biến bắt buộc khi NODE_ENV=production. */
export const PRODUCTION_REQUIRED = [
  "REDIS_URL",
  "JWT_SECRET",
  "COOKIE_SECRET",
  "STORE_CORS",
  "ADMIN_CORS",
  "AUTH_CORS",
  "AUTH_MFA_ENCRYPTION_KEY",
] as const;

/**
 * VNPAY (SPEC-payment): bật mặc định. Production + VNPAY_ENABLED=true → bắt buộc đủ các biến dưới. Dev/test vắng → dùng
 * `VNPAY_DEV_DEFAULTS` (GIẢ — chỉ ký/kiểm chữ ký cục bộ với MockVnpayGateway; production từ chối khoá giả này).
 */
export const VNPAY_REQUIRED = [
  "VNPAY_TMN_CODE",
  "VNPAY_HASH_SECRET",
  "VNPAY_PAYMENT_URL",
  "VNPAY_API_URL",
  "VNPAY_RETURN_URL",
] as const;

export const VNPAY_DEV_DEFAULTS = {
  VNPAY_TMN_CODE: "XSHOPDEV",
  VNPAY_HASH_SECRET: "xshop-dev-vnpay-hash-secret-khong-dung-production",
  VNPAY_PAYMENT_URL: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  VNPAY_API_URL: "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction",
  VNPAY_RETURN_URL: "http://localhost:3000/thanh-toan/ket-qua",
} as const;

/** CORS khi chạy dev/test mà không đặt biến: storefront (Next.js 3000/8000) và Admin (Vite 5173, Medusa 9000). */
export const DEV_CORS_DEFAULTS = {
  STORE_CORS: "http://localhost:8000,http://localhost:3000",
  ADMIN_CORS: "http://localhost:5173,http://localhost:9000",
  AUTH_CORS: "http://localhost:5173,http://localhost:9000,http://localhost:8000,http://localhost:3000",
} as const;

export interface EnvProblem {
  /** Tên biến môi trường. */
  variable: string;
  /** Lý do — KHÔNG chứa giá trị của biến. */
  reason: string;
}

export type EnvResult = { ok: true; env: Env } | { ok: false; problems: EnvProblem[] };

/** Chuỗi rỗng/toàn khoảng trắng được coi như không đặt (thường gặp khi .env có `KEY=`). */
const optionalText = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

const urlWithProtocol = (protocols: readonly string[], label: string) =>
  z.string().refine(
    (raw) => {
      try {
        const u = new URL(raw);
        return protocols.includes(u.protocol) && u.hostname !== "";
      } catch {
        return false;
      }
    },
    { message: `phải là URL ${label} hợp lệ` },
  );

// Độ dài tối thiểu cũng loại các mặc định công khai ngắn như "supersecret" của Medusa.
const secret = z
  .string()
  .min(MIN_SECRET_LENGTH, { message: `phải dài tối thiểu ${MIN_SECRET_LENGTH} ký tự` });

/** Danh sách origin cách nhau dấu phẩy: mỗi mục là origin http(s) hoặc biểu thức chính quy dạng /…/. */
const corsList = z.string().refine(
  (raw) =>
    raw.split(",").every((part) => {
      const entry = part.trim();
      if (entry === "") return false;
      if (entry.length > 2 && entry.startsWith("/") && entry.endsWith("/")) return true;
      try {
        const u = new URL(entry);
        return (u.protocol === "http:" || u.protocol === "https:") && u.pathname === "/" && u.search === "";
      } catch {
        return false;
      }
    }),
  { message: "phải là danh sách origin http(s) (hoặc /regex/) cách nhau dấu phẩy" },
);

/** Số nguyên giây trong [min, max]; vắng/rỗng → mặc định. */
const intInRange = (fallback: number, min: number, max: number) =>
  z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? String(fallback) : v),
    z
      .string()
      .regex(/^\d+$/, { message: `phải là số nguyên giây trong [${min}, ${max}]` })
      .transform(Number)
      .refine((n) => n >= min && n <= max, { message: `phải là số nguyên giây trong [${min}, ${max}]` }),
  );

const schema = z
  .object({
    NODE_ENV: z.preprocess(
      (v) => (v === undefined || v === "" ? "development" : v),
      z.enum(NODE_ENVS, { message: `phải là một trong ${NODE_ENVS.join("|")}` }),
    ),
    DATABASE_URL: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string({ message: "bắt buộc" }).pipe(urlWithProtocol(["postgres:", "postgresql:"], "postgres://")),
    ),
    REDIS_URL: optionalText.pipe(
      urlWithProtocol(["redis:", "rediss:"], "redis:// hoặc rediss://").optional(),
    ),
    JWT_SECRET: optionalText.pipe(secret.optional()),
    COOKIE_SECRET: optionalText.pipe(secret.optional()),
    AUTH_MFA_ENCRYPTION_KEY: optionalText.pipe(secret.optional()),
    STORE_CORS: optionalText.pipe(corsList.optional()),
    ADMIN_CORS: optionalText.pipe(corsList.optional()),
    AUTH_CORS: optionalText.pipe(corsList.optional()),
    MEDUSA_BACKEND_URL: optionalText.pipe(urlWithProtocol(["http:", "https:"], "http(s)://").optional()),
    MEDUSA_WORKER_MODE: z.preprocess(
      (v) => (v === undefined || v === "" ? "shared" : v),
      z.enum(WORKER_MODES, { message: `phải là một trong ${WORKER_MODES.join("|")}` }),
    ),
    DISABLE_MEDUSA_ADMIN: z.preprocess(
      (v) => (v === undefined || v === "" ? "false" : v),
      z.enum(["true", "false"], { message: "phải là true|false" }).transform((v) => v === "true"),
    ),
    // Chính sách phiên admin (SPEC-admin S-402, SEC02): tuyệt đối 8 giờ, nhàn rỗi 30 phút, xác thực lại ≤ 5 phút.
    ADMIN_SESSION_MAX_AGE_SECONDS: intInRange(28_800, 300, 86_400),
    ADMIN_SESSION_IDLE_SECONDS: intInRange(1_800, 60, 28_800),
    ADMIN_REAUTH_MAX_AGE_SECONDS: intInRange(300, 30, 900),
    VNPAY_ENABLED: z.preprocess(
      (v) => (v === undefined || v === "" ? "true" : v),
      z.enum(["true", "false"], { message: "phải là true|false" }).transform((v) => v === "true"),
    ),
    VNPAY_TMN_CODE: optionalText.pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9]{1,32}$/, { message: "phải là mã merchant chữ/số (≤ 32 ký tự)" })
        .optional(),
    ),
    VNPAY_HASH_SECRET: optionalText.pipe(secret.optional()),
    VNPAY_PAYMENT_URL: optionalText.pipe(urlWithProtocol(["https:", "http:"], "http(s)://").optional()),
    VNPAY_API_URL: optionalText.pipe(urlWithProtocol(["https:", "http:"], "http(s)://").optional()),
    VNPAY_RETURN_URL: optionalText.pipe(urlWithProtocol(["https:", "http:"], "http(s)://").optional()),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    for (const key of PRODUCTION_REQUIRED) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "bắt buộc khi NODE_ENV=production" });
      }
    }
    if (env.JWT_SECRET !== undefined && env.JWT_SECRET === env.COOKIE_SECRET) {
      ctx.addIssue({ code: "custom", path: ["COOKIE_SECRET"], message: "phải khác JWT_SECRET" });
    }
    if (env.VNPAY_ENABLED) {
      for (const key of VNPAY_REQUIRED) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "bắt buộc khi NODE_ENV=production và VNPAY_ENABLED=true",
          });
        }
      }
      if (env.VNPAY_HASH_SECRET === VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET) {
        ctx.addIssue({
          code: "custom",
          path: ["VNPAY_HASH_SECRET"],
          message: "không được dùng khoá giả của dev",
        });
      }
      for (const key of ["VNPAY_PAYMENT_URL", "VNPAY_API_URL", "VNPAY_RETURN_URL"] as const) {
        const value = env[key];
        if (value !== undefined && !value.startsWith("https://")) {
          ctx.addIssue({ code: "custom", path: [key], message: "phải dùng https:// ở production" });
        }
      }
    }
  })
  // Chỉ tới đây khi hợp lệ; production đã bắt buộc CORS ở trên nên mặc định dev không bao giờ áp ở production.
  // Tương tự cho VNPAY: production + bật đã bắt buộc đủ biến nên mặc định giả chỉ lấp ở dev/test. Tắt → `vnpay: null`.
  .transform((env) => {
    const pick = <K extends keyof typeof VNPAY_DEV_DEFAULTS>(key: K): string =>
      env[key] ?? (env.NODE_ENV === "production" ? "" : VNPAY_DEV_DEFAULTS[key]);
    return {
      ...env,
      STORE_CORS: env.STORE_CORS ?? DEV_CORS_DEFAULTS.STORE_CORS,
      ADMIN_CORS: env.ADMIN_CORS ?? DEV_CORS_DEFAULTS.ADMIN_CORS,
      AUTH_CORS: env.AUTH_CORS ?? DEV_CORS_DEFAULTS.AUTH_CORS,
      vnpay: env.VNPAY_ENABLED
        ? {
            tmnCode: pick("VNPAY_TMN_CODE"),
            hashSecret: pick("VNPAY_HASH_SECRET"),
            paymentUrl: pick("VNPAY_PAYMENT_URL"),
            apiUrl: pick("VNPAY_API_URL"),
            returnUrl: pick("VNPAY_RETURN_URL"),
          }
        : null,
    };
  });

export type Env = z.output<typeof schema>;

/** Kiểm biến môi trường; không ném lỗi, không đọc `process.env` trực tiếp (dễ test). */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): EnvResult {
  const result = schema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  // Một dòng cho mỗi biến (lỗi đầu tiên). Mọi thông báo ở trên là văn bản cố định; thông báo mặc định của
  // zod 4 cũng không chứa giá trị đầu vào.
  const byVariable = new Map<string, string>();
  for (const issue of result.error.issues) {
    const variable = String(issue.path[0] ?? "(không rõ)");
    if (!byVariable.has(variable)) byVariable.set(variable, issue.message);
  }
  const problems = [...byVariable].map<EnvProblem>(([variable, reason]) => ({ variable, reason }));
  return { ok: false, problems };
}

/** Thông báo lỗi chỉ nêu tên biến + lý do. */
export function formatEnvProblems(problems: readonly EnvProblem[]): string {
  const lines = problems.map((p) => `  - ${p.variable}: ${p.reason}`);
  return [
    "[x-shop] Cấu hình môi trường không hợp lệ — sửa .env (mẫu: apps/backend/.env.example):",
    ...lines,
  ].join("\n");
}

export interface ExitHooks {
  writeError: (message: string) => void;
  exit: (code: number) => never;
}

const processHooks: ExitHooks = {
  writeError: (message) => {
    process.stderr.write(`${message}\n`);
  },
  exit: (code) => process.exit(code),
};

/** Dùng trong medusa-config.ts: cấu hình sai → in tên biến và thoát mã 1 (fail fast). */
export function loadEnvOrExit(
  source: Readonly<Record<string, string | undefined>> = process.env,
  hooks: ExitHooks = processHooks,
): Env {
  const result = parseEnv(source);
  if (result.ok) return result.env;
  hooks.writeError(formatEnvProblems(result.problems));
  return hooks.exit(1);
}
