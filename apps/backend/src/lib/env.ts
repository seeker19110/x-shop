import { z } from "zod";

/**
 * Cấu hình môi trường của backend, kiểm bằng zod khi nạp `medusa-config.ts` (BASE-CFG-002).
 *
 * - Thiếu/sai → `loadEnvOrExit` in danh sách TÊN biến + lý do ra stderr rồi thoát mã 1. Không bao giờ in giá trị.
 * - `NODE_ENV=production`: mọi bí mật, CORS và REDIS_URL đều bắt buộc.
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
  })
  // Chỉ tới đây khi hợp lệ; production đã bắt buộc CORS ở trên nên mặc định dev không bao giờ áp ở production.
  .transform((env) => ({
    ...env,
    STORE_CORS: env.STORE_CORS ?? DEV_CORS_DEFAULTS.STORE_CORS,
    ADMIN_CORS: env.ADMIN_CORS ?? DEV_CORS_DEFAULTS.ADMIN_CORS,
    AUTH_CORS: env.AUTH_CORS ?? DEV_CORS_DEFAULTS.AUTH_CORS,
  }));

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
