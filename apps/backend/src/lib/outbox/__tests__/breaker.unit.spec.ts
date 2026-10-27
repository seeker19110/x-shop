import { dispatchOutbox, type OutboxHandler } from "../../checkout/jobs";
import { CheckoutError } from "../../checkout/errors";
import {
  assertBreakerPolicy,
  breakerKeyOf,
  budgetLevel,
  OUTBOX_BREAKER_POLICY,
  OUTBOX_RUN_LIMITS,
  type OutboxBreakerPolicy,
} from "../breaker";
import { OUTBOX_POLICY } from "../policy";
import { fakeOutboxDb } from "./fake-outbox-store";

/**
 * T-097 (OPS-COST-004): circuit breaker chi phí của dispatcher outbox — trần mỗi lượt chạy, mở khi lỗi liên tiếp / hết
 * ngân sách, nguội → half-open → đóng, trạng thái dùng chung giữa các dispatcher (kho giả cùng ngữ nghĩa SQL — bản Postgres
 * thật: integration-tests/http/outbox-breaker.spec.ts), không mất sự kiện.
 */
const T0 = new Date("2026-10-27T08:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const KEY = "outbox.test.x";

const POLICY: OutboxBreakerPolicy = {
  ...OUTBOX_BREAKER_POLICY,
  failureThreshold: 3,
  cooldownMs: 60_000,
  probeLeaseMs: 10_000,
  budgets: { [KEY]: 10 },
  defaultBudget: 1_000,
  throttledCallsPerRun: 2,
  throttleDeferMs: 30_000,
};

const ids = (n: number, prefix = "e") =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
const events = (n: number, type = "test.x") => ids(n).map((id) => ({ id, type }));

/** Bộ xử lý ghi lại mỗi lượt gọi; `mode` đổi được giữa các lượt chạy. */
function recorder(initial: "fail" | "ok" | "permanent" = "fail") {
  const calls: string[] = [];
  let mode = initial;
  const handler: OutboxHandler = async (_c, e) => {
    calls.push(e.id);
    if (mode === "fail") throw Object.assign(new Error("ESP 503"), { status: 503 });
    if (mode === "permanent") throw new CheckoutError("VALIDATION");
  };
  return {
    calls,
    handlers: { "test.x": handler } as Record<string, OutboxHandler>,
    set: (m: typeof mode) => {
      mode = m;
    },
  };
}

const run = (
  db: ReturnType<typeof fakeOutboxDb>,
  now: Date,
  handlers: Record<string, OutboxHandler>,
  extra = {},
) => dispatchOutbox(db.container, { now, handlers, random: () => 0, breakerPolicy: POLICY, ...extra });

const breakerExceptions = (db: ReturnType<typeof fakeOutboxDb>) =>
  db.exceptions.filter((x) => x.kind === "job_circuit_open");

/** Không mất sự kiện: mỗi sự kiện hoặc đã gửi đúng một lần, hoặc vẫn chờ trong outbox (pending/failed) — không dead. */
function expectNoLoss(db: ReturnType<typeof fakeOutboxDb>, sentCalls: string[]) {
  for (const r of db.outbox) {
    expect(["pending", "failed", "sent"]).toContain(r.state);
  }
  const sent = db.outbox.filter((r) => r.state === "sent").map((r) => r.id);
  expect(new Set(sent).size).toBe(sent.length);
  for (const id of sent) expect(sentCalls).toContain(id);
}

describe("breaker — vượt ngưỡng lỗi → mở, không gọi bộ xử lý, có ngoại lệ", () => {
  it("3 sự kiện khác nhau lỗi liên tiếp → open; phần còn lại hoãn tới hết nguội, attempts không đổi", async () => {
    const db = fakeOutboxDb(events(6));
    const h = recorder("fail");
    const r = await run(db, T0, h.handlers);

    expect(h.calls).toEqual(["e01", "e02", "e03"]);
    expect(r.retried).toEqual(["test.x:e01", "test.x:e02", "test.x:e03"]);
    expect(r.deferred).toEqual(["test.x:e04", "test.x:e05", "test.x:e06"]);
    expect(db.breakers.get(KEY)).toMatchObject({ state: "open", trip_reason: "consecutive_failures" });
    expect(db.breakers.get(KEY)!.open_until).toEqual(at(60_000));
    for (const id of ["e04", "e05", "e06"]) {
      expect(db.outbox.find((x) => x.id === id)).toMatchObject({
        state: "pending",
        attempts: 0,
        next_attempt_at: at(60_000),
      });
    }
    const ex = breakerExceptions(db);
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({
      priority: "high",
      detail: {
        breaker: KEY,
        reason: "consecutive_failures",
        consecutive_failures: 3,
        open_until: at(60_000).toISOString(),
      },
    });
    expect(db.logs.some((l) => l.level === "warn" && l.message.includes(KEY))).toBe(true);
  });

  it("còn trong thời gian nguội: lượt chạy sau (sự kiện đã tới hạn) không gọi gì, không mở ngoại lệ trùng", async () => {
    const db = fakeOutboxDb(events(6));
    const h = recorder("fail");
    await run(db, T0, h.handlers);
    h.calls.length = 0;
    const r = await run(db, at(45_000), h.handlers);
    expect(h.calls).toEqual([]);
    // e01–e03 (backoff đã tới hạn) bị hoãn tiếp tới hết nguội.
    expect(r.deferred.sort()).toEqual(["test.x:e01", "test.x:e02", "test.x:e03"]);
    expect(breakerExceptions(db)).toHaveLength(1);
    expectNoLoss(db, h.calls);
  });

  it("lỗi xen thành công không mở (đếm LIÊN TIẾP); lỗi vĩnh viễn không tính", async () => {
    const db = fakeOutboxDb(events(8));
    const seq = ["fail", "fail", "ok", "fail", "fail", "permanent", "permanent", "ok"];
    let i = 0;
    const handler: OutboxHandler = async () => {
      const m = seq[i++];
      if (m === "fail") throw new Error("ESP 503");
      if (m === "permanent") throw new CheckoutError("VALIDATION");
    };
    const r = await run(db, T0, { "test.x": handler });
    expect(i).toBe(8);
    expect(r.deferred).toEqual([]);
    expect(db.breakers.get(KEY)).toMatchObject({ state: "closed", consecutive_failures: 0 });
    expect(breakerExceptions(db)).toEqual([]);
  });

  it("MỘT sự kiện thử lại tới dead không mở breaker (đã có backoff/trần lần riêng — giữ hợp đồng retry T-093)", async () => {
    const db = fakeOutboxDb(events(1));
    const h = recorder("fail");
    let now = T0;
    for (let n = 1; n < OUTBOX_POLICY.maxAttempts; n++) {
      expect((await run(db, now, h.handlers)).retried).toEqual(["test.x:e01"]);
      now = db.outbox[0]!.next_attempt_at;
    }
    expect((await run(db, now, h.handlers)).dead).toEqual(["test.x:e01"]);
    expect(h.calls).toHaveLength(OUTBOX_POLICY.maxAttempts);
    expect(db.breakers.get(KEY)).toMatchObject({ state: "closed", consecutive_failures: 1 });
    expect(breakerExceptions(db)).toEqual([]);
  });

  it("mở ngoại lệ lỗi → chỉ log, lượt chạy không sập, breaker vẫn mở", async () => {
    const db = fakeOutboxDb(events(5));
    db.failExceptionOpen(true);
    const h = recorder("fail");
    const r = await run(db, T0, h.handlers);
    expect(h.calls).toHaveLength(3);
    expect(r.deferred).toHaveLength(2);
    expect(db.breakers.get(KEY)!.state).toBe("open");
    expect(db.logs.some((l) => l.level === "error" && l.message.includes("job_circuit_open"))).toBe(true);
  });
});

describe("breaker — hết nguội → half-open → thành công thì đóng", () => {
  async function tripped() {
    const db = fakeOutboxDb(events(6));
    const h = recorder("fail");
    await run(db, T0, h.handlers);
    h.calls.length = 0;
    return { db, h };
  }

  it("lượt thử thành công → closed, phần còn lại gửi tiếp trong cùng lượt", async () => {
    const { db, h } = await tripped();
    h.set("ok");
    const r = await run(db, at(60_000), h.handlers);
    expect(h.calls.sort()).toEqual(ids(6));
    expect(r.sent).toHaveLength(6);
    expect(r.deferred).toEqual([]);
    expect(db.breakers.get(KEY)).toMatchObject({
      state: "closed",
      consecutive_failures: 0,
      open_until: null,
    });
    expect(db.logs.some((l) => l.level === "info" && l.message.includes("đóng breaker"))).toBe(true);
    expectNoLoss(db, h.calls);
    expect(db.outbox.every((x) => x.state === "sent")).toBe(true);
  });

  it("lượt thử lỗi → open lại thêm một kỳ nguội, chỉ đúng 1 lượt gọi; ngoại lệ đang mở không bị nhân đôi", async () => {
    const { db, h } = await tripped();
    const r = await run(db, at(60_000), h.handlers);
    expect(h.calls).toHaveLength(1);
    expect(r.deferred).toHaveLength(5);
    expect(db.breakers.get(KEY)).toMatchObject({ state: "open", trip_count: 2, open_until: at(120_000) });
    expect(breakerExceptions(db)).toHaveLength(1);
    expectNoLoss(db, h.calls);
  });

  it("ngoại lệ cũ đã xử lý xong mà breaker mở lại → ngoại lệ mới", async () => {
    const { db, h } = await tripped();
    breakerExceptions(db)[0]!.state = "resolved";
    await run(db, at(60_000), h.handlers);
    expect(breakerExceptions(db)).toHaveLength(2);
  });

  it("lượt thử bị bỏ dở (bản sao chết) → hết hạn lượt thử thì bản khác được thử", async () => {
    const { db, h } = await tripped();
    // Bản sao X nhận lượt thử rồi chết (không báo kết quả).
    expect(await db.service.claimJobBreakerProbe(KEY, at(60_000), at(70_000))).toBe(true);
    h.set("ok");
    const during = await run(db, at(65_000), h.handlers);
    expect(h.calls).toEqual([]);
    expect(during.deferred.length).toBeGreaterThan(0);
    const after = await run(db, at(70_000), h.handlers);
    expect(after.sent).toHaveLength(6);
    expect(db.breakers.get(KEY)!.state).toBe("closed");
  });
});

describe("breaker — hai dispatcher song song dùng chung trạng thái", () => {
  it("bản A mở breaker → bản B (không chung bộ nhớ, chỉ chung kho) hoãn, không gọi", async () => {
    const db = fakeOutboxDb(events(6));
    const a = recorder("fail");
    await run(db, T0, a.handlers);
    const b = recorder("ok");
    db.add({ id: "f01", type: "test.x", next_attempt_at: at(1_000) });
    const r = await run(db, at(2_000), b.handlers);
    expect(b.calls).toEqual([]);
    expect(r.deferred).toEqual(["test.x:f01"]);
  });

  it("hai lượt song song cùng lỗi: đúng MỘT lần mở + một ngoại lệ, lượt gọi ≤ ngưỡng + số bản đang bay, không mất sự kiện", async () => {
    const db = fakeOutboxDb(events(12));
    const h = recorder("fail");
    const [r1, r2] = await Promise.all([run(db, T0, h.handlers), run(db, T0, h.handlers)]);
    expect(new Set(h.calls).size).toBe(h.calls.length);
    expect(h.calls.length).toBeGreaterThanOrEqual(POLICY.failureThreshold);
    expect(h.calls.length).toBeLessThanOrEqual(POLICY.failureThreshold + 1);
    expect(db.breakers.get(KEY)).toMatchObject({ state: "open", trip_count: 1 });
    expect(breakerExceptions(db)).toHaveLength(1);
    expect([...r1.retried, ...r2.retried].length + [...r1.deferred, ...r2.deferred].length).toBe(12);
    expectNoLoss(db, h.calls);
  });

  it("half-open: hai lượt song song → đúng MỘT lượt thử; bản kia hoãn trong lúc lượt thử đang bay", async () => {
    const db = fakeOutboxDb(events(6));
    const h = recorder("fail");
    await run(db, T0, h.handlers);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const slow: OutboxHandler = async (_c, e) => {
      calls.push(e.id);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (calls.length === 1) await gate;
      inFlight--;
    };
    const now = at(60_000);
    const pA = run(db, now, { "test.x": slow });
    // Chờ lượt thử của A bắt đầu rồi mới chạy B.
    while (calls.length === 0) await new Promise((r) => setImmediate(r));
    const rB = await run(db, now, { "test.x": slow });
    expect(calls).toHaveLength(1);
    expect(rB.sent).toEqual([]);
    expect(rB.deferred.length).toBeGreaterThan(0);
    expect(db.breakers.get(KEY)!.state).toBe("half_open");
    release();
    const rA = await pA;
    expect(maxInFlight).toBe(1);
    expect(db.breakers.get(KEY)!.state).toBe("closed");
    // Sự kiện B đã hoãn chờ tới hạn lượt thử — vẫn trong outbox, lượt sau gửi nốt.
    const rC = await run(db, at(70_000), { "test.x": slow });
    const sent = [...rA.sent, ...rC.sent];
    expect(sent.sort()).toEqual(ids(6).map((id) => `test.x:${id}`));
    expect(db.outbox.every((x) => x.state === "sent")).toBe(true);
  });
});

describe("breaker — ngân sách cửa sổ: 80 % cảnh báo, 90 % bóp, vượt 100 % dừng", () => {
  it("đúng `limit` lượt gọi trong cửa sổ, rồi open tới hết ngày + ngoại lệ; ngày mới gửi nốt, không mất sự kiện", async () => {
    const db = fakeOutboxDb(events(15));
    const h = recorder("ok");

    const r1 = await run(db, T0, h.handlers);
    // 1..8 bình thường, 8 = 80 % (cảnh báo), 9 = 90 % → bóp: còn 2 lượt/lượt chạy (đã dùng 9 trong lượt này).
    expect(r1.sent).toHaveLength(9);
    expect(r1.deferred).toHaveLength(6);
    expect(
      db.outbox
        .filter((x) => x.state === "pending")
        .every((x) => x.next_attempt_at.getTime() === at(30_000).getTime()),
    ).toBe(true);
    const warns = db.logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warns.filter((m) => m.includes("8/10"))).toHaveLength(1);
    expect(warns.filter((m) => m.includes("9/10"))).toHaveLength(1);

    const r2 = await run(db, at(30_000), h.handlers);
    expect(r2.sent).toHaveLength(1); // lượt thứ 10 = đúng 100 %
    expect(h.calls).toHaveLength(10);
    const nextDay = new Date("2026-10-28T00:00:00.000Z");
    expect(db.breakers.get(KEY)).toMatchObject({
      state: "open",
      trip_reason: "budget_exhausted",
      open_until: nextDay,
    });
    expect(breakerExceptions(db)).toHaveLength(1);
    expect(breakerExceptions(db)[0]!.detail).toMatchObject({
      breaker: KEY,
      reason: "budget_exhausted",
      budget_limit: 10,
      open_until: nextDay.toISOString(),
    });

    // Trong ngày: không gọi thêm.
    const r3 = await run(db, at(3_600_000), h.handlers);
    expect(r3.sent).toEqual([]);
    expect(h.calls).toHaveLength(10);
    expectNoLoss(db, h.calls);

    // Sang cửa sổ mới: lượt thử → đóng → gửi nốt 5 sự kiện còn lại.
    const r4 = await run(db, nextDay, h.handlers);
    expect(r4.sent).toHaveLength(5);
    expect(db.outbox.every((x) => x.state === "sent")).toBe(true);
    expect(new Set(h.calls).size).toBe(15);
  });

  it("ngân sách tách theo breaker: notify hết không chặn loại khác", async () => {
    const db = fakeOutboxDb([...events(3), ...ids(3, "p").map((id) => ({ id, type: "test.y" }))]);
    const calls: string[] = [];
    const ok: OutboxHandler = async (_c, e) => {
      calls.push(e.id);
    };
    const policy = { ...POLICY, budgets: { [KEY]: 1 } };
    const r = await dispatchOutbox(db.container, {
      now: T0,
      handlers: { "test.x": ok, "test.y": ok },
      breakerPolicy: policy,
    });
    expect(calls.sort()).toEqual(["e01", "p01", "p02", "p03"]);
    expect(r.deferred).toEqual(["test.x:e02", "test.x:e03"]);
  });
});

describe("trần mỗi lượt chạy", () => {
  it("chạm trần lượt gọi → dừng lượt, sự kiện còn lại không bị nhận (vẫn đến hạn cho lượt sau)", async () => {
    const db = fakeOutboxDb(events(5));
    const h = recorder("ok");
    const r = await run(db, T0, h.handlers, { runLimits: { maxIterations: 100, maxCalls: 3 } });
    expect(r.sent).toHaveLength(3);
    expect(r.stopped).toBe("max_calls");
    expect(db.outbox.filter((x) => x.state === "pending").map((x) => x.next_attempt_at.getTime())).toEqual([
      0, 0,
    ]);
    const r2 = await run(db, T0, h.handlers, { runLimits: { maxIterations: 100, maxCalls: 3 } });
    expect(r2.sent).toHaveLength(2);
    expect(r2.stopped).toBeNull();
  });

  it("`limit` truyền vào bị kẹp trong trần số vòng", async () => {
    const db = fakeOutboxDb(events(6));
    const h = recorder("ok");
    const r = await run(db, T0, h.handlers, { limit: 1_000, runLimits: { maxIterations: 4, maxCalls: 100 } });
    expect(r.sent).toHaveLength(4);
  });

  it("sự kiện không có bộ xử lý (chỉ log) không qua breaker/ngân sách nhưng vẫn tính vòng", async () => {
    const db = fakeOutboxDb(events(3, "test.unhandled"));
    const r = await dispatchOutbox(db.container, { now: T0, breakerPolicy: POLICY });
    expect(r.sent).toHaveLength(3);
    expect(db.breakers.size).toBe(0);
  });

  it("mặc định production: trần 100 vòng / 50 lượt gọi", () => {
    expect(OUTBOX_RUN_LIMITS).toEqual({ maxIterations: 100, maxCalls: 50 });
  });
});

describe("hàm thuần + kiểm chính sách", () => {
  it("budgetLevel: biên 80/90/100 %", () => {
    expect(budgetLevel(7, 10, POLICY)).toBe("ok");
    expect(budgetLevel(8, 10, POLICY)).toBe("warn");
    expect(budgetLevel(9, 10, POLICY)).toBe("throttle");
    expect(budgetLevel(10, 10, POLICY)).toBe("throttle");
    expect(budgetLevel(11, 10, POLICY)).toBe("exhausted");
    expect(budgetLevel(0, 10, POLICY)).toBe("ok");
    expect(budgetLevel(1, 1, POLICY)).toBe("throttle");
    expect(budgetLevel(2, 1, POLICY)).toBe("exhausted");
  });

  it("breakerKeyOf: mọi thông báo khách chung một breaker", () => {
    expect(breakerKeyOf("order.confirmed")).toBe("outbox.notify");
    expect(breakerKeyOf("shipment.shipped")).toBe("outbox.notify");
    expect(breakerKeyOf("payment.native_sync")).toBe("outbox.payment.native_sync");
  });

  it("chính sách sai → ném (0, âm, số thực, tỉ lệ ngược)", async () => {
    const ok = () => assertBreakerPolicy(POLICY, OUTBOX_RUN_LIMITS);
    expect(ok).not.toThrow();
    expect(() => assertBreakerPolicy({ ...POLICY, failureThreshold: 0 }, OUTBOX_RUN_LIMITS)).toThrow(
      RangeError,
    );
    expect(() => assertBreakerPolicy({ ...POLICY, cooldownMs: 1.5 }, OUTBOX_RUN_LIMITS)).toThrow(RangeError);
    expect(() => assertBreakerPolicy({ ...POLICY, budgets: { x: -1 } }, OUTBOX_RUN_LIMITS)).toThrow(
      RangeError,
    );
    expect(() => assertBreakerPolicy({ ...POLICY, warnRatio: 0.95 }, OUTBOX_RUN_LIMITS)).toThrow(RangeError);
    expect(() => assertBreakerPolicy({ ...POLICY, throttleRatio: 1.2 }, OUTBOX_RUN_LIMITS)).toThrow(
      RangeError,
    );
    expect(() => assertBreakerPolicy(POLICY, { maxIterations: 0, maxCalls: 1 })).toThrow(RangeError);
    await expect(
      dispatchOutbox(fakeOutboxDb([]).container, { runLimits: { maxIterations: 1, maxCalls: Number.NaN } }),
    ).rejects.toThrow(RangeError);
  });
});
