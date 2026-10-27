import {
  backoffDelayMs,
  exponentialDelayMs,
  isPermanentStatus,
  isTransientStatus,
  parseRetryAfterMs,
  PermanentError,
  retryInfoOf,
  withRetry,
  type RetryDecision,
  type RetryPolicy,
} from "../retry";
import { OUTBOX_POLICY, outboxBackoffMs, outboxNextDelayMs } from "../policy";

/**
 * T-093 — ARC-RES-002, BE-JOB-003, BE-REL-003: hàm delay (mũ, jitter, trần), Retry-After, phân loại lỗi, retry phía dịch
 * vụ. Test thống kê dùng RNG có hạt giống (mulberry32) → cùng chuỗi số mỗi lần chạy, không flaky.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POLICY = { baseDelayMs: 1_000, maxDelayMs: 60_000 } as const;

describe("backoffDelayMs — mũ, jitter, trần", () => {
  it("không jitter: 1s, 2s, 4s… kẹp trần; lần hỏng lạ (0, âm, NaN, số thực) coi như lần 1; số rất lớn không tràn", () => {
    const none = { ...POLICY, jitter: "none" as const };
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelayMs(n, none))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
    ]);
    for (const n of [0, -3, Number.NaN, 1.5, Number.POSITIVE_INFINITY])
      expect(backoffDelayMs(n, none)).toBe(1_000);
    expect(exponentialDelayMs(5_000, POLICY)).toBe(60_000);
    expect(backoffDelayMs(Number.MAX_SAFE_INTEGER, none)).toBe(60_000);
  });

  it("equal jitter: mọi mẫu trong [exp/2, exp), số nguyên, trung bình ≈ 0,75·exp, trải đều (RNG có hạt giống)", () => {
    const rng = mulberry32(93);
    for (const n of [1, 3, 6, 12]) {
      const exp = exponentialDelayMs(n, POLICY);
      const samples = Array.from({ length: 5_000 }, () =>
        backoffDelayMs(n, { ...POLICY, jitter: "equal" }, rng),
      );
      for (const d of samples) {
        expect(Number.isSafeInteger(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(exp / 2);
        expect(d).toBeLessThan(exp);
      }
      const mean = samples.reduce((s, d) => s + d, 0) / samples.length;
      expect(Math.abs(mean / exp - 0.75)).toBeLessThan(0.01);
      // Trải đều: mỗi phần tư của khoảng [exp/2, exp) có 20–30 % mẫu.
      const buckets = [0, 0, 0, 0];
      for (const d of samples) buckets[Math.min(3, Math.floor(((d - exp / 2) / (exp / 2)) * 4))]! += 1;
      for (const b of buckets) expect(b / samples.length).toBeGreaterThan(0.2);
      for (const b of buckets) expect(b / samples.length).toBeLessThan(0.3);
    }
  });

  it("full jitter: trong [0, exp), trung bình ≈ exp/2; không bao giờ vượt trần kể cả ở lần hỏng rất lớn", () => {
    const rng = mulberry32(7);
    const exp = exponentialDelayMs(4, POLICY);
    const samples = Array.from({ length: 5_000 }, () =>
      backoffDelayMs(4, { ...POLICY, jitter: "full" }, rng),
    );
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThan(exp);
    const mean = samples.reduce((s, d) => s + d, 0) / samples.length;
    expect(Math.abs(mean / exp - 0.5)).toBeLessThan(0.02);
    for (let i = 0; i < 1_000; i++)
      expect(backoffDelayMs(40, { ...POLICY, jitter: "full" }, rng)).toBeLessThan(POLICY.maxDelayMs);
  });

  it("RNG tiêm sai (≥ 1, âm, NaN) không làm vượt trần hay ra số âm", () => {
    const equal = { ...POLICY, jitter: "equal" as const };
    expect(backoffDelayMs(1, equal, () => 1)).toBeLessThan(1_000);
    expect(backoffDelayMs(1, equal, () => 5)).toBeLessThan(1_000);
    expect(backoffDelayMs(1, equal, () => -1)).toBe(500);
    expect(backoffDelayMs(1, equal, () => Number.NaN)).toBe(500);
    expect(backoffDelayMs(30, equal, () => 1 - 1e-9)).toBeLessThan(POLICY.maxDelayMs);
  });
});

describe("outboxBackoffMs / outboxNextDelayMs — chính sách outbox", () => {
  it("lượt hữu hạn, mũ 10s → trần 1 giờ, equal jitter; RNG tiêm → tất định", () => {
    expect(OUTBOX_POLICY).toMatchObject({ maxAttempts: 8, jitter: "equal", maxDelayMs: 3600_000 });
    expect(outboxBackoffMs(1, () => 0)).toBe(5_000);
    expect(outboxBackoffMs(1, () => 0.5)).toBe(7_500);
    expect(outboxBackoffMs(3, () => 0)).toBe(20_000);
    expect(outboxBackoffMs(20, () => 0.999)).toBeLessThan(3600_000);
    expect(outboxBackoffMs(20, () => 0)).toBe(1800_000);
    // Không tiêm RNG → vẫn trong khoảng.
    for (let i = 0; i < 200; i++) {
      const d = outboxBackoffMs(2);
      expect(d).toBeGreaterThanOrEqual(10_000);
      expect(d).toBeLessThan(20_000);
    }
  });

  it("Retry-After lớn hơn backoff → theo Retry-After; vẫn kẹp trần một lần chờ; null → backoff", () => {
    expect(outboxNextDelayMs(1, 120_000, () => 0)).toBe(120_000);
    expect(outboxNextDelayMs(1, 1_000, () => 0)).toBe(5_000);
    expect(outboxNextDelayMs(1, 24 * 3600_000, () => 0)).toBe(3600_000);
    expect(outboxNextDelayMs(2, null, () => 0)).toBe(10_000);
  });
});

describe("parseRetryAfterMs — RFC 9110 §10.2.3", () => {
  const now = new Date("2026-10-27T08:00:00.000Z");
  const MAX = 3600_000;
  it("delay-seconds: số nguyên không dấu → ms, kẹp trần; 0 hợp lệ; số khổng lồ → trần", () => {
    expect(parseRetryAfterMs("120", now, MAX)).toBe(120_000);
    expect(parseRetryAfterMs(" 5 ", now, MAX)).toBe(5_000);
    expect(parseRetryAfterMs("0", now, MAX)).toBe(0);
    expect(parseRetryAfterMs("007", now, MAX)).toBe(7_000);
    expect(parseRetryAfterMs("86400", now, MAX)).toBe(MAX);
    expect(parseRetryAfterMs("9999999999999999", now, MAX)).toBe(MAX);
  });
  it("HTTP-date IMF-fixdate: tương lai → khoảng cách; đã qua → 0; xa → trần", () => {
    expect(parseRetryAfterMs("Tue, 27 Oct 2026 08:01:30 GMT", now, MAX)).toBe(90_000);
    expect(parseRetryAfterMs("Tue, 27 Oct 2026 07:00:00 GMT", now, MAX)).toBe(0);
    expect(parseRetryAfterMs("Wed, 28 Oct 2026 08:00:00 GMT", now, MAX)).toBe(MAX);
  });
  it("giá trị lạ → null (bỏ qua, dùng backoff)", () => {
    for (const v of [
      undefined,
      null,
      "",
      "  ",
      "-5",
      "1.5",
      "+3",
      "soon",
      "12abc",
      "2026-10-27T08:01:00Z",
      "Tuesday, 27-Oct-26 08:01:30 GMT",
      "Tue Oct 27 08:01:30 2026",
      "Tue, 27 Oct 2026 08:01:30 UTC",
      "Sat, 31 Feb 2026 08:00:00 GMT",
      "Mon, 27 Oct 2026 08:01:30 GMT",
      "Tue, 27 Oct 2026 25:00:00 GMT",
      "٣٠",
    ]) {
      expect(parseRetryAfterMs(v, now, MAX)).toBeNull();
    }
  });
});

describe("phân loại lỗi — vĩnh viễn vs tạm thời", () => {
  it("HTTP: 408/429/5xx tạm thời; 4xx khác vĩnh viễn; 2xx/3xx không phải lỗi", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(isTransientStatus(s)).toBe(true);
      expect(isPermanentStatus(s)).toBe(false);
    }
    for (const s of [400, 401, 403, 404, 409, 410, 422]) {
      expect(isTransientStatus(s)).toBe(false);
      expect(isPermanentStatus(s)).toBe(true);
    }
    for (const s of [200, 204, 302]) {
      expect(isTransientStatus(s)).toBe(false);
      expect(isPermanentStatus(s)).toBe(false);
    }
  });

  it("retryInfoOf: PermanentError, ZodError, cờ permanent, status 4xx (kể cả trong cause) → vĩnh viễn; 408/429/5xx/lỗi thường → tạm", () => {
    expect(retryInfoOf(new PermanentError("x", "bad"))).toEqual({ permanent: true, retryAfterMs: null });
    expect(retryInfoOf(Object.assign(new Error("z"), { name: "ZodError" })).permanent).toBe(true);
    expect(retryInfoOf({ permanent: true }).permanent).toBe(true);
    expect(retryInfoOf(Object.assign(new Error("422"), { status: 422 })).permanent).toBe(true);
    expect(retryInfoOf(Object.assign(new Error("400"), { statusCode: 400 })).permanent).toBe(true);
    const wrapped = new Error("gửi lỗi — ***", { cause: Object.assign(new Error("SMTP"), { status: 400 }) });
    expect(retryInfoOf(wrapped).permanent).toBe(true);
    for (const status of [408, 429, 503]) {
      expect(retryInfoOf(Object.assign(new Error("t"), { status })).permanent).toBe(false);
    }
    expect(retryInfoOf(new Error("SMTP 503"))).toEqual({ permanent: false, retryAfterMs: null });
    expect(retryInfoOf("chuỗi")).toEqual({ permanent: false, retryAfterMs: null });
    expect(retryInfoOf(null)).toEqual({ permanent: false, retryAfterMs: null });
  });

  it("retryInfoOf: retryAfterMs đọc ở tầng nông nhất có giá trị hợp lệ; âm/NaN bỏ qua; chuỗi cause vòng không treo", () => {
    const inner = Object.assign(new Error("429"), { status: 429, retryAfterMs: 30_000 });
    expect(retryInfoOf(new Error("bọc", { cause: inner }))).toEqual({
      permanent: false,
      retryAfterMs: 30_000,
    });
    expect(retryInfoOf({ retryAfterMs: -1 }).retryAfterMs).toBeNull();
    expect(retryInfoOf({ retryAfterMs: Number.NaN }).retryAfterMs).toBeNull();
    const loop: Record<string, unknown> = { message: "vòng" };
    loop.cause = loop;
    expect(retryInfoOf(loop)).toEqual({ permanent: false, retryAfterMs: null });
  });
});

describe("withRetry — chính sách retry phía dịch vụ (BE-REL-003)", () => {
  const policy: RetryPolicy = {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    jitter: "full",
    totalBudgetMs: 5_000,
  };
  class HttpErr extends Error {
    constructor(
      readonly status: number,
      readonly retryAfterMs: number | null = null,
    ) {
      super(`http_${status}`);
    }
  }
  const classify = (e: unknown): RetryDecision => {
    if (e instanceof HttpErr) {
      if (e.status === 429)
        return e.retryAfterMs === null
          ? { retry: false }
          : { retry: true, processed: "no", retryAfterMs: e.retryAfterMs };
      if (e.status >= 500) return { retry: true, processed: "maybe", retryAfterMs: null };
      return { retry: false };
    }
    if (e instanceof Error && e.name === "TimeoutError")
      return { retry: true, processed: "maybe", retryAfterMs: null };
    return { retry: false };
  };
  /** Đồng hồ giả: sleep tiến đồng hồ đúng số ms → đo được tổng thời gian chờ. */
  function harness(seed = 1) {
    let t = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      deps: {
        sleep: async (ms: number) => {
          sleeps.push(ms);
          t += ms;
        },
        now: () => t,
        random: mulberry32(seed),
      },
    };
  }
  const failing = (errs: unknown[], value = "ok") => {
    const calls: number[] = [];
    const op = async (attempt: number) => {
      calls.push(attempt);
      const e = errs[calls.length - 1];
      if (e !== undefined) throw e;
      return value;
    };
    return { op, calls };
  };

  it("503 liên tục → gọi đúng 3 lần (mặc định) rồi ném lỗi gốc; mỗi lần chờ trong [0, base·2^(n−1))", async () => {
    const h = harness();
    const { op, calls } = failing([new HttpErr(503), new HttpErr(503), new HttpErr(503), new HttpErr(503)]);
    const err = await withRetry(op, { policy, idempotent: true, classify, ...h.deps }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpErr);
    expect((err as HttpErr).status).toBe(503);
    expect(calls).toEqual([1, 2, 3]);
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps[0]).toBeLessThan(100);
    expect(h.sleeps[1]).toBeLessThan(200);
  });

  it("503 rồi thành công → trả kết quả, không gọi thừa", async () => {
    const h = harness();
    const { op, calls } = failing([new HttpErr(503)], "xong");
    await expect(withRetry(op, { policy, idempotent: true, classify, ...h.deps })).resolves.toBe("xong");
    expect(calls).toEqual([1, 2]);
  });

  it.each([400, 401, 403, 404, 409, 422])("%i → không retry (1 lần gọi, không chờ)", async (status) => {
    const h = harness();
    const { op, calls } = failing([new HttpErr(status)]);
    await expect(withRetry(op, { policy, idempotent: true, classify, ...h.deps })).rejects.toMatchObject({
      status,
    });
    expect(calls).toEqual([1]);
    expect(h.sleeps).toEqual([]);
  });

  it("POST không idempotent: timeout/5xx → KHÔNG retry tự động (có thể bên kia đã xử lý)", async () => {
    for (const e of [Object.assign(new Error("t"), { name: "TimeoutError" }), new HttpErr(502)]) {
      const h = harness();
      const { op, calls } = failing([e]);
      await expect(withRetry(op, { policy, idempotent: false, classify, ...h.deps })).rejects.toBe(e);
      expect(calls).toEqual([1]);
    }
  });

  it("429 kèm Retry-After → chờ ĐÚNG Retry-After (lớn hơn backoff) rồi gửi lại, kể cả thao tác không idempotent", async () => {
    const h = harness();
    const { op, calls } = failing([new HttpErr(429, 1_500)], "tạo xong");
    await expect(withRetry(op, { policy, idempotent: false, classify, ...h.deps })).resolves.toBe("tạo xong");
    expect(calls).toEqual([1, 2]);
    expect(h.sleeps).toEqual([1_500]);
  });

  it("429 không kèm Retry-After → không retry ngay", async () => {
    const h = harness();
    const { op, calls } = failing([new HttpErr(429, null)]);
    await expect(withRetry(op, { policy, idempotent: true, classify, ...h.deps })).rejects.toMatchObject({
      status: 429,
    });
    expect(calls).toEqual([1]);
  });

  it("trần tổng thời gian: Retry-After vượt ngân sách → không ngủ, ném lỗi gốc (còn retryAfterMs cho caller hẹn lại)", async () => {
    const h = harness();
    const { op, calls } = failing([new HttpErr(429, 60_000)]);
    const err = await withRetry(op, { policy, idempotent: true, classify, ...h.deps }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 429, retryAfterMs: 60_000 });
    expect(calls).toEqual([1]);
    expect(h.sleeps).toEqual([]);
  });

  it("trần tổng thời gian tính cả thời gian các lần gọi đã tốn", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const calls: number[] = [];
    const op = async (attempt: number) => {
      calls.push(attempt);
      t += 4_950; // lần gọi treo gần hết ngân sách rồi mới lỗi (4 950 + chờ 99 > 5 000)
      throw new HttpErr(503);
    };
    await expect(
      withRetry(op, {
        policy,
        idempotent: true,
        classify,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
        now: () => t,
        random: () => 0.99,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toEqual([1]);
    expect(sleeps).toEqual([]);
  });

  it("maxAttempts lạ (0, âm) → vẫn gọi đúng 1 lần", async () => {
    for (const maxAttempts of [0, -2]) {
      const h = harness();
      const { op, calls } = failing([new HttpErr(503)]);
      await expect(
        withRetry(op, { policy: { ...policy, maxAttempts }, idempotent: true, classify, ...h.deps }),
      ).rejects.toMatchObject({ status: 503 });
      expect(calls).toEqual([1]);
    }
  });

  it("đồng thời: 50 lời gọi song song cùng hỏng một lần → mỗi lời gọi đúng 2 lần, chờ được jitter giãn ra (không dồn cục)", async () => {
    const rng = mulberry32(2026);
    const sleeps: number[] = [];
    const counts = new Map<number, number>();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        withRetry(
          async () => {
            const n = (counts.get(i) ?? 0) + 1;
            counts.set(i, n);
            if (n === 1) throw new HttpErr(503);
            return i;
          },
          {
            policy: { ...policy, baseDelayMs: 1_000, maxDelayMs: 1_000 },
            idempotent: true,
            classify,
            sleep: async (ms) => {
              sleeps.push(ms);
              await Promise.resolve();
            },
            random: rng,
          },
        ),
      ),
    );
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
    expect(sleeps).toHaveLength(50);
    // Full jitter trên [0, 1000): ≥ 40 giá trị khác nhau và phủ cả nửa dưới lẫn nửa trên.
    expect(new Set(sleeps).size).toBeGreaterThanOrEqual(40);
    expect(sleeps.some((s) => s < 500)).toBe(true);
    expect(sleeps.some((s) => s >= 500)).toBe(true);
  });
});
