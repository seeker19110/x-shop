/**
 * Cấu hình môi trường tải (T-036). Mọi giá trị đổi được bằng biến LOAD_* ; mặc định dùng DB/Redis/cổng RIÊNG của tải
 * (không đụng DB `xshop`, `xshop_e2e` hay Redis DB 0/7 của dev và E2E).
 *
 * Rate limit (SEC03) KHÔNG bị nới: tải đến từ một IP nên để khỏi bị chặn, backend của môi trường tải đặt
 * XS_TRUSTED_PROXIES=loopback (tin X-Forwarded-For từ socket 127.0.0.1) và máy tải gửi X-Forwarded-For giả (dải
 * 100.64.0.0/10) — mỗi "khách" ảo một IP riêng, đúng như sau CDN/LB thật. Mặc định của sản phẩm giữ nguyên.
 */
const PG_BASE = process.env.LOAD_PG_BASE_URL ?? "postgres://xshop:xshop@localhost:5432";
const REDIS_BASE = process.env.LOAD_REDIS_BASE_URL ?? "redis://localhost:6379";

export const LOAD = {
  dbName: process.env.LOAD_DB_NAME ?? "xshop_load",
  redisDb: Number(process.env.LOAD_REDIS_DB ?? 13),
  port: Number(process.env.LOAD_PORT ?? 9200),
  products: Number(process.env.LOAD_PRODUCTS ?? 10_000),
  /** 1 = giữ DB đã dựng (bỏ bước sinh dữ liệu nếu đủ sản phẩm); mặc định làm mới hoàn toàn. */
  reuse: process.env.LOAD_REUSE === "1",
  // Tốc độ: tải khởi điểm §10.3 = 100 đọc/s + 10 ghi/s; smoke = 1/20 (5 đọc/s + 0,5 ghi/s) — mức máy dev 4 CPU dùng chung
  // chịu được cả pha burst gấp đôi với biên an toàn (đo ở docs/ops/perf/load-dataset.md §Năng lực đo được).
  readRps: Number(process.env.LOAD_READ_RPS ?? 5),
  writeRps: Number(process.env.LOAD_WRITE_RPS ?? 0.5),
  coldSeconds: Number(process.env.LOAD_COLD_SECONDS ?? 8),
  steadySeconds: Number(process.env.LOAD_STEADY_SECONDS ?? 40),
  burstSeconds: Number(process.env.LOAD_BURST_SECONDS ?? 12),
  contention: Number(process.env.LOAD_CONTENTION ?? 50),
  seed: Number(process.env.LOAD_SEED ?? 20_260_101),
};

export const ADMIN_DB_URL = `${PG_BASE}/postgres`;
export const DATABASE_URL = `${PG_BASE}/${LOAD.dbName}`;
export const REDIS_URL = `${REDIS_BASE}/${LOAD.redisDb}`;
export const BASE_URL = `http://127.0.0.1:${LOAD.port}`;

/** Chặn dùng nhầm DB/Redis của việc khác: DB tải phải mang tiền tố `xshop_load`, Redis không phải DB 0 (dev) hay 7 (E2E). */
export function assertSafeTargets(load = LOAD) {
  if (!/^xshop_load[a-z0-9_]*$/.test(load.dbName)) {
    throw new Error(
      `LOAD_DB_NAME phải khớp ^xshop_load[a-z0-9_]*$ (nhận "${load.dbName}") — tránh drop nhầm DB khác`,
    );
  }
  if (!Number.isInteger(load.redisDb) || load.redisDb < 1 || load.redisDb > 15 || load.redisDb === 7) {
    throw new Error(`LOAD_REDIS_DB không hợp lệ (${load.redisDb}): dùng 1–15, trừ 7 (E2E); 0 là của dev`);
  }
  if (!Number.isInteger(load.products) || load.products < 1 || load.products > 99_999) {
    throw new Error(`LOAD_PRODUCTS không hợp lệ: ${load.products}`);
  }
}

/** Biến môi trường backend cho bản chạy tải: mock provider (GHN mock, chỉ COD), proxy tin cậy = loopback. */
export function backendEnv() {
  const origin = BASE_URL;
  return {
    NODE_ENV: "development", // production từ chối GHN/VNPAY mock (lib/env/index.ts) — tải dùng mock có độ trễ xác định
    DATABASE_URL,
    REDIS_URL,
    DISABLE_MEDUSA_ADMIN: "true",
    STORE_CORS: origin,
    ADMIN_CORS: origin,
    AUTH_CORS: origin,
    MEDUSA_BACKEND_URL: origin,
    VNPAY_ENABLED: "false",
    GHN_MODE: "mock",
    XS_TRUSTED_PROXIES: "loopback",
  };
}

/**
 * Cấm đích production (QA-PERF-007): load test chỉ chạy localhost/staging, trừ game day có lịch (chạy tay, ngoài script này).
 * Mẫu viết tách vế để chính file này không chứa tên miền nguyên văn (CI grep cấm tên miền production trong scripts/load).
 * Thêm host khác bằng LOAD_FORBIDDEN_HOSTS="a.example,b.example" (khớp host hoặc subdomain).
 */
const PRODUCTION_HOST = new RegExp(`(^|\\.)x-shop\\.(${["vn", "com"].join("|")})$`, "i");

export function assertNotProduction(url, extra = process.env.LOAD_FORBIDDEN_HOSTS ?? "") {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    throw new Error(`BASE_URL không hợp lệ: "${url}"`);
  }
  const extras = extra
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (PRODUCTION_HOST.test(host) || extras.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new Error(`BASE_URL trỏ vào production (${host}) — load test bị cấm (QA-PERF-007)`);
  }
}
