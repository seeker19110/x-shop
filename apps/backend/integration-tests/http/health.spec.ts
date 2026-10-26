import { randomUUID } from "node:crypto";
import { asValue } from "@medusajs/framework/awilix";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import Redis from "ioredis";
import seedXShop, { SEED } from "../../src/scripts/seed";
import { READINESS_PROBE_TIMEOUT_MS } from "../../src/lib/health/readiness";
import { RBAC_MODULE } from "../../src/modules/rbac";
import type RbacModuleService from "../../src/modules/rbac/service";
import { noThrow, type HttpResponse } from "../helpers/auth";

jest.setTimeout(180 * 1000);

/** Tiền tố khoá mặc định của provider locking-redis (@medusajs/locking-redis). */
const REDIS_LOCK_PREFIX = "medusa_lock:";

/** Không được lộ ra phản hồi readiness: host/cổng, mã lỗi kết nối, SQL, tên phụ thuộc, phiên bản. */
const LEAK =
  /ECONN|ETIMEDOUT|5432|6379|10\.0\.0\.|select|postgres|redis|knex|version|medusa|\bat .*\.(js|ts)/i;

/** Hình tối thiểu đọc từ query.graph (không phụ thuộc kiểu sinh trong .medusa/types). */
type WithSalesChannels = { id: string; sales_channels?: ReadonlyArray<{ id?: string } | null> | null };
type LocationRow = WithSalesChannels & { name: string };
type ApiKeyRow = WithSalesChannels & { title: string; type: string };

const channelIds = (row: WithSalesChannels): string[] =>
  (row.sales_channels ?? []).flatMap((sc) => (sc?.id ? [sc.id] : []));

async function snapshot(container: MedusaContainer) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const regions = await container.resolve(Modules.REGION).listRegions({}, { relations: ["countries"] });
  const locationsRes = await query.graph({
    entity: "stock_location",
    fields: ["id", "name", "sales_channels.id"],
  });
  const locations: LocationRow[] = locationsRes.data;
  const channels = await container
    .resolve(Modules.SALES_CHANNEL)
    .listSalesChannels({ name: SEED.salesChannelName });
  const keysRes = await query.graph({
    entity: "api_key",
    fields: ["id", "title", "type", "sales_channels.id"],
    filters: { title: SEED.publishableKeyTitle },
  });
  const keys: ApiKeyRow[] = keysRes.data;
  const stores = await container
    .resolve(Modules.STORE)
    .listStores({}, { relations: ["supported_currencies"] });
  return { regions, locations, channels, keys, stores };
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    describe("GET /x/health", () => {
      it("trả 200 {status:'ok'}, không cache", async () => {
        const res = await api.get("/x/health");
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ status: "ok" });
        expect(res.headers["cache-control"]).toBe("no-store");
      });

      it("health native của Medusa vẫn trả 200", async () => {
        const res = await api.get("/health");
        expect(res.status).toBe(200);
      });
    });

    describe("GET /x/readyz (OPS-OBS-006, T-079)", () => {
      /** Thay tạm kết nối Postgres trong container (route resolve theo request) rồi trả lại. */
      async function withPg<T>(fake: unknown, fn: () => Promise<T>): Promise<T> {
        const container = getContainer();
        const real = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        container.register(ContainerRegistrationKeys.PG_CONNECTION, asValue(fake));
        try {
          return await fn();
        } finally {
          container.register(ContainerRegistrationKeys.PG_CONNECTION, asValue(real));
        }
      }

      it("DB + Redis khỏe → 200 {status:'ready'}, không cache, không lộ chi tiết", async () => {
        const res = await api.get("/x/readyz", noThrow);
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ status: "ready" });
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.headers["x-powered-by"]).toBeUndefined();
      });

      it("DB lỗi kết nối → 503 problem+json chung, không lộ thông điệp gốc", async () => {
        const fake = { raw: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:5432 select 1")) };
        const res: HttpResponse = await withPg(fake, () => api.get("/x/readyz", noThrow));
        expect(res.status).toBe(503);
        expect(String(res.headers["content-type"])).toMatch(/^application\/problem\+json/);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.data).toMatchObject({ status: 503, code: "NOT_READY" });
        expect(JSON.stringify(res.data)).not.toMatch(LEAK);
      });

      it("DB treo → 503 trong khoảng một hạn probe (không treo theo pool)", async () => {
        const fake = { raw: () => new Promise(() => undefined) };
        const t0 = Date.now();
        const res: HttpResponse = await withPg(fake, () => api.get("/x/readyz", noThrow));
        const elapsed = Date.now() - t0;
        expect(res.status).toBe(503);
        expect(elapsed).toBeGreaterThanOrEqual(READINESS_PROBE_TIMEOUT_MS - 50);
        expect(elapsed).toBeLessThan(READINESS_PROBE_TIMEOUT_MS + 2_000);
      });

      it("Redis hỏng → 503; Redis hồi phục → 200 ngay lượt sau", async () => {
        const rbac = getContainer().resolve<RbacModuleService>(RBAC_MODULE);
        const real = rbac.securityStore();
        const spy = jest.spyOn(rbac, "securityStore").mockReturnValue({
          ...real,
          ping: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379")),
        });
        try {
          const res = await api.get("/x/readyz", noThrow);
          expect(res.status).toBe(503);
          expect(JSON.stringify(res.data)).not.toMatch(LEAK);
        } finally {
          spy.mockRestore();
        }
        expect((await api.get("/x/readyz", noThrow)).status).toBe(200);
      });

      it("20 request đồng thời → mọi request 200, probe DB được gộp (ít hơn số request)", async () => {
        const container = getContainer();
        const real = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        let calls = 0;
        const slow = {
          raw: (sql: string) => {
            calls += 1;
            return new Promise((r) => setTimeout(r, 300)).then(() => real.raw(sql));
          },
        };
        const results: HttpResponse[] = await withPg(slow, () =>
          Promise.all(Array.from({ length: 20 }, () => api.get("/x/readyz", noThrow))),
        );
        expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
        expect(calls).toBeGreaterThanOrEqual(1);
        expect(calls).toBeLessThan(20);
      });
    });

    describe("seed", () => {
      const assertSeeded = async (container: MedusaContainer) => {
        const { regions, locations, channels, keys, stores } = await snapshot(container);

        const vnRegions = regions.filter((r) => r.countries?.some((c) => c.iso_2 === "vn"));
        expect(vnRegions).toHaveLength(1);
        expect(vnRegions[0]).toMatchObject({ name: "Việt Nam", currency_code: "vnd" });
        expect(regions.filter((r) => r.name === "Việt Nam")).toHaveLength(1);

        expect(channels).toHaveLength(1);
        const channelId = channels[0]!.id;

        const main = locations.filter((l) => l.name === "Kho chính");
        const quarantine = locations.filter((l) => l.name === "Kho cách ly");
        expect(main).toHaveLength(1);
        expect(quarantine).toHaveLength(1);
        expect(channelIds(main[0]!)).toEqual([channelId]);
        expect(channelIds(quarantine[0]!)).toEqual([]);

        const publishable = keys.filter((k) => k.type === "publishable");
        expect(publishable).toHaveLength(1);
        expect(channelIds(publishable[0]!)).toEqual([channelId]);

        expect(stores).toHaveLength(1);
        const store = stores[0]!;
        expect(store.supported_currencies?.map((c) => [c.currency_code, c.is_default])).toEqual([
          ["vnd", true],
        ]);
        expect(store.default_region_id).toBe(vnRegions[0]!.id);
        expect(store.default_sales_channel_id).toBe(channelId);
        expect(store.default_location_id).toBe(main[0]!.id);

        // VND không có phần lẻ (ISO 4217 exponent 0) — tiền là số nguyên đồng.
        // CurrencyDTO không khai decimal_digits dù model có cột này.
        const vnd: { code: string; decimal_digits?: number } = await container
          .resolve(Modules.CURRENCY)
          .retrieveCurrency("vnd");
        expect(vnd.decimal_digits).toBe(0);
      };

      it("chạy 2 lần liên tiếp → không trùng, cùng kết quả", async () => {
        const container = getContainer();
        const first = await seedXShop({ container });
        const second = await seedXShop({ container });
        expect(second).toEqual(first);
        await assertSeeded(container);
      });

      it("chạy 2 lần song song → khoá seed tuần tự hoá, không trùng", async () => {
        const container = getContainer();
        const [a, b] = await Promise.all([seedXShop({ container }), seedXShop({ container })]);
        expect(b).toEqual(a);
        await assertSeeded(container);
      });
    });

    describe("Locking Module (provider Redis)", () => {
      let redis: Redis;
      beforeAll(() => {
        redis = new Redis(process.env.REDIS_URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
      });
      afterAll(async () => {
        await redis.quit();
      });

      it("resolve được; khoá nằm trong Redis; chủ khác bị từ chối; chủ cũ nhả được", async () => {
        const locking = getContainer().resolve(Modules.LOCKING);
        const key = `x-shop:it:${randomUUID()}`;

        await locking.acquire(key, { ownerId: "owner-a", expire: 30 });
        try {
          expect(await redis.get(`${REDIS_LOCK_PREFIX}${key}`)).toBe("owner-a");
          await expect(locking.acquire(key, { ownerId: "owner-b", expire: 30 })).rejects.toThrow(
            /Failed to acquire lock/,
          );
          // Chủ khác không nhả được khoá không phải của mình.
          expect(await locking.release(key, { ownerId: "owner-b" })).toBe(false);
          expect(await redis.get(`${REDIS_LOCK_PREFIX}${key}`)).toBe("owner-a");
        } finally {
          expect(await locking.release(key, { ownerId: "owner-a" })).toBe(true);
        }
        expect(await redis.get(`${REDIS_LOCK_PREFIX}${key}`)).toBeNull();
      });

      it("execute tuần tự hoá hai job cùng khoá", async () => {
        const locking = getContainer().resolve(Modules.LOCKING);
        const key = `x-shop:it:${randomUUID()}`;
        const events: string[] = [];
        const job = (name: string) => async () => {
          events.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 150));
          events.push(`${name}:end`);
        };
        await Promise.all([locking.execute(key, job("a")), locking.execute(key, job("b"))]);
        // Không xen kẽ: mỗi job kết thúc trước khi job kia bắt đầu.
        expect([events[0]!.split(":")[0], events[1]!.split(":")[0]]).toEqual([
          events[0]!.split(":")[0],
          events[0]!.split(":")[0],
        ]);
        expect(events[1]).toMatch(/:end$/);
        expect(events[3]).toMatch(/:end$/);
      });
    });
  },
});
