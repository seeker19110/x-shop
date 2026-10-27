import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { dispatchOutbox, type OutboxHandler } from "../../src/lib/checkout/jobs";
import { OUTBOX_BREAKER_POLICY, type OutboxBreakerPolicy } from "../../src/lib/outbox/breaker";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";

jest.setTimeout(180 * 1000);

/**
 * T-097 (OPS-COST-004, ARC-RES-005): circuit breaker chi phí outbox trên Postgres THẬT — mọi chuyển trạng thái là một
 * câu có điều kiện nên nhiều bản sao cùng gọi thì đúng một bản thắng (mở/thử), sự kiện hoãn vẫn trong `outbox_event`,
 * ngoại lệ `job_circuit_open` qua CHECK của DB. "Bản sao" = các lời gọi song song cùng DB (trạng thái chỉ nằm ở DB).
 * Mốc giờ ở tương lai xa → dispatcher nền (giờ thật) không nhận sự kiện của test.
 */
medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    const checkout = () => getContainer().resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const pg = () => getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const base = new Date(Date.now() + 30 * 24 * 3600_000);
    const at = (ms: number) => new Date(base.getTime() + ms);
    const POLICY: OutboxBreakerPolicy = {
      ...OUTBOX_BREAKER_POLICY,
      failureThreshold: 3,
      cooldownMs: 60_000,
      probeLeaseMs: 10_000,
    };

    const outboxOf = async (type: string) =>
      (await checkout().listOutboxEvents({ type }, { order: { event_key: "ASC" } })).map((e) => ({
        key: e.event_key,
        state: e.state,
        attempts: e.attempts,
        next: new Date(e.next_attempt_at).getTime(),
      }));
    const breakerExceptions = (breaker: string) =>
      pg()
        .raw(
          `SELECT kind, priority, state, detail FROM ops_exception
           WHERE kind = 'job_circuit_open' AND detail->>'breaker' = ?`,
          [breaker],
        )
        .then((r: { rows: Array<Record<string, unknown>> }) => r.rows);

    describe("câu SQL của kho breaker: đúng một bản thắng", () => {
      it("10 lời gọi mở song song từ closed → đúng 1 true; 10 lời gọi nhận lượt thử sau nguội → đúng 1 true", async () => {
        const s = checkout();
        const key = "it.trip";
        const opened = await Promise.all(
          Array.from({ length: 10 }, () =>
            s.tripJobBreaker(key, "consecutive_failures", at(60_000), ["closed"]),
          ),
        );
        expect(opened.filter(Boolean)).toHaveLength(1);
        expect(await s.readJobBreaker(key)).toMatchObject({ state: "open", open_until: at(60_000) });

        // Chưa hết nguội → không ai nhận lượt thử.
        expect(await s.claimJobBreakerProbe(key, at(59_999), at(70_000))).toBe(false);
        const probes = await Promise.all(
          Array.from({ length: 10 }, () => s.claimJobBreakerProbe(key, at(60_000), at(70_000))),
        );
        expect(probes.filter(Boolean)).toHaveLength(1);
        expect(await s.readJobBreaker(key)).toMatchObject({ state: "half_open", probe_until: at(70_000) });

        // Lượt thử lỗi: chỉ một bản mở lại từ half_open.
        const reopened = await Promise.all(
          Array.from({ length: 5 }, () =>
            s.tripJobBreaker(key, "consecutive_failures", at(130_000), ["half_open"]),
          ),
        );
        expect(reopened.filter(Boolean)).toHaveLength(1);
        const row = (await pg().raw(`SELECT trip_count FROM job_breaker WHERE breaker_key = ?`, [key]))
          .rows[0];
        expect(Number(row.trip_count)).toBe(2);
      });

      it("đếm lỗi theo sự kiện khác nhau; thành công không đóng breaker đang open; đóng từ half_open", async () => {
        const s = checkout();
        const key = "it.count";
        expect((await s.recordJobBreakerFailure(key, "obx_a")).consecutive_failures).toBe(1);
        expect((await s.recordJobBreakerFailure(key, "obx_a")).consecutive_failures).toBe(1);
        expect((await s.recordJobBreakerFailure(key, "obx_b")).consecutive_failures).toBe(2);
        // Song song 8 sự kiện khác nhau → đếm đủ (UPSERT nguyên tử).
        await Promise.all(Array.from({ length: 8 }, (_, i) => s.recordJobBreakerFailure(key, `obx_p${i}`)));
        expect((await s.readJobBreaker(key))!.consecutive_failures).toBe(10);
        expect(await s.recordJobBreakerSuccess(key)).toBe(false);
        expect(await s.readJobBreaker(key)).toMatchObject({ state: "closed", consecutive_failures: 0 });

        expect(await s.tripJobBreaker(key, "budget_exhausted", at(1_000), ["closed"])).toBe(true);
        expect(await s.recordJobBreakerSuccess(key)).toBe(false);
        expect((await s.readJobBreaker(key))!.state).toBe("open");
        expect(await s.claimJobBreakerProbe(key, at(1_000), at(2_000))).toBe(true);
        expect(await s.recordJobBreakerSuccess(key)).toBe(true);
        expect(await s.readJobBreaker(key)).toMatchObject({
          state: "closed",
          open_until: null,
          probe_until: null,
        });
        // Không có dòng = closed; thành công không tạo dòng.
        expect(await s.recordJobBreakerSuccess("it.none")).toBe(false);
        expect(await s.readJobBreaker("it.none")).toBeNull();
      });

      it("CHECK của DB: open phải có open_until, half_open phải có probe_until", async () => {
        await expect(
          pg().raw(`INSERT INTO job_breaker (id, breaker_key, state) VALUES ('jbr_bad1', 'it.bad1', 'open')`),
        ).rejects.toThrow(/job_breaker_open_has_until/);
        await expect(
          pg().raw(
            `INSERT INTO job_breaker (id, breaker_key, state) VALUES ('jbr_bad2', 'it.bad2', 'half_open')`,
          ),
        ).rejects.toThrow(/job_breaker_half_open_has_probe/);
      });
    });

    describe("dispatchOutbox + breaker trên Postgres", () => {
      it("hai dispatcher song song: lỗi liên tiếp → mở đúng 1 lần + 1 ngoại lệ; hoãn không mất; nguội → thử → đóng → gửi hết", async () => {
        const container = getContainer();
        const s = checkout();
        const type = "test.breaker";
        for (let i = 0; i < 10; i++) {
          await s.insertOutbox(
            `${type}:${String(i).padStart(2, "0")}`,
            "agg_brk",
            type,
            { i },
            undefined,
            base,
          );
        }
        const calls: string[] = [];
        let failing = true;
        const handler: OutboxHandler = async (_c, e) => {
          calls.push(e.event_key);
          if (failing) throw Object.assign(new Error("ESP 503"), { status: 503 });
        };
        const opts = { now: base, handlers: { [type]: handler }, breakerPolicy: POLICY, random: () => 0 };
        const [a, b] = await Promise.all([dispatchOutbox(container, opts), dispatchOutbox(container, opts)]);

        expect(new Set(calls).size).toBe(calls.length);
        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect(calls.length).toBeLessThanOrEqual(4);
        expect([...a.retried, ...b.retried, ...a.deferred, ...b.deferred]).toHaveLength(10);
        expect(await s.readJobBreaker("outbox.test.breaker")).toMatchObject({
          state: "open",
          trip_reason: "consecutive_failures",
          open_until: at(60_000),
        });
        const ex = await breakerExceptions("outbox.test.breaker");
        expect(ex).toHaveLength(1);
        expect(ex[0]).toMatchObject({ priority: "high", state: "open" });
        expect(ex[0]!.detail).toMatchObject({
          reason: "consecutive_failures",
          open_until: at(60_000).toISOString(),
        });

        const rows = await outboxOf(type);
        expect(rows).toHaveLength(10);
        for (const r of rows) {
          if (calls.includes(r.key)) expect(r).toMatchObject({ state: "failed", attempts: 1 });
          else expect(r).toMatchObject({ state: "pending", attempts: 0, next: at(60_000).getTime() });
        }

        // Trong thời gian nguội: không gọi.
        calls.length = 0;
        const mid = await dispatchOutbox(container, { ...opts, now: at(30_000) });
        expect(calls).toEqual([]);
        expect(mid.sent).toEqual([]);

        // Hết nguội: một lượt thử thành công → đóng → gửi hết, mỗi sự kiện đúng một lần.
        failing = false;
        const end = await dispatchOutbox(container, { ...opts, now: at(60_000) });
        expect(end.sent).toHaveLength(10);
        expect(new Set(calls).size).toBe(10);
        expect(await s.readJobBreaker("outbox.test.breaker")).toMatchObject({
          state: "closed",
          consecutive_failures: 0,
        });
        expect((await outboxOf(type)).every((r) => r.state === "sent")).toBe(true);
        expect(await breakerExceptions("outbox.test.breaker")).toHaveLength(1);
      });

      it("hết ngân sách cửa sổ → dừng đúng ở `limit` lượt gọi, ngoại lệ budget_exhausted, sự kiện còn lại chờ cửa sổ sau", async () => {
        const container = getContainer();
        const s = checkout();
        const type = "test.budget";
        for (let i = 0; i < 6; i++) {
          await s.insertOutbox(`${type}:${i}`, "agg_bud", type, { i }, undefined, base);
        }
        const calls: string[] = [];
        const handler: OutboxHandler = async (_c, e) => {
          calls.push(e.event_key);
        };
        const policy = { ...POLICY, budgets: { "outbox.test.budget": 4 }, throttledCallsPerRun: 100 };
        const r = await dispatchOutbox(container, {
          now: base,
          handlers: { [type]: handler },
          breakerPolicy: policy,
        });
        expect(calls).toHaveLength(4);
        expect(r.deferred).toHaveLength(2);
        const b = await s.readJobBreaker("outbox.test.budget");
        expect(b).toMatchObject({ state: "open", trip_reason: "budget_exhausted" });
        const dayEnd = Math.floor(base.getTime() / 86_400_000) * 86_400_000 + 86_400_000;
        expect(b!.open_until!.getTime()).toBe(dayEnd);
        const ex = await breakerExceptions("outbox.test.budget");
        expect(ex).toHaveLength(1);
        expect(ex[0]!.detail).toMatchObject({ reason: "budget_exhausted", budget_limit: 4 });
        const pending = (await outboxOf(type)).filter((x) => x.state === "pending");
        expect(pending).toHaveLength(2);
        expect(pending.every((x) => x.attempts === 0 && x.next === dayEnd)).toBe(true);
      });
    });
  },
});
