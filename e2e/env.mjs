/**
 * Cấu hình dùng chung cho E2E (run.mjs, playwright.config.ts, mock-vnpay.mjs). Mọi giá trị là KHÓA TEST-ONLY, không
 * phải bí mật: chỉ có ý nghĩa với DB `xshop_e2e`, cổng cục bộ và cổng VNPAY giả lập — không dùng ở nơi khác.
 */
export const PORTS = { backend: 9100, storefront: 3100, mockVnpay: 3300 };

export const URLS = {
  backend: `http://localhost:${PORTS.backend}`,
  storefront: `http://localhost:${PORTS.storefront}`,
  mockVnpay: `http://localhost:${PORTS.mockVnpay}`,
};

const PG_BASE = process.env.E2E_PG_BASE_URL ?? "postgres://xshop:xshop@localhost:5432";
export const E2E_DB_NAME = process.env.E2E_DB_NAME ?? "xshop_e2e";
export const ADMIN_DB_URL = `${PG_BASE}/postgres`;
export const DATABASE_URL = `${PG_BASE}/${E2E_DB_NAME}`;
// DB số 7 riêng cho E2E (khóa, cache, hàng đợi) — không đụng DB 0 của dev.
const REDIS_BASE = process.env.E2E_REDIS_BASE_URL ?? "redis://localhost:6379";
export const REDIS_URL = `${REDIS_BASE}/7`;

export const VNPAY = {
  tmnCode: "E2ETEST",
  hashSecret: "e2e-test-only-vnpay-hash-secret-0123456789",
};

/** Biến môi trường backend: VNPAY mock (querydr nội bộ) + cổng thanh toán là máy chủ giả lập cục bộ. */
export function backendEnv() {
  return {
    NODE_ENV: "development",
    DATABASE_URL,
    REDIS_URL,
    DISABLE_MEDUSA_ADMIN: "true",
    STORE_CORS: URLS.storefront,
    ADMIN_CORS: URLS.backend,
    AUTH_CORS: URLS.backend,
    MEDUSA_BACKEND_URL: URLS.backend,
    VNPAY_ENABLED: "true",
    VNPAY_MODE: "mock",
    VNPAY_TMN_CODE: VNPAY.tmnCode,
    VNPAY_HASH_SECRET: VNPAY.hashSecret,
    VNPAY_PAYMENT_URL: `${URLS.mockVnpay}/pay`,
    VNPAY_API_URL: `${URLS.mockVnpay}/api/transaction`,
    VNPAY_RETURN_URL: `${URLS.storefront}/thanh-toan/ket-qua`,
    GHN_MODE: "mock",
  };
}

/** Biến môi trường storefront (cả lúc build lẫn lúc chạy). */
export function storefrontEnv(publishableKey) {
  return {
    NEXT_PUBLIC_SITE_URL: URLS.storefront,
    NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: publishableKey,
    MEDUSA_BACKEND_URL: URLS.backend,
    XS_DATA_SOURCE: "backend",
  };
}
