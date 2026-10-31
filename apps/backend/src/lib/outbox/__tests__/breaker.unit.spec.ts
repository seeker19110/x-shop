import { dispatchOutbox, type OutboxHandler } from "../../checkout/jobs";
import { CheckoutError } from "../../checkout/errors";
import {
  assertBreakerPolicy,
  budgetBucket,
  breakerKeyOf,
  budgetLevel,
  budgetOf,
  CUSTOMER_TRIGGERED_NOTIFY_KEY,
  OUTBOX_BREAKER_POLICY,
  OUTBOX_RUN_LIMITS,
  subBudgetOf,
  type OutboxBreakerPolicy,
} from "../breaker";
import { validateOutboxPayload } from "../payload";
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
  // Ngân sách con (T-162) thử riêng ở khối cuối — tại đây tắt để các ca trên đo đúng breaker cha.
  subBudgets: {},
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

  it("lượt thử nhận lỗi VĨNH VIỄN = dịch vụ đã trả lời → closed (D-111); sự kiện đó dead, phần còn lại gửi tiếp", async () => {
    const { db, h } = await tripped();
    let n = 0;
    const handler: OutboxHandler = async (_c, e) => {
      h.calls.push(e.id);
      if (n++ === 0) throw new CheckoutError("VALIDATION");
    };
    const r = await run(db, at(60_000), { "test.x": handler });
    expect(r.dead).toHaveLength(1);
    expect(r.sent).toHaveLength(5);
    expect(r.deferred).toEqual([]);
    expect(h.calls).toHaveLength(6);
    expect(db.breakers.get(KEY)).toMatchObject({
      state: "closed",
      consecutive_failures: 0,
      open_until: null,
    });
    expect(db.logs.some((l) => l.level === "info" && l.message.includes("đóng breaker"))).toBe(true);
    expect(breakerExceptions(db)).toHaveLength(1);
  });

  it("lỗi vĩnh viễn NGOÀI lượt thử vẫn trung lập: không xoá đếm lỗi liên tiếp", async () => {
    const db = fakeOutboxDb(events(4));
    const seq = ["fail", "fail", "permanent", "fail"];
    let i = 0;
    const handler: OutboxHandler = async () => {
      const m = seq[i++];
      if (m === "fail") throw new Error("ESP 503");
      if (m === "permanent") throw new CheckoutError("VALIDATION");
    };
    const r = await run(db, T0, { "test.x": handler });
    expect(r.dead).toEqual(["test.x:e03"]);
    expect(db.breakers.get(KEY)).toMatchObject({ state: "open", consecutive_failures: 3 });
    expect(breakerExceptions(db)).toHaveLength(1);
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

  it("half-open: hai bản KHỞI ĐỘNG CÙNG LÚC, cùng thấy open hết nguội, cùng tranh lượt thử → bản thua không gọi", async () => {
    // Review T-097 🟠1: phủ nhánh `if (!probe)` của BreakerRun.admit (bản thua đọc lại trạng thái rồi hoãn).
    const db = fakeOutboxDb(events(6));
    const h = recorder("fail");
    await run(db, T0, h.handlers);
    expect(db.breakers.get(KEY)!.state).toBe("open");

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
    // Không chờ A gọi trước: cả hai cùng đọc `open` rồi cùng gọi claimJobBreakerProbe.
    const pA = run(db, now, { "test.x": slow });
    const rB = await run(db, now, { "test.x": slow });
    const callsWhileProbeInFlight = calls.length;
    const maxDuringProbe = maxInFlight;
    release();
    await pA;
    expect({ callsWhileProbeInFlight, maxDuringProbe, sentByB: rB.sent.length }).toEqual({
      callsWhileProbeInFlight: 1,
      maxDuringProbe: 1,
      sentByB: 0,
    });
    expect(rB.deferred.length).toBeGreaterThan(0);
    expect(db.breakers.get(KEY)!.state).toBe("closed");
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
      budget_used: 11, // số đếm thật lúc chạm trần (gồm lượt bị từ chối), không phải `limit`
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
    // Không tốn ngân sách (review T-097 🟢1): không có lần đếm nào cho breaker của loại này.
    expect(
      [...db.counters.keys()].filter((k) => k.startsWith(budgetBucket("outbox.test.unhandled"))),
    ).toEqual([]);
    const after = await db.service.hitRateCounter(
      budgetBucket("outbox.test.unhandled"),
      POLICY.budgetWindowMs,
      T0,
    );
    expect(after.current).toBe(1); // 1 = chỉ lần đếm của chính dòng này
  });

  it("mặc định production: trần 100 vòng / 50 lượt gọi", () => {
    expect(OUTBOX_RUN_LIMITS).toEqual({ maxIterations: 100, maxCalls: 50 });
  });
});

describe("lỗi DB khi đếm/đọc breaker → fail-closed", () => {
  it("hitRateCounter lỗi → lượt chạy ném, không gọi; sự kiện vẫn pending/attempts 0 (giữ lease rồi nhận lại)", async () => {
    const db = fakeOutboxDb(events(2));
    const h = recorder("ok");
    (db.service as unknown as Record<string, unknown>).hitRateCounter = async () => {
      throw new Error("DB down");
    };
    await expect(run(db, T0, h.handlers)).rejects.toThrow("DB down");
    expect(h.calls).toEqual([]);
    expect(db.outbox.map((r) => [r.id, r.state, r.attempts, r.next_attempt_at.getTime()])).toEqual([
      ["e01", "pending", 0, at(OUTBOX_POLICY.claimLeaseMs).getTime()],
      ["e02", "pending", 0, 0],
    ]);
  });

  it("lỗi DB SAU khi đã nhận lượt thử → half_open tới hết hạn lượt thử, rồi bản khác thử được và đóng", async () => {
    const db = fakeOutboxDb(events(4));
    const h = recorder("fail");
    await run(db, T0, h.handlers);
    const orig = db.service.hitRateCounter;
    (db.service as unknown as Record<string, unknown>).hitRateCounter = async () => {
      throw new Error("DB down");
    };
    await expect(run(db, at(60_000), h.handlers)).rejects.toThrow("DB down");
    expect(db.breakers.get(KEY)).toMatchObject({ state: "half_open", probe_until: at(70_000) });
    (db.service as unknown as Record<string, unknown>).hitRateCounter = orig;
    h.set("ok");
    const r = await run(db, at(70_000), h.handlers);
    expect(r.sent.length).toBeGreaterThan(0);
    expect(db.breakers.get(KEY)!.state).toBe("closed");
  });
});

describe("loại sự kiện trùng khoá Object.prototype (dữ liệu trong DB không được trúng prototype)", () => {
  const PROTO_TYPES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

  it("không có bộ xử lý riêng → chỉ ghi log + sent; không qua breaker; lượt chạy không sập", async () => {
    const db = fakeOutboxDb(PROTO_TYPES.map((type, i) => ({ id: `x${i}`, type })));
    const r = await dispatchOutbox(db.container, { now: T0, breakerPolicy: POLICY });
    expect(r.sent.sort()).toEqual(PROTO_TYPES.map((t, i) => `${t}:x${i}`).sort());
    expect(r.dead).toEqual([]);
    expect(db.breakers.size).toBe(0);
    expect(db.outbox.every((x) => x.state === "sent")).toBe(true);
  });

  it("bộ xử lý khai RIÊNG cho loại `constructor` thì được dùng (khoá riêng của opts.handlers)", async () => {
    const db = fakeOutboxDb([{ id: "c1", type: "constructor" }]);
    const seen: string[] = [];
    const own: OutboxHandler = async (_c, e) => {
      seen.push(e.id);
    };
    const r = await dispatchOutbox(db.container, {
      now: T0,
      breakerPolicy: POLICY,
      handlers: { constructor: own },
    });
    expect(seen).toEqual(["c1"]);
    expect(r.sent).toEqual(["constructor:c1"]);
    expect(db.breakers.size).toBe(0); // thành công, chưa từng lỗi → không có dòng breaker
  });

  it("validateOutboxPayload: loại trùng khoá prototype chỉ qua kiểm chung, không ném", () => {
    for (const t of PROTO_TYPES) expect(validateOutboxPayload(t, { a: 1 })).toEqual({ ok: true });
    expect(validateOutboxPayload("constructor", { password: "x" }).ok).toBe(false);
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

describe("ngân sách con cho thông báo do khách tự kích (T-162)", () => {
  const NOTIFY = "outbox.notify";
  const SUB = CUSTOMER_TRIGGERED_NOTIFY_KEY;
  /** Cha 10 lượt/ngày; lookup tối đa 3 trong đó → thư giao dịch luôn còn ≥ 7. Không bóp trong lượt (đo trần thuần). */
  const SUB_POLICY: OutboxBreakerPolicy = {
    ...POLICY,
    budgets: { [NOTIFY]: 10 },
    throttledCallsPerRun: 100,
    subBudgets: { "order.lookup_link": { key: SUB, limit: 3 } },
  };
  const NEXT_DAY = new Date("2026-10-28T00:00:00.000Z");
  const DAY_START = Date.parse("2026-10-27T00:00:00.000Z");
  const payload = (n: number) => ({ order_id: `order_${n}` });
  /** `a..` = lookup (nhận trước), `z..` = thư giao dịch. */
  const lookups = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `a${String(i + 1).padStart(2, "0")}`,
      type: "order.lookup_link",
      payload: payload(i + 1),
    }));
  const confirmed = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `z${String(i + 1).padStart(2, "0")}`,
      type: "order.confirmed",
      payload: payload(100 + i),
    }));

  function notifier(mode: () => "ok" | "fail" = () => "ok") {
    const calls: string[] = [];
    const handler: OutboxHandler = async (_c, e) => {
      calls.push(e.id);
      if (mode() === "fail") throw Object.assign(new Error("ESP 503"), { status: 503 });
    };
    return {
      calls,
      handlers: { "order.lookup_link": handler, "order.confirmed": handler } as Record<string, OutboxHandler>,
    };
  }
  const runSub = (
    db: ReturnType<typeof fakeOutboxDb>,
    now: Date,
    handlers: Record<string, OutboxHandler>,
    policy = SUB_POLICY,
  ) => dispatchOutbox(db.container, { now, handlers, random: () => 0, breakerPolicy: policy });
  const counter = (db: ReturnType<typeof fakeOutboxDb>, key: string) =>
    db.counters.get(`${budgetBucket(key)}@${DAY_START}`) ?? 0;

  it("lookup đốt hết ngân sách (nhiều lượt chạy) → order.confirmed vẫn gửi; breaker notify không mở", async () => {
    // Đối chứng: không có ngân sách con thì 12 lookup ăn hết 10 lượt của `outbox.notify` → breaker mở tới 00:00 UTC
    // và order.confirmed bị hoãn (review T-097 🟢2).
    const db = fakeOutboxDb(lookups(12));
    const h = notifier();
    for (let k = 0; k < 4; k++) await runSub(db, at(k * 60_000), h.handlers);
    expect(h.calls).toEqual(["a01", "a02", "a03"]);

    db.add({ id: "z01", type: "order.confirmed", payload: payload(100), next_attempt_at: at(300_000) });
    const r = await runSub(db, at(300_000), h.handlers);
    expect(r.sent).toEqual(["order.confirmed:z01"]);
    expect(h.calls).toEqual(["a01", "a02", "a03", "z01"]);
    expect(db.breakers.get(NOTIFY)?.state ?? "closed").toBe("closed");
    // Lookup vượt trần hoãn tới hết cửa sổ, vẫn trong outbox, attempts không đổi.
    const waiting = db.outbox.filter((x) => x.state !== "sent");
    expect(waiting).toHaveLength(9);
    for (const row of waiting) {
      expect(row).toMatchObject({
        type: "order.lookup_link",
        state: "pending",
        attempts: 0,
        next_attempt_at: NEXT_DAY,
      });
    }
    // Lượt bị từ chối không ăn vào ngân sách cha: 3 lookup + 1 thư giao dịch.
    expect(counter(db, NOTIFY)).toBe(4);
  });

  it("cùng một lượt chạy: lookup vượt trần hoãn tới 00:00 UTC, thư giao dịch gửi; một ngoại lệ + log cho khoá con", async () => {
    const db = fakeOutboxDb([...lookups(8), ...confirmed(2)]);
    const h = notifier();
    const r = await runSub(db, T0, h.handlers);
    expect(r.sent).toEqual([
      "order.lookup_link:a01",
      "order.lookup_link:a02",
      "order.lookup_link:a03",
      "order.confirmed:z01",
      "order.confirmed:z02",
    ]);
    expect(r.deferred).toEqual(["a04", "a05", "a06", "a07", "a08"].map((id) => `order.lookup_link:${id}`));
    expect(db.breakers.has(NOTIFY)).toBe(false);
    expect(db.breakers.has(SUB)).toBe(false); // ngân sách con không có trạng thái breaker
    const ex = breakerExceptions(db);
    expect(ex).toHaveLength(1);
    expect(ex[0]!.detail).toMatchObject({
      breaker: SUB,
      reason: "budget_exhausted",
      budget_limit: 3,
      budget_used: 4,
      open_until: NEXT_DAY.toISOString(),
    });
    const warns = db.logs.filter((l) => l.level === "warn" && l.message.includes(SUB));
    expect(warns.filter((l) => l.message.includes("hết ngân sách con"))).toHaveLength(1);
    expect(warns.filter((l) => l.message.includes("3/3"))).toHaveLength(1); // mốc 80 % của 3 = lượt thứ 3
    // Hạn hoãn đã biết trong lượt → các lookup sau không đếm thêm: 3 gọi + 1 lần chạm trần.
    expect(counter(db, SUB)).toBe(4);
  });

  it("sang cửa sổ mới: lookup đã hoãn gửi tiếp (trong trần mới), không mất sự kiện", async () => {
    const db = fakeOutboxDb(lookups(5));
    const h = notifier();
    await runSub(db, T0, h.handlers);
    expect(h.calls).toHaveLength(3);
    const r = await runSub(db, NEXT_DAY, h.handlers);
    expect(r.sent).toEqual(["order.lookup_link:a04", "order.lookup_link:a05"]);
    expect(db.outbox.every((x) => x.state === "sent")).toBe(true);
    expect(new Set(h.calls).size).toBe(5);
  });

  it("breaker cha mở (adapter hỏng) → lookup cũng hoãn: ngân sách con không vượt rào breaker, không bị đếm", async () => {
    const db = fakeOutboxDb([...confirmed(3), { id: "zz9", type: "order.lookup_link", payload: payload(9) }]);
    const h = notifier(() => "fail");
    const r = await runSub(db, T0, h.handlers);
    expect(h.calls).toEqual(["z01", "z02", "z03"]);
    expect(r.deferred).toEqual(["order.lookup_link:zz9"]);
    expect(db.breakers.get(NOTIFY)!.state).toBe("open");
    expect(counter(db, SUB)).toBe(0);
  });

  it("half-open: lookup đã hết ngân sách con KHÔNG chiếm lượt thử — thư giao dịch nhận lượt thử và đóng breaker", async () => {
    const db = fakeOutboxDb(confirmed(3));
    let mode: "ok" | "fail" = "fail";
    const h = notifier(() => mode);
    await runSub(db, T0, h.handlers);
    expect(db.breakers.get(NOTIFY)!.state).toBe("open");
    // Ngân sách con của ngày đã hết (lượt chạy khác đã đốt); lookup đến hạn TRƯỚC các thư giao dịch.
    db.counters.set(`${budgetBucket(SUB)}@${DAY_START}`, 3);
    db.add({ id: "a01", type: "order.lookup_link", payload: payload(1), next_attempt_at: at(0) });
    mode = "ok";
    h.calls.length = 0;
    const r = await runSub(db, at(60_000), h.handlers);
    expect(r.deferred).toEqual(["order.lookup_link:a01"]);
    expect(h.calls).toEqual(["z01", "z02", "z03"]);
    expect(db.breakers.get(NOTIFY)).toMatchObject({ state: "closed", consecutive_failures: 0 });
  });

  it("hai dispatcher song song: tổng lookup gọi đúng bằng trần con, một ngoại lệ, thư giao dịch gửi hết", async () => {
    const db = fakeOutboxDb([...lookups(10), ...confirmed(4)]);
    const h = notifier();
    const [r1, r2] = await Promise.all([runSub(db, T0, h.handlers), runSub(db, T0, h.handlers)]);
    expect(h.calls.filter((id) => id.startsWith("a"))).toHaveLength(3);
    expect(new Set(h.calls).size).toBe(h.calls.length);
    expect([...r1.sent, ...r2.sent].filter((k) => k.startsWith("order.confirmed")).sort()).toEqual(
      ["z01", "z02", "z03", "z04"].map((id) => `order.confirmed:${id}`),
    );
    expect([...r1.deferred, ...r2.deferred]).toHaveLength(7);
    expect(breakerExceptions(db)).toHaveLength(1);
    expect(db.logs.filter((l) => l.level === "warn" && l.message.includes("hết ngân sách con"))).toHaveLength(
      1,
    );
    expect(db.breakers.has(NOTIFY)).toBe(false);
    expectNoLoss(db, h.calls);
  });

  it("ngân sách cha hết vì thư giao dịch → lookup cũng dừng (trần tổng chi phí giữ nguyên)", async () => {
    const policy = { ...SUB_POLICY, budgets: { [NOTIFY]: 4 } };
    const db = fakeOutboxDb([...confirmed(5), { id: "zz9", type: "order.lookup_link", payload: payload(9) }]);
    const h = notifier();
    const r = await runSub(db, T0, h.handlers, policy);
    expect(h.calls).toEqual(["z01", "z02", "z03", "z04"]);
    expect(r.deferred).toEqual(["order.confirmed:z05", "order.lookup_link:zz9"]);
    expect(db.breakers.get(NOTIFY)).toMatchObject({ state: "open", trip_reason: "budget_exhausted" });
  });

  it("mặc định production: order.lookup_link có ngân sách con nhỏ hơn notify; thư giao dịch không có", () => {
    const sub = subBudgetOf(OUTBOX_BREAKER_POLICY, "order.lookup_link");
    expect(sub).toEqual({ key: SUB, limit: 1_000 });
    expect(sub!.limit).toBeLessThan(budgetOf(OUTBOX_BREAKER_POLICY, breakerKeyOf("order.lookup_link")));
    for (const t of ["order.confirmed", "order.placed_pending", "shipment.shipped", "payment.native_sync"]) {
      expect(subBudgetOf(OUTBOX_BREAKER_POLICY, t)).toBeNull();
    }
    for (const t of ["constructor", "__proto__", "toString"]) {
      expect(subBudgetOf(OUTBOX_BREAKER_POLICY, t)).toBeNull();
    }
  });

  it("chính sách ngân sách con sai → ném", () => {
    const bad = (subBudgets: OutboxBreakerPolicy["subBudgets"]) => () =>
      assertBreakerPolicy({ ...SUB_POLICY, subBudgets }, OUTBOX_RUN_LIMITS);
    expect(bad(SUB_POLICY.subBudgets)).not.toThrow();
    expect(bad({ "order.lookup_link": { key: SUB, limit: 0 } })).toThrow(RangeError);
    expect(bad({ "order.lookup_link": { key: SUB, limit: 2.5 } })).toThrow(RangeError);
    expect(bad({ "order.lookup_link": { key: SUB, limit: 10 } })).toThrow(RangeError); // = ngân sách cha
    expect(bad({ "order.lookup_link": { key: NOTIFY, limit: 3 } })).toThrow(RangeError);
    expect(bad({ "order.lookup_link": { key: "", limit: 3 } })).toThrow(RangeError);
    expect(
      bad({
        "order.lookup_link": { key: SUB, limit: 3 },
        "order.placed_pending": { key: SUB, limit: 4 },
      }),
    ).toThrow(RangeError);
  });
});
