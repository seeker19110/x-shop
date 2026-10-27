import { setTimeout as sleep } from "node:timers/promises";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { vnpay } from "@x-shop/domain";
import { localHitGuard, WEBHOOK_RATE_LIMITS, webhookRateBucket } from "../../src/lib/http/webhook-rate-limit";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { ipn, type Api, type Res } from "../helpers/checkout-api";

jest.setTimeout(180 * 1000);

const { limit, windowMs } = WEBHOOK_RATE_LIMITS.ghnCallbackIp;
const { limit: ipnLimit, windowMs: ipnWindowMs } = WEBHOOK_RATE_LIMITS.vnpayIpnIp;

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
        localHitGuard.clear(); // trạng thái chặn sớm của tiến trình test
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

      it("đồng thời: 400 callback song song → đúng 300 lượt tới handler, 100 lượt 429 kèm Retry-After; chặn sớm giới hạn 300 lần ghi DB", async () => {
        await alignToWindowStart();
        const results = await Promise.all(Array.from({ length: 400 }, () => callback({ OrderCode: "x" })));
        const limited = results.filter((r) => r.status === 429);
        expect(results.filter((r) => r.status === 400)).toHaveLength(limit);
        expect(limited).toHaveLength(400 - limit);
        limited.forEach(expectRetryAfter);
        // Lượt thứ 301+ bị chặn sớm trong bộ nhớ: không UPSERT. Trên mã cũ (mọi lượt đều ghi) tổng là 400.
        expect((await ghnCounters()).reduce((n, r) => n + r.count, 0)).toBe(limit);
      });
    });

    const vnpayCounters = async (): Promise<CounterRow[]> => {
      const r = (await pg().raw(
        `SELECT bucket, count FROM rate_limit_counter WHERE bucket LIKE 'webhook.vnpayIpnIp:%' ORDER BY window_start`,
      )) as { rows: Array<{ bucket: string; count: number | string }> };
      return r.rows.map((row) => ({ bucket: row.bucket, count: Number(row.count) }));
    };
    const ipnCall = (): Promise<Res> =>
      ipn(rawApi as unknown as Api, new URLSearchParams({ vnp_Amount: "1" }));
    const expectIpnLimited = (r: Res) => {
      // Giữ đúng hành vi cũ: HTTP 429 + RspCode 99 (VNPAY gửi lại) + Retry-After.
      expect(r.status).toBe(429);
      expect(r.data).toEqual(vnpay.IPN_RESPONSES.unknownError);
      const after = Number(r.headers["retry-after"]);
      expect(Number.isInteger(after)).toBe(true);
      expect(after).toBeGreaterThanOrEqual(1);
      expect(after).toBeLessThanOrEqual((2 * ipnWindowMs) / 1000);
    };

    describe("T-152 — IPN VNPAY dùng bộ đếm chung (Postgres)", () => {
      beforeEach(async () => {
        await pg().raw(`DELETE FROM rate_limit_counter WHERE bucket LIKE 'webhook.%'`);
        localHitGuard.clear();
      });

      it("dưới ngưỡng: IPN tới handler (97 chữ ký sai), +1 vào bộ đếm Postgres, khoá băm theo chính sách vnpayIpnIp", async () => {
        await alignToWindowStart();
        for (let i = 0; i < 3; i += 1) {
          const r = await ipnCall();
          expect(r.status).toBe(200);
          expect(r.data).toEqual(vnpay.IPN_RESPONSES.invalidSignature);
          expect(r.headers["retry-after"]).toBeUndefined();
        }
        const rows = await vnpayCounters();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.count).toBe(3);
        expect(rows[0]!.bucket).toMatch(/^webhook\.vnpayIpnIp:[0-9a-f]{40}$/);
        expect(await ghnCounters()).toHaveLength(0); // không lẫn khoá GHN
      });

      it("hai bản sao dùng chung hạn mức: bản sao khác đã tiêu hết → IPN ở bản này 429 + 99 + Retry-After", async () => {
        await alignToWindowStart();
        expect((await ipnCall()).status).toBe(200);
        const [row] = await vnpayCounters();
        await Promise.all(
          Array.from({ length: ipnLimit - 1 }, () =>
            checkout().hitRateCounter(row!.bucket, ipnWindowMs, new Date()),
          ),
        );
        expectIpnLimited(await ipnCall());
        expect((await vnpayCounters())[0]!.count).toBe(ipnLimit + 1);
      });

      it("đồng thời: 400 IPN song song → đúng 300 tới handler, 100 lượt 429; số lần ghi DB ≤ hạn mức", async () => {
        await alignToWindowStart();
        const results = await Promise.all(Array.from({ length: 400 }, () => ipnCall()));
        expect(results.filter((r) => r.status === 200)).toHaveLength(ipnLimit);
        const limited = results.filter((r) => r.status === 429);
        expect(limited).toHaveLength(400 - ipnLimit);
        limited.forEach(expectIpnLimited);
        expect((await vnpayCounters()).reduce((n, r) => n + r.count, 0)).toBe(ipnLimit); // mã cũ: không ghi DB
      });
    });

    describe("T-152 — dọn bộ đếm webhook theo 2×cửa sổ", () => {
      const count = async (bucket: string): Promise<number> => {
        const r = (await pg().raw(`SELECT count(*)::int AS n FROM rate_limit_counter WHERE bucket = ?`, [
          bucket,
        ])) as { rows: Array<{ n: number }> };
        return r.rows[0]!.n;
      };
      const windows = Object.fromEntries(
        Object.entries(WEBHOOK_RATE_LIMITS).map(([k, w]) => [k, w.windowMs]),
      );

      it("xoá hàng webhook cũ hơn 2×windowMs của chính sách; giữ hàng mới, chính sách lạ và bucket khác (2 ngày)", async () => {
        await pg().raw(`DELETE FROM rate_limit_counter`);
        const now = new Date();
        const ago = (ms: number) => new Date(now.getTime() - ms);
        const ghnB = webhookRateBucket("ghnCallbackIp", "203.0.113.1");
        const ipnB = webhookRateBucket("vnpayIpnIp", "203.0.113.1");
        const otherWebhook = "webhook.chinhSachLa:abc";
        const storeB = "store.order-lookup:abc";
        // Hàng cũ (> 2 cửa sổ = 20 s) và hàng mới (cửa sổ hiện tại).
        await checkout().hitRateCounter(ghnB, windowMs, ago(60_000));
        await checkout().hitRateCounter(ghnB, windowMs, now);
        await checkout().hitRateCounter(ipnB, ipnWindowMs, ago(60_000));
        await checkout().hitRateCounter(ipnB, ipnWindowMs, now);
        // Không thuộc chính sách đã biết / không phải webhook: 1 giờ trước — còn trong hạn 2 ngày, phải giữ.
        await checkout().hitRateCounter(otherWebhook, 10_000, ago(3_600_000));
        await checkout().hitRateCounter(storeB, 10_000, ago(60_000));
        await checkout().hitRateCounter(storeB, 10_000, ago(3 * 24 * 3_600_000)); // > 2 ngày: xoá
        expect([await count(ghnB), await count(ipnB)]).toEqual([2, 2]);

        const r = await checkout().purgeOrderAccessRecords(now, windows);
        expect(r.counters).toBe(3); // ghn cũ + ipn cũ + store > 2 ngày
        expect([await count(ghnB), await count(ipnB)]).toEqual([1, 1]);
        expect(await count(otherWebhook)).toBe(1);
        expect(await count(storeB)).toBe(1);
        // Không truyền chính sách (hành vi cũ): chỉ dọn theo 2 ngày.
        const again = await checkout().purgeOrderAccessRecords(now);
        expect(again.counters).toBe(0);
      });

      it("tên chính sách/cửa sổ không hợp lệ bị từ chối (không ghép bậy vào LIKE)", async () => {
        await expect(checkout().purgeOrderAccessRecords(new Date(), { "x%": 10_000 })).rejects.toThrow(
          RangeError,
        );
        await expect(checkout().purgeOrderAccessRecords(new Date(), { ok: 0 })).rejects.toThrow(RangeError);
      });
    });
  },
});
