import { config as outboxDispatchConfig } from "../../jobs/outbox-dispatch";
import { RESET_WORK_MAX_DELAY_MS } from "../admin-security/reset-password";
import { ABORT_WAIT_MS } from "../audit/http";
import { IMPORT_LOCK_WAIT_MS } from "../catalog/import";
import { DRAIN_SCHEDULED_WAIT_MS, DRAIN_WAIT_SLICE_MS } from "../catalog/indexer";
import { COD_OVERDUE_EXCEPTION_DUE_MS, STALE_ATTEMPT_LOCK_WAIT_MS } from "../checkout/jobs";
import { LOCK_CALL_TIMEOUT_MS } from "../checkout/locks";
import { parseEnv } from "../env";
import { READINESS_PROBE_TIMEOUT_MS } from "../health/readiness";
import { RETURNS_CONFIG } from "../../modules/returns/constants";
import { SETTLEMENT_CONFIG } from "../../modules/settlement/constants";
import { AUTH_RATE_LIMITS } from "../admin-security/config";
import { DENY_AUDIT_THROTTLE } from "../audit/deny-throttle";
import { CATALOG_REVALIDATE_POLICY } from "../catalog/revalidate";
import { CHECKOUT_CONFIG } from "../checkout/config";
import { HOLD_RECHECK_POLICY } from "../checkout/hold-recheck";
import { WEBHOOK_RATE_LIMITS } from "../http/webhook-rate-limit";
import { DB_TIMEOUTS, REDIS_TIMEOUTS, S3_TIMEOUTS } from "../infra/timeouts";
import { ORDER_ACCESS_CONFIG } from "../orders/access";
import { ORDER_RATE_LIMITS } from "../orders/rate-limit";
import { OUTBOX_BREAKER_POLICY } from "../outbox/breaker";
import { OUTBOX_POLICY } from "../outbox/policy";
import { parseRetryAfterMs } from "../outbox/retry";
import { STORE_RATE_LIMITS } from "../security/rate-limit";
import { GHN_RETRY_POLICY, SHIPPING_CONFIG } from "../shipping/config";

const DB = "postgres://user:pa55-db-secret@localhost:5432/xshop";
const JWT = "jwt-0123456789abcdef0123456789abcdef";
const COOKIE = "cookie-0123456789abcdef0123456789abcd";
const MFA = "mfa-0123456789abcdef0123456789abcdef0";

// Bản sao nguyên mẫu `production` của env.unit.spec.ts (giá trị giả) — để đo mặc định drain của production.
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: DB,
  REDIS_URL: "rediss://default:redis-pass@cache.example.vn:6380",
  JWT_SECRET: JWT,
  COOKIE_SECRET: COOKIE,
  AUTH_MFA_ENCRYPTION_KEY: MFA,
  ORDER_LOOKUP_SECRET: "order-0123456789abcdef0123456789abcd",
  XS_TRUSTED_PROXIES: "10.0.0.0/8",
  STOREFRONT_URL: "https://shop.example.vn/",
  MEDUSA_BACKEND_URL: "https://api.shop.example.vn",
  FILE_STORAGE: "s3",
  S3_ENDPOINT: "https://s3.shop.example.vn",
  S3_REGION: "garage",
  S3_BUCKET: "xshop-public",
  S3_PRIVATE_BUCKET: "xshop-private",
  S3_FILE_URL: "https://cdn.shop.example.vn/xshop-public",
  S3_ACCESS_KEY_ID: "GK0123456789abcdef01234567",
  S3_SECRET_ACCESS_KEY: "s3-secret-0123456789abcdef0123456789abcdef",
  STORE_CORS: "https://shop.example.vn",
  ADMIN_CORS: "https://admin.example.vn,http://localhost:9000",
  AUTH_CORS: "https://admin.example.vn,/\\.example\\.vn$/",
  VNPAY_TMN_CODE: "XSHOPPROD",
  VNPAY_HASH_SECRET: "vnpay-0123456789abcdef0123456789abcd",
  VNPAY_PAYMENT_URL: "https://pay.vnpay.example/paymentv2/vpcpay.html",
  VNPAY_API_URL: "https://pay.vnpay.example/merchant_webapi/api/transaction",
  VNPAY_RETURN_URL: "https://shop.example.vn/thanh-toan/ket-qua",
  VNPAY_MODE: "live",
  GHN_MODE: "live",
  GHN_BASE_URL: "https://ghn.example.vn/shiip/public-api",
  GHN_TOKEN: "ghn-token-0123456789abcdef",
  GHN_SHOP_ID: "123456",
  // T-142: production bắt buộc khoá webhook revalidate (trừ khi CATALOG_REVALIDATE_ENABLED=false).
  CATALOG_REVALIDATE_SECRET: "revalidate-0123456789abcdef0123456789",
};

// T-160 (XC-UNITS-009): thay hằng thời lượng viết tay (`24 * 3600_000`, `60_000`…) bằng hàm đơn vị KHÔNG được đổi giá
// trị. Giá trị cũ gõ lại bằng số trần ở đây — cố ý không dùng hàm đơn vị để test không tự chứng minh chính nó.
const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("giá trị thời lượng sau khi thay hằng viết tay bằng hằng đơn vị", () => {
  it("checkout: báo giá, giữ hàng, COD, lease, khoá, đối soát payment_unknown", () => {
    expect(CHECKOUT_CONFIG).toMatchObject({
      quoteTtlMs: 600_000,
      onlineHoldMs: 900_000,
      codConfirmMs: 24 * HOUR,
      attemptLeaseMs: 120_000,
      lockWaitMs: 15_000,
      replayWaitMs: 8_000,
      orderLockWaitMs: 15_000,
      queryTimeoutMs: 10_000,
      paymentUnknownDueMs: 1_800_000,
    });
    expect(CHECKOUT_CONFIG.codConfirmMs).toBe(DAY);
  });

  it("hold-recheck: 1 phút, trần 1 giờ, dung sai 5 s", () => {
    expect(HOLD_RECHECK_POLICY).toMatchObject({ baseMs: MIN, maxMs: HOUR, deferMs: MIN, slackMs: 5 * SEC });
  });

  it("outbox: backoff 10 s → trần 1 giờ, lease 1 phút; breaker 5 phút, ngân sách 24 giờ, hoãn 1 phút", () => {
    expect(OUTBOX_POLICY).toMatchObject({ baseDelayMs: 10_000, maxDelayMs: HOUR, claimLeaseMs: MIN });
    expect(OUTBOX_BREAKER_POLICY).toMatchObject({
      cooldownMs: 300_000,
      budgetWindowMs: DAY,
      throttleDeferMs: MIN,
    });
  });

  it("outbox: ngân sách querydr = 100 đơn × 1 440 lượt/ngày", () => {
    expect(Object.values(OUTBOX_BREAKER_POLICY.budgets)).toContain(144_000);
  });

  it("Retry-After giây → ms: 0, số lớn kẹp trần, ngày tương lai", () => {
    expect(parseRetryAfterMs("0", new Date(0), HOUR)).toBe(0);
    expect(parseRetryAfterMs("30", new Date(0), HOUR)).toBe(30 * SEC);
    expect(parseRetryAfterMs("86400", new Date(0), HOUR)).toBe(HOUR);
    expect(parseRetryAfterMs("abc", new Date(0), HOUR)).toBeNull();
  });

  it("rate limit cửa sổ: đơn, store, webhook, auth, deny-throttle", () => {
    expect(ORDER_RATE_LIMITS.lookupPhone.windowMs).toBe(HOUR);
    expect(ORDER_RATE_LIMITS.lookupIp.windowMs).toBe(HOUR);
    expect(ORDER_RATE_LIMITS.lookupRef.windowMs).toBe(HOUR);
    for (const k of ["viewIpRef", "deniedIp", "sessionIp", "cancelIpRef"] as const)
      expect(ORDER_RATE_LIMITS[k].windowMs).toBe(600_000);
    expect(STORE_RATE_LIMITS.searchIp.windowMs).toBe(MIN);
    expect(STORE_RATE_LIMITS.quoteIp.windowMs).toBe(MIN);
    expect(STORE_RATE_LIMITS.couponIp.windowMs).toBe(HOUR);
    expect(STORE_RATE_LIMITS.couponCart.windowMs).toBe(HOUR);
    expect(STORE_RATE_LIMITS.submitIp.windowMs).toBe(600_000);
    expect(STORE_RATE_LIMITS.submitCart.windowMs).toBe(600_000);
    expect(WEBHOOK_RATE_LIMITS.ghnCallbackIp.windowMs).toBe(10_000);
    expect(WEBHOOK_RATE_LIMITS.vnpayIpnIp.windowMs).toBe(10_000);
    expect(AUTH_RATE_LIMITS.windowSeconds).toBe(900);
    expect(DENY_AUDIT_THROTTLE.windowMs).toBe(MIN);
  });

  it("truy cập đơn: phiên 7 ngày, liên kết 15 phút", () => {
    expect(ORDER_ACCESS_CONFIG).toEqual({ accessTtlMs: 7 * DAY, linkTtlMs: 900_000 });
  });

  it("GHN: báo phí 10 phút, timeout 10 s, backoff trần 2 s, ngân sách 3 s, Retry-After trần 1 giờ", () => {
    expect(SHIPPING_CONFIG).toMatchObject({ feeQuoteTtlMs: 600_000, requestTimeoutMs: 10_000 });
    expect(GHN_RETRY_POLICY).toMatchObject({
      maxDelayMs: 2_000,
      totalBudgetMs: 3_000,
      maxRetryAfterMs: HOUR,
    });
  });

  it("catalog revalidate: cửa sổ 2 s, ân hạn 10 s, nguội 5 s/30 s, chậm 1 s, Retry-After trần 1 giờ", () => {
    expect(CATALOG_REVALIDATE_POLICY).toMatchObject({
      windowMs: 2_000,
      dispatchGraceMs: 10_000,
      requestTimeoutMs: 2_000,
      unavailableCooldownMs: 5_000,
      maxUnavailableCooldownMs: 30_000,
      slowResponseMs: 1_000,
      maxRetryAfterMs: HOUR,
    });
  });

  it("hạ tầng: timeout DB/Redis", () => {
    expect(DB_TIMEOUTS).toMatchObject({
      connectTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: MIN,
      poolIdleTimeoutMs: 30_000,
      poolAcquireTimeoutMs: MIN,
    });
    expect(REDIS_TIMEOUTS).toMatchObject({ connectTimeoutMs: 5_000, commandTimeoutMs: 5_000 });
  });

  it("đối soát/hoàn trả: lệch đồng hồ 1 ngày, chờ khoá 10 s/15 s", () => {
    expect(SETTLEMENT_CONFIG).toMatchObject({ futureSkewMs: DAY, importLockWaitMs: 10_000 });
    expect(RETURNS_CONFIG.lockWaitMs).toBe(15_000);
    expect(RETURNS_CONFIG.refundApprovalThresholdVnd).toBe(1_000_000);
  });
});

describe("hằng đơn lẻ và cấu hình env sau khi thay hằng thời lượng (số trần viết tay)", () => {
  it("hằng export đơn lẻ", () => {
    expect(S3_TIMEOUTS).toEqual({
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      socketIdleTimeoutMs: 30_000,
    });
    expect(LOCK_CALL_TIMEOUT_MS).toBe(3_000);
    expect(RESET_WORK_MAX_DELAY_MS).toBe(5_000);
    expect(ABORT_WAIT_MS).toBe(15_000);
    expect(READINESS_PROBE_TIMEOUT_MS).toBe(1_000);
    expect(DRAIN_WAIT_SLICE_MS).toBe(2_000);
    expect(DRAIN_SCHEDULED_WAIT_MS).toBe(300_000); // = LOCK_WAIT_MS của indexer
    expect(IMPORT_LOCK_WAIT_MS).toBe(300_000);
    expect(COD_OVERDUE_EXCEPTION_DUE_MS).toBe(14_400_000);
    expect(STALE_ATTEMPT_LOCK_WAIT_MS).toBe(1_000);
  });

  it("job outbox-dispatch chạy mỗi 10 giây", () => {
    expect(outboxDispatchConfig.schedule.interval).toBe(10_000);
  });

  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db" };
  const parse = (extra: Record<string, string> = {}) => parseEnv({ ...base, ...extra });
  const okValue = (key: string, v: string) => {
    const r = parse({ [key]: v });
    return r.ok ? (r.env as unknown as Record<string, unknown>)[key] : "ĐỎ";
  };

  it.each([
    // [biến, mặc định, min, max] — số trần của giá trị cũ
    ["DB_STATEMENT_TIMEOUT_MS", 30_000, 1_000, 3_600_000],
    ["SHUTDOWN_TIMEOUT_MS", 25_000, 1_000, 300_000],
    ["ADMIN_SESSION_MAX_AGE_SECONDS", 28_800, 300, 86_400],
    ["ADMIN_SESSION_IDLE_SECONDS", 1_800, 60, 28_800],
    ["ADMIN_REAUTH_MAX_AGE_SECONDS", 300, 30, 900],
  ] as const)("%s: mặc định %i, cận [%i, %i]", (key, def, min, max) => {
    expect(okValue(key, "")).toBe(def);
    const r0 = parse();
    expect(r0.ok && (r0.env as unknown as Record<string, unknown>)[key]).toBe(def);
    expect(okValue(key, String(min))).toBe(min);
    expect(okValue(key, String(max))).toBe(max);
    expect(parse({ [key]: String(min - 1) }).ok).toBe(false);
    expect(parse({ [key]: String(max + 1) }).ok).toBe(false);
  });

  it("SHUTDOWN_DRAIN_DELAY_MS: trần 60 000 ms (60 000 hợp lệ, 60 001 không); production mặc định 5 000 ms", () => {
    expect(parse({ SHUTDOWN_DRAIN_DELAY_MS: "60000", SHUTDOWN_TIMEOUT_MS: "300000" }).ok).toBe(true);
    expect(parse({ SHUTDOWN_DRAIN_DELAY_MS: "60001", SHUTDOWN_TIMEOUT_MS: "300000" }).ok).toBe(false);
    const dev = parse();
    expect(dev.ok && dev.env.shutdown).toEqual({ drainDelayMs: 0, timeoutMs: 25_000 });
    const prod = parseEnv(PRODUCTION_ENV);
    expect(prod.ok && prod.env.shutdown).toEqual({ drainDelayMs: 5_000, timeoutMs: 25_000 });
  });
});
