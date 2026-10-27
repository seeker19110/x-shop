import { setTimeout as sleep } from "node:timers/promises";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { WEBHOOK_RATE_LIMITS } from "../../src/lib/http/webhook-rate-limit";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import type { Api, Res } from "../helpers/checkout-api";

jest.setTimeout(180 * 1000);

const { limit, windowMs } = WEBHOOK_RATE_LIMITS.ghnCallbackIp;

interface CounterRow {
  bucket: string;
  count: number;
}

/**
 * T-095 (ARC-RES-005): giới hạn callback GHN đếm ở Postgres (`rate_limit_counter`), chung mọi bản sao backend — không
 * còn `FixedWindowLimiter` trong bộ nhớ tiến trình. "Bản sao khác" được mô phỏng bằng chính đường đếm route dùng
 * (`hitRateCounter` của CheckoutModuleService) gọi từ ngoài HTTP; E2E hai tiến trình thật ở e2e/scale-out.spec.ts.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    const callback = (body: Record<string, unknown>): Promise<Res<Record<string, unknown>>> =>
      api.post("/x/webhooks/shipping/ghn", body, { validateStatus: () => true }) as never;
    const pg = () => getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const checkout = () => getContainer().resolve<CheckoutModuleService>(CHECKOUT_MODULE);

    const ghnCounters = async (): Promise<CounterRow[]> => {
      const r = (await pg().raw(
        `SELECT bucket, count FROM rate_limit_counter WHERE bucket LIKE 'webhook.ghnCallbackIp:%' ORDER BY window_start`,
      )) as { rows: Array<{ bucket: string; count: number | string }> };
      return r.rows.map((row) => ({ bucket: row.bucket, count: Number(row.count) }));
    };

    /**
     * Cửa sổ 10 s theo đồng hồ (`floor(now / windowMs)`), không reset được từ ngoài: chờ sang đầu cửa sổ mới khi cửa sổ
     * hiện tại đã trôi quá 2 s — cả ca (vài giây) nằm trọn trong một cửa sổ, phép đếm chính xác.
     */
    async function alignToWindowStart(): Promise<void> {
      const elapsed = Date.now() % windowMs;
      if (elapsed > 2_000) await sleep(windowMs - elapsed + 50);
    }

    const expectRetryAfter = (r: Res<Record<string, unknown>>) => {
      expect(r.status).toBe(429);
      expect(r.data).toMatchObject({ ok: false, code: "RATE_LIMITED" });
      const after = Number(r.headers["retry-after"]);
      expect(Number.isInteger(after)).toBe(true);
      expect(after).toBeGreaterThanOrEqual(1);
      expect(after).toBeLessThanOrEqual((2 * windowMs) / 1000); // cửa sổ trượt: tối đa 2 cửa sổ (D-037)
    };

    describe("T-095 — giới hạn callback GHN dùng bộ đếm chung (Postgres)", () => {
      beforeEach(async () => {
        await pg().raw(`DELETE FROM rate_limit_counter WHERE bucket LIKE 'webhook.%'`);
      });

      it("được phép: dưới ngưỡng không 429, không Retry-After; mỗi callback +1 vào bộ đếm Postgres, khoá đã băm", async () => {
        await alignToWindowStart();
        for (let i = 0; i < 5; i += 1) {
          const r = await callback({ OrderCode: "x" });
          expect(r.status).toBe(400); // tới được handler (payload lạ → INVALID_CALLBACK)
          expect(r.headers["retry-after"]).toBeUndefined();
        }
        const rows = await ghnCounters();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.count).toBe(5);
        expect(rows[0]!.bucket).toMatch(/^webhook\.ghnCallbackIp:[0-9a-f]{40}$/);
        expect(rows[0]!.bucket).not.toMatch(/127\.0\.0\.1|::1/);
      });

      it("bị từ chối: bản sao khác đã tiêu hết hạn mức → bản này trả 429 + Retry-After ngay (không đếm theo tiến trình)", async () => {
        await alignToWindowStart();
        expect((await callback({ OrderCode: "x" })).status).toBe(400);
        const [row] = await ghnCounters();
        expect(row).toBeDefined();
        // "Bản sao B" nhận phần còn lại của hạn mức, song song — UPSERT nguyên tử: không mất lượt nào.
        await Promise.all(
          Array.from({ length: limit - 1 }, () =>
            checkout().hitRateCounter(row!.bucket, windowMs, new Date()),
          ),
        );
        expect((await ghnCounters())[0]!.count).toBe(limit);

        const blocked = await callback({ OrderCode: "x" });
        expectRetryAfter(blocked);
        expect((await ghnCounters())[0]!.count).toBe(limit + 1); // lần bị chặn vẫn được đếm (tăng rồi so)
      });

      it("đồng thời: 400 callback song song → đúng 300 lượt tới handler, 100 lượt 429 đều kèm Retry-After", async () => {
        await alignToWindowStart();
        const results = await Promise.all(Array.from({ length: 400 }, () => callback({ OrderCode: "x" })));
        const limited = results.filter((r) => r.status === 429);
        expect(results.filter((r) => r.status === 400)).toHaveLength(limit);
        expect(limited).toHaveLength(400 - limit);
        limited.forEach(expectRetryAfter);
        expect((await ghnCounters()).reduce((n, r) => n + r.count, 0)).toBe(400);
      });
    });
  },
});
