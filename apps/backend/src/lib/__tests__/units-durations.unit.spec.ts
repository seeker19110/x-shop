import { RETURNS_CONFIG } from "../../modules/returns/constants";
import { SETTLEMENT_CONFIG } from "../../modules/settlement/constants";
import { AUTH_RATE_LIMITS } from "../admin-security/config";
import { DENY_AUDIT_THROTTLE } from "../audit/deny-throttle";
import { CATALOG_REVALIDATE_POLICY } from "../catalog/revalidate";
import { CHECKOUT_CONFIG } from "../checkout/config";
import { HOLD_RECHECK_POLICY } from "../checkout/hold-recheck";
import { WEBHOOK_RATE_LIMITS } from "../http/webhook-rate-limit";
import { DB_TIMEOUTS, REDIS_TIMEOUTS } from "../infra/timeouts";
import { ORDER_ACCESS_CONFIG } from "../orders/access";
import { ORDER_RATE_LIMITS } from "../orders/rate-limit";
import { OUTBOX_BREAKER_POLICY } from "../outbox/breaker";
import { OUTBOX_POLICY } from "../outbox/policy";
import { parseRetryAfterMs } from "../outbox/retry";
import { STORE_RATE_LIMITS } from "../security/rate-limit";
import { GHN_RETRY_POLICY, SHIPPING_CONFIG } from "../shipping/config";

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
