import { isIPv6 } from "node:net";
import path from "node:path";
import { z } from "zod";
import { parseTrustedProxies, TRUSTED_PROXY_KEYWORDS } from "../security/client-ip";
import { privateDirProblem } from "../upload/private";
import { formatEffectiveConfig, withRedaction } from "./redact";

export { REDACTED, SECRET_ENV_KEYS, formatEffectiveConfig, redactConfig } from "./redact";

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
  "ORDER_LOOKUP_SECRET",
  // Storefront luôn đứng trước backend (proxy) → phải khai rõ proxy tin cậy (hoặc `none`); thiếu thì mọi khách dùng
  // chung một IP (của storefront) trong rate limit → nghẽn toàn site (T-034).
  "XS_TRUSTED_PROXIES",
  // Gốc URL storefront để dựng liên kết gửi khách (liên kết tra cứu đơn — T-149); thiếu thì thư trỏ về localhost.
  "STOREFRONT_URL",
  // Kho file (T-154): production chỉ nhận `s3` — file phải dùng chung giữa các bản sao (đĩa cục bộ của từng máy thì không).
  "FILE_STORAGE",
] as const;

/**
 * Kho file của File Module (T-154): `local` = đĩa của máy đang chạy (`static/` + PRIVATE_UPLOAD_DIR) — CHỈ dev/test một
 * tiến trình, mặc định khi vắng ở dev/test (provider in cảnh báo); `s3` = kho S3-compatible dùng chung giữa các bản sao
 * (bucket công khai + bucket private) — bắt buộc ở production.
 */
export const FILE_STORAGES = ["local", "s3"] as const;
export type FileStorageKind = (typeof FILE_STORAGES)[number];

/** Biến bắt buộc khi FILE_STORAGE=s3 (S3_ENDPOINT vắng = AWS S3 theo S3_REGION). */
export const S3_REQUIRED = [
  "S3_REGION",
  "S3_BUCKET",
  "S3_PRIVATE_BUCKET",
  "S3_FILE_URL",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

/** Mọi biến S3 — đặt bất kỳ biến nào mà FILE_STORAGE không phải `s3` là cấu hình lẫn (lỗi, tránh tưởng đã dùng chung). */
export const S3_VARIABLES = [...S3_REQUIRED, "S3_ENDPOINT", "S3_FORCE_PATH_STYLE"] as const;

/**
 * Thư mục file private khi chạy dev/test mà không đặt PRIVATE_UPLOAD_DIR: `<cwd>/private-uploads` (cạnh `static/`, không
 * nằm trong nó; đã gitignore).
 */
export const DEV_PRIVATE_UPLOAD_DIRNAME = "private-uploads";

/** Thư mục công khai mà Medusa phục vụ ở `/static` (express-loader: `path.join(rootDir, "static")`). */
export const publicStaticDir = (cwd: string = process.cwd()): string => path.join(cwd, "static");

/**
 * Địa chỉ bind mặc định (BASE-SEC-010): loopback. Muốn nhận kết nối từ ngoài máy (container, sau LB) phải đặt `HOST`
 * tường minh (vd. `0.0.0.0`) — scripts `dev`/`start` của backend truyền `-H ${HOST:-127.0.0.1}` cho Medusa.
 */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Giá trị DEBUG coi là TẮT (mặc định). Mọi giá trị khác (`true`, `1`, `medusa:*`…) = bật. */
const DEBUG_OFF = new Set(["", "0", "false", "off", "no"]);

/** Storefront khi chạy dev/test mà không đặt STOREFRONT_URL (`next dev` mặc định cổng 3000). */
export const DEV_STOREFRONT_URL = "http://localhost:3000";

/**
 * Khoá ký token phiên đơn/tra cứu đơn (POST01, T-021). Dev/test vắng → giá trị GIẢ dưới; production bắt buộc ≥ 32 ký tự
 * và từ chối giá trị giả này.
 */
export const ORDER_LOOKUP_DEV_SECRET = "xshop-dev-order-lookup-secret-khong-dung-production";

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

/** Cách gọi VNPAY (querydr…): mock = MockVnpayGateway cục bộ (mặc định dev/test); sandbox/live = HTTP tới VNPAY_API_URL. */
export const VNPAY_MODES = ["mock", "sandbox", "live"] as const;
export type VnpayMode = (typeof VNPAY_MODES)[number];

/**
 * GHN (giao vận, T-026): mock = MockGhn cục bộ (mặc định dev/test) · sandbox | live = HTTP tới GHN_BASE_URL với
 * GHN_TOKEN + GHN_SHOP_ID (chỉ ở server). sandbox|live → bắt buộc đủ `GHN_REQUIRED`. Production: bắt buộc khai rõ
 * sandbox|live (không được mock — vận đơn giả ở production là sai nghiệp vụ) và GHN_BASE_URL phải https://.
 */
export const GHN_MODES = ["mock", "sandbox", "live"] as const;
export type GhnMode = (typeof GHN_MODES)[number];
export const GHN_REQUIRED = ["GHN_BASE_URL", "GHN_TOKEN", "GHN_SHOP_ID"] as const;

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

/**
 * Gốc URL storefront (T-149): http(s), có host, không query/fragment/thông tin đăng nhập — liên kết gửi khách được nối
 * thêm đường dẫn vào sau (`<gốc>/tra-cuu-don/xac-thuc?token=…`). Cho phép tiền tố đường dẫn (vd. `/shop`).
 * Giá trị THÔ không được chứa khoảng trắng/xuống dòng/tab, `\`, `@`, `?`, `#`: WHATWG URL nuốt hoặc sửa các ký tự này
 * khi kiểm, nhưng bộ đọc khác (RFC 3986, ứng dụng thư) thì không — vd. `https://a.vn\@evil.example` có host evil.example.
 * Kết quả là gốc dựng lại từ bản ĐÃ PARSE (`origin + pathname`, bỏ `/` cuối), không dùng chuỗi thô (review T-149).
 */
const baseUrl = z
  .string()
  .refine(
    (raw) => {
      if (/[\s\\@?#]/.test(raw)) return false;
      try {
        const u = new URL(raw);
        return (
          (u.protocol === "http:" || u.protocol === "https:") &&
          u.hostname !== "" &&
          u.search === "" &&
          u.hash === "" &&
          u.username === "" &&
          u.password === ""
        );
      } catch {
        return false;
      }
    },
    {
      message: "phải là URL gốc http(s):// (không khoảng trắng, \\, query, fragment hay thông tin đăng nhập)",
    },
  )
  .transform((raw) => {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  });

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
      if (entry.length > 2 && entry.startsWith("/") && entry.endsWith("/")) {
        // Regex khớp origin "null" (iframe sandbox, file://, data:) = cho mọi trang độc đọc phản hồi có cookie.
        try {
          return !new RegExp(entry.slice(1, -1)).test("null");
        } catch {
          return false;
        }
      }
      try {
        const u = new URL(entry);
        return (u.protocol === "http:" || u.protocol === "https:") && u.pathname === "/" && u.search === "";
      } catch {
        return false;
      }
    }),
  {
    message: 'phải là danh sách origin http(s) (hoặc /regex/ hợp lệ, không khớp "null") cách nhau dấu phẩy',
  },
);

/** Số nguyên (đơn vị `unit`, mặc định giây) trong [min, max]; vắng/rỗng → mặc định. */
const intInRange = (fallback: number, min: number, max: number, unit = "giây") =>
  z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? String(fallback) : v),
    z
      .string()
      .regex(/^\d+$/, { message: `phải là số nguyên ${unit} trong [${min}, ${max}]` })
      .transform(Number)
      .refine((n) => n >= min && n <= max, { message: `phải là số nguyên ${unit} trong [${min}, ${max}]` }),
  );

/** Gốc URL dịch vụ (endpoint S3): http(s), có host, không đường dẫn/query/fragment/thông tin đăng nhập. */
const originUrl = z.string().refine(
  (raw) => {
    if (/[\s\\@?#]/.test(raw)) return false;
    try {
      const u = new URL(raw);
      return (
        (u.protocol === "http:" || u.protocol === "https:") &&
        u.hostname !== "" &&
        u.pathname === "/" &&
        u.search === "" &&
        u.hash === "" &&
        u.username === "" &&
        u.password === ""
      );
    } catch {
      return false;
    }
  },
  { message: "phải là URL gốc http(s):// (không đường dẫn, query, fragment hay thông tin đăng nhập)" },
);

/** Tên bucket theo quy tắc chung của S3 (chữ thường, số, `.`, `-`; 3–63 ký tự; không `..`). */
const bucketName = z
  .string()
  .refine((v) => /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(v) && !v.includes(".."), {
    message: "phải là tên bucket S3 hợp lệ (a-z, 0-9, '.', '-'; 3–63 ký tự)",
  });

/** Khoá truy cập S3: ký tự in được, không khoảng trắng. */
const s3Credential = (min: number) =>
  z.string().refine((v) => v.length >= min && v.length <= 256 && /^[\x21-\x7e]+$/.test(v), {
    message: `phải dài ${min}–256 ký tự in được, không khoảng trắng`,
  });

/** Tên máy/địa chỉ IP để bind: không khoảng trắng, không ký tự URL (`/`, `:` ngoài IPv6, `@`…). */
const bindHost = z.string().refine((v) => /^[A-Za-z0-9._-]+$/.test(v) || isIPv6(v), {
  message: "phải là tên máy hoặc địa chỉ IP (vd. 127.0.0.1, 0.0.0.0, ::1)",
});

const baseSchema = z.object({
  NODE_ENV: z.preprocess(
    (v) => (v === undefined || v === "" ? "development" : v),
    z.enum(NODE_ENVS, { message: `phải là một trong ${NODE_ENVS.join("|")}` }),
  ),
  // Bind (BASE-SEC-010): vắng → 127.0.0.1. Scripts dev/start đọc cùng biến này (package.json).
  HOST: optionalText.pipe(bindHost.optional()),
  // DEBUG (BASE-CFG-007): vắng = tắt; production không được bật. Chấp nhận cả dạng namespace của thư viện `debug`.
  DEBUG: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z
      .string()
      .optional()
      .transform((v) => v !== undefined && !DEBUG_OFF.has(v)),
  ),
  DATABASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string({ message: "bắt buộc" }).pipe(urlWithProtocol(["postgres:", "postgresql:"], "postgres://")),
  ),
  REDIS_URL: optionalText.pipe(urlWithProtocol(["redis:", "rediss:"], "redis:// hoặc rediss://").optional()),
  JWT_SECRET: optionalText.pipe(secret.optional()),
  COOKIE_SECRET: optionalText.pipe(secret.optional()),
  AUTH_MFA_ENCRYPTION_KEY: optionalText.pipe(secret.optional()),
  ORDER_LOOKUP_SECRET: optionalText.pipe(secret.optional()),
  STORE_CORS: optionalText.pipe(corsList.optional()),
  ADMIN_CORS: optionalText.pipe(corsList.optional()),
  AUTH_CORS: optionalText.pipe(corsList.optional()),
  MEDUSA_BACKEND_URL: optionalText.pipe(urlWithProtocol(["http:", "https:"], "http(s)://").optional()),
  STOREFRONT_URL: optionalText.pipe(baseUrl.optional()),
  // Thư mục file private (T-141, BE-FILE-005): không ký tự điều khiển; rời thư mục công khai `static/` (kiểm ở superRefine).
  PRIVATE_UPLOAD_DIR: optionalText.pipe(
    z
      .string()
      // eslint-disable-next-line no-control-regex -- chặn đúng ký tự điều khiển (NUL, xuống dòng…) trong đường dẫn
      .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), { message: "không được chứa ký tự điều khiển" })
      .optional(),
  ),
  // Kho file (T-154): vắng = local ở dev/test; production bắt buộc s3 (superRefine).
  FILE_STORAGE: optionalText.pipe(
    z.enum(FILE_STORAGES, { message: `phải là một trong ${FILE_STORAGES.join("|")}` }).optional(),
  ),
  S3_ENDPOINT: optionalText.pipe(originUrl.optional()),
  S3_REGION: optionalText.pipe(
    z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/, { message: "phải là mã vùng chữ thường/số/gạch nối (vd. us-east-1, auto)" })
      .optional(),
  ),
  S3_BUCKET: optionalText.pipe(bucketName.optional()),
  S3_PRIVATE_BUCKET: optionalText.pipe(bucketName.optional()),
  // Gốc URL công khai của S3_BUCKET (CDN/web endpoint của kho) — URL ảnh trả cho storefront dựng từ đây.
  S3_FILE_URL: optionalText.pipe(baseUrl.optional()),
  S3_ACCESS_KEY_ID: optionalText.pipe(s3Credential(3).optional()),
  S3_SECRET_ACCESS_KEY: optionalText.pipe(s3Credential(8).optional()),
  // Path-style (`<endpoint>/<bucket>/<khoá>`): vắng → bật khi có S3_ENDPOINT (kho tự host), tắt khi dùng AWS.
  S3_FORCE_PATH_STYLE: optionalText.pipe(
    z.enum(["true", "false"], { message: "phải là true|false" }).optional(),
  ),
  // Proxy tin cậy (LB, storefront) được phép báo IP khách qua X-Forwarded-For. Vắng = không tin header nào (SEC03).
  XS_TRUSTED_PROXIES: optionalText.pipe(
    z
      .string()
      .refine((v) => parseTrustedProxies(v).ok, {
        message: `phải là none hoặc danh sách IP/CIDR/${TRUSTED_PROXY_KEYWORDS.join("|")} cách nhau dấu phẩy (≤ 64 mục)`,
      })
      .optional(),
  ),
  // Pool Postgres MỖI tiến trình (T-092, DB-PERF-004): tổng `DB_POOL_MAX × số tiến trình` + dự phòng ≤ max_connections
  // (docs/db/connections.md). statement_timeout của phiên ứng dụng; chạy migration dài → nâng tạm cho lệnh migrate.
  DB_POOL_MAX: intInRange(10, 1, 100, "kết nối"),
  DB_STATEMENT_TIMEOUT_MS: intInRange(30_000, 1_000, 3_600_000, "mili giây"),
  // Tắt êm (T-094, BE-REL-004): giữ readiness 503 trong DRAIN_DELAY rồi mới đóng listener; toàn bộ quá trình tắt có
  // trần TIMEOUT, phải < grace period của nền tảng (Kubernetes mặc định 30 s). Vắng DRAIN_DELAY → 5 s ở production,
  // 0 ở dev/test (Ctrl-C không phải chờ).
  SHUTDOWN_DRAIN_DELAY_MS: optionalText.pipe(
    z
      .string()
      .regex(/^\d+$/, { message: "phải là số nguyên mili giây trong [0, 60000]" })
      .transform(Number)
      .refine((n) => n <= 60_000, { message: "phải là số nguyên mili giây trong [0, 60000]" })
      .optional(),
  ),
  SHUTDOWN_TIMEOUT_MS: intInRange(25_000, 1_000, 300_000, "mili giây"),
  // Ngưỡng log (T-090): tên mức của Medusa/winston; vắng = info. Log truy cập của dự án ở mức info.
  LOG_LEVEL: z.preprocess(
    (v) => (v === undefined || (typeof v === "string" && v.trim() === "") ? "info" : v),
    z.enum(["error", "warn", "info", "http", "verbose", "debug", "silly"], {
      message: "phải là một trong error|warn|info|http|verbose|debug|silly",
    }),
  ),
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
  VNPAY_MODE: optionalText.pipe(
    z.enum(VNPAY_MODES, { message: `phải là một trong ${VNPAY_MODES.join("|")}` }).optional(),
  ),
  VNPAY_TMN_CODE: optionalText.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9]{1,32}$/, { message: "phải là mã merchant chữ/số (≤ 32 ký tự)" })
      .optional(),
  ),
  VNPAY_HASH_SECRET: optionalText.pipe(secret.optional()),
  // Xoay khoá (BE-INT-002, T-099): khoá TRƯỚC vẫn được nhận khi XÁC MINH chữ ký (IPN/return/querydr) trong cửa sổ
  // xoay; mọi chữ ký gửi đi chỉ dùng VNPAY_HASH_SECRET. Bỏ biến này khi hết cửa sổ xoay.
  VNPAY_HASH_SECRET_PREVIOUS: optionalText.pipe(secret.optional()),
  VNPAY_PAYMENT_URL: optionalText.pipe(urlWithProtocol(["https:", "http:"], "http(s)://").optional()),
  VNPAY_API_URL: optionalText.pipe(urlWithProtocol(["https:", "http:"], "http(s)://").optional()),
  VNPAY_RETURN_URL: optionalText.pipe(urlWithProtocol(["https:", "http:"], "http(s)://").optional()),
  GHN_MODE: optionalText.pipe(
    z.enum(GHN_MODES, { message: `phải là một trong ${GHN_MODES.join("|")}` }).optional(),
  ),
  GHN_BASE_URL: optionalText.pipe(urlWithProtocol(["https:", "http:"], "http(s)://").optional()),
  GHN_TOKEN: optionalText.pipe(
    z
      .string()
      .regex(/^[A-Za-z0-9-]{8,128}$/, { message: "phải là token chữ/số/gạch nối (8–128 ký tự)" })
      .optional(),
  ),
  GHN_SHOP_ID: optionalText.pipe(
    z
      .string()
      .regex(/^[0-9]{1,20}$/, { message: "phải là mã cửa hàng dạng số" })
      .optional(),
  ),
});

/** Mọi khoá biến môi trường của schema (kể cả optional vắng mặt) — hàng rào "tên giống bí mật" ở test duyệt theo danh sách này. */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.keys(baseSchema.shape);

const schema = baseSchema
  .superRefine((env, ctx) => {
    if (env.SHUTDOWN_DRAIN_DELAY_MS !== undefined && env.SHUTDOWN_DRAIN_DELAY_MS >= env.SHUTDOWN_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["SHUTDOWN_DRAIN_DELAY_MS"],
        message: "phải nhỏ hơn SHUTDOWN_TIMEOUT_MS",
      });
    }
    if (env.VNPAY_HASH_SECRET_PREVIOUS !== undefined) {
      if (env.VNPAY_HASH_SECRET === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["VNPAY_HASH_SECRET_PREVIOUS"],
          message: "chỉ đặt khi đã đặt VNPAY_HASH_SECRET (khoá hiện tại)",
        });
      } else if (env.VNPAY_HASH_SECRET_PREVIOUS === env.VNPAY_HASH_SECRET) {
        ctx.addIssue({
          code: "custom",
          path: ["VNPAY_HASH_SECRET_PREVIOUS"],
          message: "phải khác VNPAY_HASH_SECRET",
        });
      }
    }
    fileStorageProblems(env).forEach(([variable, message]) =>
      ctx.addIssue({ code: "custom", path: [variable], message }),
    );
    if (env.PRIVATE_UPLOAD_DIR !== undefined) {
      const problem = privateDirProblem(publicStaticDir(), env.PRIVATE_UPLOAD_DIR);
      if (problem !== null) ctx.addIssue({ code: "custom", path: ["PRIVATE_UPLOAD_DIR"], message: problem });
      else if (env.NODE_ENV === "production" && !path.isAbsolute(env.PRIVATE_UPLOAD_DIR)) {
        ctx.addIssue({
          code: "custom",
          path: ["PRIVATE_UPLOAD_DIR"],
          message: "phải là đường dẫn tuyệt đối khi NODE_ENV=production",
        });
      }
    }
    const ghnMode = env.GHN_MODE ?? (env.NODE_ENV === "production" ? undefined : "mock");
    if (ghnMode === "sandbox" || ghnMode === "live") {
      for (const key of GHN_REQUIRED) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: "custom", path: [key], message: "bắt buộc khi GHN_MODE=sandbox|live" });
        }
      }
    }
    if (env.NODE_ENV !== "production") return;
    if (env.DEBUG) {
      ctx.addIssue({ code: "custom", path: ["DEBUG"], message: "phải tắt khi NODE_ENV=production" });
    }
    if (env.GHN_MODE === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["GHN_MODE"],
        message: "bắt buộc khai rõ (sandbox|live) khi NODE_ENV=production",
      });
    } else if (env.GHN_MODE === "mock") {
      ctx.addIssue({ code: "custom", path: ["GHN_MODE"], message: "không được dùng mock ở production" });
    }
    if (env.STOREFRONT_URL !== undefined && !env.STOREFRONT_URL.startsWith("https://")) {
      // Liên kết mang token một lần — không gửi qua http thường.
      ctx.addIssue({ code: "custom", path: ["STOREFRONT_URL"], message: "phải dùng https:// ở production" });
    }
    if (env.GHN_BASE_URL !== undefined && !env.GHN_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["GHN_BASE_URL"], message: "phải dùng https:// ở production" });
    }
    for (const key of PRODUCTION_REQUIRED) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "bắt buộc khi NODE_ENV=production" });
      }
    }
    if (env.JWT_SECRET !== undefined && env.JWT_SECRET === env.COOKIE_SECRET) {
      ctx.addIssue({ code: "custom", path: ["COOKIE_SECRET"], message: "phải khác JWT_SECRET" });
    }
    if (env.ORDER_LOOKUP_SECRET === ORDER_LOOKUP_DEV_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["ORDER_LOOKUP_SECRET"],
        message: "không được dùng khoá giả của dev",
      });
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
      if (env.VNPAY_MODE === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["VNPAY_MODE"],
          message: "bắt buộc khai rõ (sandbox|live) khi NODE_ENV=production và VNPAY_ENABLED=true",
        });
      } else if (env.VNPAY_MODE === "mock") {
        ctx.addIssue({ code: "custom", path: ["VNPAY_MODE"], message: "không được dùng mock ở production" });
      }
      for (const key of ["VNPAY_HASH_SECRET", "VNPAY_HASH_SECRET_PREVIOUS"] as const) {
        if (env[key] === VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET) {
          ctx.addIssue({ code: "custom", path: [key], message: "không được dùng khoá giả của dev" });
        }
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
    const effective = {
      ...env,
      host: env.HOST ?? DEFAULT_BIND_HOST,
      STORE_CORS: env.STORE_CORS ?? DEV_CORS_DEFAULTS.STORE_CORS,
      ADMIN_CORS: env.ADMIN_CORS ?? DEV_CORS_DEFAULTS.ADMIN_CORS,
      AUTH_CORS: env.AUTH_CORS ?? DEV_CORS_DEFAULTS.AUTH_CORS,
      ghn: {
        mode: (env.GHN_MODE ?? "mock") as GhnMode,
        baseUrl: env.GHN_BASE_URL ?? "",
        token: env.GHN_TOKEN ?? "",
        shopId: env.GHN_SHOP_ID ?? "",
      },
      shutdown: {
        drainDelayMs: Math.min(
          env.SHUTDOWN_DRAIN_DELAY_MS ?? (env.NODE_ENV === "production" ? 5_000 : 0),
          env.SHUTDOWN_TIMEOUT_MS - 1,
        ),
        timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      },
      // STOREFRONT_URL đã chuẩn hoá ở schema; production đã bắt buộc biến nên mặc định dev không áp ở production.
      storefrontUrl: env.STOREFRONT_URL ?? DEV_STOREFRONT_URL,
      // Chỉ dùng khi FILE_STORAGE=local (dev/test; production bắt buộc s3 nên mặc định dev không áp ở production).
      privateUploadDir: path.resolve(
        env.PRIVATE_UPLOAD_DIR ?? path.join(process.cwd(), DEV_PRIVATE_UPLOAD_DIRNAME),
      ),
      fileStorage: fileStorageConfig(env),
      orderLookupSecret:
        env.ORDER_LOOKUP_SECRET ?? (env.NODE_ENV === "production" ? "" : ORDER_LOOKUP_DEV_SECRET),
      vnpay: env.VNPAY_ENABLED
        ? {
            tmnCode: pick("VNPAY_TMN_CODE"),
            hashSecret: pick("VNPAY_HASH_SECRET"),
            hashSecretPrevious: env.VNPAY_HASH_SECRET_PREVIOUS ?? null,
            paymentUrl: pick("VNPAY_PAYMENT_URL"),
            apiUrl: pick("VNPAY_API_URL"),
            returnUrl: pick("VNPAY_RETURN_URL"),
            mode: (env.VNPAY_MODE ?? "mock") as VnpayMode,
          }
        : null,
    };
    // `JSON.stringify`/`console.log`/`util.inspect` trên Env và các đối tượng lồng (ghn, vnpay) luôn ra bản đã che (BASE-CFG-005).
    // Không chặn được `{ ...env }`/`Object.entries`: các cách đó sao chép GIÁ TRỊ THẬT — dump phải qua redactConfig.
    withRedaction(effective.ghn);
    if (effective.fileStorage.kind === "s3") withRedaction(effective.fileStorage);
    if (effective.vnpay !== null) withRedaction(effective.vnpay);
    return withRedaction(effective);
  });

export type Env = z.output<typeof schema>;

type BaseEnv = z.output<typeof baseSchema>;

/** Kho file hiệu lực: vắng ở dev/test → local. */
function effectiveStorage(env: BaseEnv): FileStorageKind | undefined {
  return env.FILE_STORAGE ?? (env.NODE_ENV === "production" ? undefined : "local");
}

/**
 * Lỗi cấu hình kho file (T-154) dạng [biến, lý do] — lý do không chứa giá trị.
 *  - production: chỉ `s3` (vắng do PRODUCTION_REQUIRED báo); endpoint/URL công khai phải https; MEDUSA_BACKEND_URL bắt buộc
 *    (URL route tải file private dựng từ đây — thiếu thì link xuất trỏ localhost).
 *  - s3: đủ S3_REQUIRED; hai bucket khác nhau; S3_FILE_URL không trỏ vào bucket private; PRIVATE_UPLOAD_DIR không dùng.
 *  - local: không đặt biến S3_* nào (tránh tưởng đã dùng kho chung trong khi file vẫn ở đĩa máy này).
 */
function fileStorageProblems(env: BaseEnv): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const storage = effectiveStorage(env);
  const production = env.NODE_ENV === "production";
  if (storage === undefined) return out;
  if (storage === "local") {
    if (production) {
      out.push([
        "FILE_STORAGE",
        "không được dùng local ở production — đĩa từng máy không dùng chung giữa các bản sao (đặt s3)",
      ]);
    }
    for (const key of S3_VARIABLES) {
      if (env[key] !== undefined) out.push([key, "chỉ đặt khi FILE_STORAGE=s3"]);
    }
    return out;
  }
  for (const key of S3_REQUIRED) {
    if (env[key] === undefined) out.push([key, "bắt buộc khi FILE_STORAGE=s3"]);
  }
  if (env.PRIVATE_UPLOAD_DIR !== undefined) {
    out.push([
      "PRIVATE_UPLOAD_DIR",
      "không dùng khi FILE_STORAGE=s3 (file private nằm ở S3_PRIVATE_BUCKET) — bỏ biến",
    ]);
  }
  if (env.S3_BUCKET !== undefined && env.S3_BUCKET === env.S3_PRIVATE_BUCKET) {
    out.push(["S3_PRIVATE_BUCKET", "phải khác S3_BUCKET (bucket công khai)"]);
  } else if (env.S3_FILE_URL !== undefined && env.S3_PRIVATE_BUCKET !== undefined) {
    const u = new URL(env.S3_FILE_URL);
    const priv = env.S3_PRIVATE_BUCKET;
    const inPath = u.pathname.split("/").includes(priv);
    const inHost = u.hostname === priv || u.hostname.startsWith(`${priv}.`);
    if (inPath || inHost) out.push(["S3_FILE_URL", "không được trỏ vào S3_PRIVATE_BUCKET"]);
  }
  if (production) {
    if (env.MEDUSA_BACKEND_URL === undefined) {
      out.push([
        "MEDUSA_BACKEND_URL",
        "bắt buộc khi NODE_ENV=production và FILE_STORAGE=s3 (URL tải file private)",
      ]);
    }
    for (const key of ["S3_ENDPOINT", "S3_FILE_URL"] as const) {
      const value = env[key];
      if (value !== undefined && !value.startsWith("https://")) {
        out.push([key, "phải dùng https:// ở production"]);
      }
    }
  }
  return out;
}

export type FileStorageConfig =
  | { kind: "local" }
  | {
      kind: "s3";
      endpoint: string | undefined;
      region: string;
      bucket: string;
      privateBucket: string;
      fileUrl: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };

/** Chỉ gọi sau superRefine (s3 đã đủ biến). */
function fileStorageConfig(env: BaseEnv): FileStorageConfig {
  if (effectiveStorage(env) !== "s3") return { kind: "local" };
  return {
    kind: "s3",
    endpoint: env.S3_ENDPOINT === undefined ? undefined : new URL(env.S3_ENDPOINT).origin,
    region: env.S3_REGION ?? "",
    bucket: env.S3_BUCKET ?? "",
    privateBucket: env.S3_PRIVATE_BUCKET ?? "",
    fileUrl: env.S3_FILE_URL ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle:
      env.S3_FORCE_PATH_STYLE === undefined
        ? env.S3_ENDPOINT !== undefined
        : env.S3_FORCE_PATH_STYLE === "true",
  };
}

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

/**
 * Cấu hình hiệu lực (đã che bí mật) dạng JSON cho `config:print` (BASE-CFG-007): cùng schema/mặc định như lúc khởi động.
 * Cấu hình sai → ném lỗi chỉ nêu tên biến + lý do (không giá trị).
 */
export function renderEffectiveConfig(source: Readonly<Record<string, string | undefined>>): string {
  const result = parseEnv(source);
  if (!result.ok) throw new Error(formatEnvProblems(result.problems));
  return formatEffectiveConfig(result.env);
}
