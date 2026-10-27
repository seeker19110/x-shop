/**
 * Circuit breaker chi phí cho job nền/outbox (T-097 — OPS-COST-004; ARC-RES-005 cho trạng thái dùng chung).
 *
 * Ba lớp trần, enforce bằng code:
 *  1. Theo LƯỢT CHẠY (`OUTBOX_RUN_LIMITS`): tối đa `maxIterations` vòng (sự kiện nhận) và `maxCalls` lượt gọi bộ xử lý —
 *     chạm trần thì dừng lượt, sự kiện còn lại chờ lượt sau (không nhận nên không mất).
 *  2. Theo BREAKER (một adapter/bộ xử lý, `breakerKeyOf`): `failureThreshold` sự kiện KHÁC NHAU lỗi tạm liên tiếp →
 *     `open` trong `cooldownMs`, không gọi dịch vụ ngoài; hết nguội → `half_open`, đúng MỘT lượt thử (probe) toàn hệ
 *     thống; thành công hoặc lỗi VĨNH VIỄN (dịch vụ đã trả lời — D-111) → `closed`, lỗi tạm → `open` lại. Một sự kiện
 *     thử lại nhiều lần chỉ tính một (đã có backoff/trần lần riêng — một sự kiện hỏng không được chặn cả adapter).
 *  3. Theo NGÂN SÁCH cửa sổ (ngày UTC, đếm ở `rate_limit_counter`): ≥ 80 % → cảnh báo (log một lần), ≥ 90 % → bóp
 *     (mỗi lượt chạy tối đa `throttledCallsPerRun` lượt gọi cho breaker đó), vượt 100 % → `open` tới hết cửa sổ.
 *
 * Breaker mở (lỗi hoặc ngân sách) → đúng MỘT bản sao thắng câu chuyển trạng thái → mở ngoại lệ vận hành
 * `job_circuit_open` (dispatcher gọi `onTrip`). Sự kiện bị hoãn chỉ dời `next_attempt_at` (không tăng `attempts`) — vẫn
 * nằm trong outbox.
 *
 * Trạng thái breaker và bộ đếm ngân sách nằm ở Postgres (`job_breaker`, `rate_limit_counter`) — mọi bản sao thấy cùng
 * trạng thái. `BreakerRun` chỉ giữ số liệu CỦA MỘT lượt chạy (số lượt gọi, mức ngân sách vừa thấy, hạn hoãn đã biết) và
 * bỏ đi khi lượt kết thúc.
 */
import type { JobBreakerTripReason } from "../../modules/checkout/models/constants";
import type { JobBreakerSnapshot } from "../../modules/checkout/service";
import { isNotificationEvent } from "../notify/notify";
import { windowStartMs, type WindowSample } from "../security/sliding-window";
import { OUTBOX_POLICY } from "./policy";

/** Kho trạng thái DÙNG CHUNG (= các phương thức của `CheckoutModuleService`; test tiêm bản giả cùng ngữ nghĩa). */
export interface BreakerStore {
  readJobBreaker(key: string): Promise<JobBreakerSnapshot | null>;
  claimJobBreakerProbe(key: string, now: Date, probeUntil: Date): Promise<boolean>;
  recordJobBreakerFailure(key: string, eventId: string): Promise<JobBreakerSnapshot>;
  recordJobBreakerSuccess(key: string): Promise<boolean>;
  tripJobBreaker(
    key: string,
    reason: JobBreakerTripReason,
    openUntil: Date,
    from: readonly ("closed" | "half_open")[],
  ): Promise<boolean>;
  hitRateCounter(bucket: string, windowMs: number, now: Date): Promise<WindowSample>;
}

export interface OutboxRunLimits {
  /** Trần số vòng (sự kiện nhận) mỗi lượt chạy. */
  maxIterations: number;
  /** Trần số lượt gọi bộ xử lý (dịch vụ ngoài) mỗi lượt chạy, mọi breaker cộng lại. */
  maxCalls: number;
}

/** Job chạy mỗi 10 giây → tối đa 50 lượt gọi/lượt chạy ≈ 5 lượt/giây; ngân sách ngày chặn tổng (bên dưới). */
export const OUTBOX_RUN_LIMITS: OutboxRunLimits = { maxIterations: 100, maxCalls: 50 };

export interface OutboxBreakerPolicy {
  /** Số sự kiện KHÁC NHAU lỗi tạm liên tiếp để mở breaker. */
  failureThreshold: number;
  /** Thời gian nguội sau khi mở vì lỗi (ms). */
  cooldownMs: number;
  /** Hạn một lượt thử half-open (ms): lượt thử chết giữa chừng → hết hạn thì bản sao khác được thử. */
  probeLeaseMs: number;
  /** Cửa sổ ngân sách (ms) — cửa sổ cố định theo đồng hồ UTC (1 ngày → 00:00 UTC). */
  budgetWindowMs: number;
  /** Ngân sách lượt gọi mỗi cửa sổ theo breaker; breaker không khai → `defaultBudget`. */
  budgets: Readonly<Record<string, number>>;
  defaultBudget: number;
  /** Tỉ lệ ngân sách đã dùng: cảnh báo / bóp (dừng = vượt 100 %). */
  warnRatio: number;
  throttleRatio: number;
  /** Khi bóp: số lượt gọi tối đa mỗi lượt chạy cho breaker đó. */
  throttledCallsPerRun: number;
  /** Khi bóp: sự kiện vượt phần được gọi hoãn chừng này (ms). */
  throttleDeferMs: number;
}

/**
 * Ngưỡng mặc định (đổi qua review — OPS-COST-004 "cấu hình ngưỡng trong code có review"):
 *  - 5 sự kiện khác nhau lỗi liên tiếp → mở 5 phút; lượt thử half-open giữ 60 giây (= lease nhận sự kiện outbox);
 *  - ngân sách ngày: thông báo khách (email/SMS — trả phí theo tin) 3 000 lượt; bộ xử lý khác 10 000 lượt.
 */
export const OUTBOX_BREAKER_POLICY: OutboxBreakerPolicy = {
  failureThreshold: 5,
  cooldownMs: 5 * 60_000,
  probeLeaseMs: OUTBOX_POLICY.claimLeaseMs,
  budgetWindowMs: 24 * 3600_000,
  budgets: { "outbox.notify": 3_000 },
  defaultBudget: 10_000,
  warnRatio: 0.8,
  throttleRatio: 0.9,
  throttledCallsPerRun: 5,
  throttleDeferMs: 60_000,
};

/** Kiểm chính sách (số nguyên dương, tỉ lệ 0 < cảnh báo ≤ bóp ≤ 1) — sai là lỗi lập trình, ném ngay. */
export function assertBreakerPolicy(p: OutboxBreakerPolicy, limits: OutboxRunLimits): void {
  const positive = {
    failureThreshold: p.failureThreshold,
    cooldownMs: p.cooldownMs,
    probeLeaseMs: p.probeLeaseMs,
    budgetWindowMs: p.budgetWindowMs,
    defaultBudget: p.defaultBudget,
    throttledCallsPerRun: p.throttledCallsPerRun,
    throttleDeferMs: p.throttleDeferMs,
    maxIterations: limits.maxIterations,
    maxCalls: limits.maxCalls,
    ...Object.fromEntries(Object.entries(p.budgets).map(([k, v]) => [`budgets.${k}`, v])),
  };
  for (const [name, v] of Object.entries(positive)) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new RangeError(`breaker: ${name} phải là số nguyên dương`);
  }
  if (!(p.warnRatio > 0 && p.warnRatio <= p.throttleRatio && p.throttleRatio <= 1)) {
    throw new RangeError("breaker: cần 0 < warnRatio ≤ throttleRatio ≤ 1");
  }
}

assertBreakerPolicy(OUTBOX_BREAKER_POLICY, OUTBOX_RUN_LIMITS);

/** Breaker của một loại sự kiện: mọi thông báo khách chung adapter gửi tin → `outbox.notify`; loại khác theo loại. */
export function breakerKeyOf(eventType: string): string {
  return isNotificationEvent(eventType) ? "outbox.notify" : `outbox.${eventType}`;
}

export const budgetBucket = (key: string) => `breaker.budget:${key}`;

export function budgetOf(policy: OutboxBreakerPolicy, key: string): number {
  return policy.budgets[key] ?? policy.defaultBudget;
}

export type BudgetLevel = "ok" | "warn" | "throttle" | "exhausted";

/** Mức ngân sách khi `used` lượt (gồm lượt đang xét) đã được đếm trong cửa sổ: vượt `limit` = hết. */
export function budgetLevel(used: number, limit: number, policy: OutboxBreakerPolicy): BudgetLevel {
  if (used > limit) return "exhausted";
  if (used >= Math.ceil(policy.throttleRatio * limit)) return "throttle";
  if (used >= Math.ceil(policy.warnRatio * limit)) return "warn";
  return "ok";
}

export type Admission =
  | { kind: "call"; probe: boolean }
  | {
      kind: "defer";
      until: Date;
      reason: "open" | "probing" | "throttled" | "budget_exhausted";
    };

/** Một lần breaker mở (đúng một bản sao nhận) — dispatcher mở ngoại lệ vận hành. Chỉ id/số — không PII. */
export interface BreakerTrip {
  key: string;
  reason: JobBreakerTripReason;
  openUntil: Date;
  consecutiveFailures?: number;
  budgetUsed?: number;
  budgetLimit?: number;
}

export interface BreakerHooks {
  onTrip(trip: BreakerTrip): Promise<void>;
  warn(message: string): void;
  info(message: string): void;
}

/** Breaker trong MỘT lượt chạy dispatcher. Trạng thái thật ở `store`; đối tượng này bỏ đi khi lượt kết thúc. */
export class BreakerRun {
  /** Tổng lượt gọi bộ xử lý của lượt chạy này (mọi breaker). */
  calls = 0;
  private readonly callsByKey = new Map<string, number>();
  private readonly levelByKey = new Map<string, BudgetLevel>();
  /** Hạn hoãn đã biết trong lượt này (breaker vừa thấy mở) — đỡ đọc DB cho từng sự kiện cùng breaker. */
  private readonly deferUntil = new Map<
    string,
    { until: Date; reason: "open" | "probing" | "budget_exhausted" }
  >();

  constructor(
    private readonly store: BreakerStore,
    private readonly policy: OutboxBreakerPolicy,
    private readonly hooks: BreakerHooks,
  ) {}

  private defer(
    key: string,
    until: Date,
    reason: "open" | "probing" | "budget_exhausted",
  ): Admission & { kind: "defer" } {
    this.deferUntil.set(key, { until, reason });
    return { kind: "defer", until, reason };
  }

  /** Có được gọi bộ xử lý cho sự kiện của breaker `key` lúc `now` không; không → hoãn tới `until`. */
  async admit(key: string, now: Date): Promise<Admission> {
    const known = this.deferUntil.get(key);
    if (known && known.until > now) return { kind: "defer", until: known.until, reason: known.reason };

    // Bóp (≥ 90 % ngân sách): xét TRƯỚC khi đụng trạng thái chung — không giữ lượt thử, không đếm thêm ngân sách.
    const used = this.callsByKey.get(key) ?? 0;
    if (this.levelByKey.get(key) === "throttle" && used >= this.policy.throttledCallsPerRun) {
      return {
        kind: "defer",
        until: new Date(now.getTime() + this.policy.throttleDeferMs),
        reason: "throttled",
      };
    }

    let probe = false;
    let snap = await this.store.readJobBreaker(key);
    if (snap && snap.state !== "closed") {
      const until = snap.state === "open" ? snap.open_until : snap.probe_until;
      if (until && until > now) return this.defer(key, until, snap.state === "open" ? "open" : "probing");
      probe = await this.store.claimJobBreakerProbe(
        key,
        now,
        new Date(now.getTime() + this.policy.probeLeaseMs),
      );
      if (!probe) {
        // Bản sao khác vừa nhận lượt thử (hoặc vừa đóng/mở lại) — đọc lại trạng thái mới nhất.
        snap = await this.store.readJobBreaker(key);
        if (snap && snap.state !== "closed") {
          const later = snap.state === "open" ? snap.open_until : snap.probe_until;
          const until = later && later > now ? later : new Date(now.getTime() + this.policy.probeLeaseMs);
          return this.defer(key, until, snap.state === "open" ? "open" : "probing");
        }
      }
    }

    const sample = await this.store.hitRateCounter(budgetBucket(key), this.policy.budgetWindowMs, now);
    const limit = budgetOf(this.policy, key);
    const level = budgetLevel(sample.current, limit, this.policy);
    if (level === "exhausted") {
      const windowEnd = new Date(
        windowStartMs(this.policy.budgetWindowMs, now.getTime()) + this.policy.budgetWindowMs,
      );
      const won = await this.store.tripJobBreaker(key, "budget_exhausted", windowEnd, [
        "closed",
        "half_open",
      ]);
      if (won) {
        this.hooks.warn(
          `[breaker] ${key}: hết ngân sách ${limit} lượt/cửa sổ — dừng gọi tới ${windowEnd.toISOString()}`,
        );
        await this.hooks.onTrip({
          key,
          reason: "budget_exhausted",
          openUntil: windowEnd,
          budgetUsed: limit,
          budgetLimit: limit,
        });
      }
      return this.defer(key, windowEnd, "budget_exhausted");
    }
    // Đếm nguyên tử → đúng một lượt (toàn hệ thống) chạm đúng mốc 80 %/90 % → log một lần mỗi cửa sổ.
    if (sample.current === Math.ceil(this.policy.warnRatio * limit)) {
      this.hooks.warn(`[breaker] ${key}: đã dùng ${sample.current}/${limit} lượt ngân sách (cảnh báo)`);
    }
    if (sample.current === Math.ceil(this.policy.throttleRatio * limit)) {
      this.hooks.warn(
        `[breaker] ${key}: đã dùng ${sample.current}/${limit} lượt ngân sách — bóp còn ` +
          `${this.policy.throttledCallsPerRun} lượt/lượt chạy`,
      );
    }
    this.levelByKey.set(key, level);
    this.callsByKey.set(key, used + 1);
    this.calls += 1;
    return { kind: "call", probe };
  }

  /**
   * Dịch vụ đã trả lời: lượt gọi thành công, hoặc lượt thử half-open nhận lỗi vĩnh viễn (D-111 — dispatcher chỉ gọi cho
   * lỗi vĩnh viễn khi đó là lượt thử). half_open → closed; closed → xoá đếm lỗi.
   */
  async onSuccess(key: string): Promise<void> {
    if (await this.store.recordJobBreakerSuccess(key)) {
      this.hooks.info(`[breaker] ${key}: lượt thử có trả lời — đóng breaker`);
    }
  }

  /**
   * Lỗi TẠM của sự kiện `eventId` (lỗi vĩnh viễn không phải tín hiệu adapter hỏng — không gọi hàm này). `half_open`
   * (lượt thử lỗi) → mở lại; `closed` đủ `failureThreshold` sự kiện khác nhau lỗi liên tiếp → mở.
   */
  async onFailure(key: string, eventId: string, now: Date): Promise<void> {
    const snap = await this.store.recordJobBreakerFailure(key, eventId);
    let from: "closed" | "half_open";
    if (snap.state === "half_open") from = "half_open";
    else if (snap.state === "closed" && snap.consecutive_failures >= this.policy.failureThreshold)
      from = "closed";
    else return;
    const openUntil = new Date(now.getTime() + this.policy.cooldownMs);
    if (!(await this.store.tripJobBreaker(key, "consecutive_failures", openUntil, [from]))) return;
    this.deferUntil.set(key, { until: openUntil, reason: "open" });
    this.hooks.warn(
      `[breaker] ${key}: ${from === "half_open" ? "lượt thử lỗi" : `${snap.consecutive_failures} sự kiện lỗi liên tiếp`}` +
        ` — dừng gọi tới ${openUntil.toISOString()}`,
    );
    await this.hooks.onTrip({
      key,
      reason: "consecutive_failures",
      openUntil,
      consecutiveFailures: snap.consecutive_failures,
    });
  }
}
