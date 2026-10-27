import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { IMPORT_COLUMNS } from "@x-shop/domain";
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { CHECKOUT_CONFIG } from "../../src/lib/checkout/config";
import { LOCK_UNAVAILABLE_RETRY_AFTER_SECONDS } from "../../src/lib/checkout/errors";
import { activeLeaseCount, LOCK_CALL_TIMEOUT_MS, lockKeys } from "../../src/lib/checkout/locks";
import { CATALOG_INDEX_LOCK } from "../../src/lib/catalog/indexer";
import { MockModeVnpayGateway, setVnpayGatewayForTest } from "../../src/lib/checkout/vnpay-gateway";
import { MockModeGhnClient, setGhnClientForTest } from "../../src/lib/shipping/ghn-client";
import { clearShippingFeeCache } from "../../src/lib/shipping/rates";
import { AUDIT_MODULE } from "../../src/modules/audit";
import type AuditModuleService from "../../src/modules/audit/service";
import { CATALOG_IMPORT_MODULE } from "../../src/modules/catalog-import";
import type CatalogImportModuleService from "../../src/modules/catalog-import/service";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { FASHION_MODULE } from "../../src/modules/fashion";
import type FashionModuleService from "../../src/modules/fashion/service";
import { RETURNS_MODULE } from "../../src/modules/returns";
import type ReturnsModuleService from "../../src/modules/returns/service";
import { SHIPPING_MODULE } from "../../src/modules/shipping";
import type ShippingModuleService from "../../src/modules/shipping/service";
import { createAdmin, createMfaAdmin, type HttpClient, type MfaAdmin } from "../helpers/auth";
import { TEST_CHART } from "../helpers/catalog";
import { DEV_VNPAY, type Api, type Res } from "../helpers/checkout-api";
import {
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";
import { key, newIp, returnsFlow, type J, type PlacedOrder } from "../helpers/returns-flow";

jest.setTimeout(300 * 1000);

/** Mỗi đường phải kết thúc trong hạn một lời gọi khóa + biên xử lý (T-056). */
const BOUND_MS = LOCK_CALL_TIMEOUT_MS + 2_000;

interface RedisLockClient extends Redis {
  acquireLock: (...args: unknown[]) => Promise<number>;
  releaseLock: (...args: unknown[]) => Promise<number>;
}
interface LockingInternals {
  defaultProviderId: string;
  providerService_: { retrieveProviderRegistration(id: string): { redisClient: RedisLockClient } };
}

/**
 * T-056 — mọi đường còn lại dùng Locking Module (hủy đơn, tạo vận đơn, chỉnh tồn, commit import, recheck thanh toán,
 * revise bảng size) có hạn mỗi lời gọi Redis: lệnh khóa "câm" → kết thúc ≤ LOCK_CALL_TIMEOUT_MS + 2 s, 503
 * LOCK_UNAVAILABLE + Retry-After (problem+json như checkout), không ghi dữ liệu dở; Redis về → hành vi cũ. Nhả khóa
 * treo sau khi vùng găng đã xong không đổi kết quả nghiệp vụ (khóa tự hết theo TTL).
 *
 * Giả lập chỉ trên client ioredis của provider locking-redis (giống checkout-lock-outage): lệnh `acquireLock`/
 * `releaseLock` treo tới khi "Redis về" thì bị từ chối như mất kết nối thật.
 */
medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let container: MedusaContainer;
    let fx: CatalogFixture;
    let ghn: MockModeGhnClient;
    let ip: string;
    let owner: MfaAdmin;
    let redis: RedisLockClient;
    let originalAcquire: RedisLockClient["acquireLock"];
    let originalRelease: RedisLockClient["releaseLock"];
    const gateway = new MockModeVnpayGateway(DEV_VNPAY);
    const flow = returnsFlow(api, {
      fx: () => fx,
      gateway: () => gateway,
      ghn: () => ghn,
      staff: () => owner.headers,
      ip: () => ip,
    });
    const checkout = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

    const hungCalls: Array<(error: Error) => void> = [];
    const hang = () => new Promise<number>((_, reject) => void hungCalls.push(reject));
    const silentAcquire = () => {
      redis.acquireLock = hang;
    };
    const silentRelease = () => {
      redis.releaseLock = hang;
    };
    const restoreRedis = () => {
      redis.acquireLock = originalAcquire;
      redis.releaseLock = originalRelease;
      hungCalls.splice(0).forEach((reject) => reject(new Error("Connection is closed.")));
    };

    /** Chạy `fn`, đo thời gian; vượt `BOUND_MS` thì fail ngay (không chờ tới hạn Jest). */
    const timed = async <T>(what: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const value = await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${what}: quá ${BOUND_MS}ms vẫn chưa kết thúc`)),
              BOUND_MS,
            );
          }),
        ]);
        return { value, ms: Date.now() - started };
      } finally {
        clearTimeout(timer);
      }
    };

    const expectLockUnavailable = (res: Res<J>, label: string) => {
      expect({ label, status: res.status, code: res.data.code }).toEqual({
        label,
        status: 503,
        code: "LOCK_UNAVAILABLE",
      });
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.headers["retry-after"]).toBe(String(LOCK_UNAVAILABLE_RETRY_AFTER_SECONDS));
      expect(res.headers["cache-control"]).toMatch(/no-store/);
      expect(res.data).toMatchObject({ status: 503, action: "retry_same_key" });
      expect(JSON.stringify(res.data)).not.toMatch(/Connection is closed|redis|ECONN|timed out/i);
    };

    const adminPost = (path: string, body: unknown = {}, extra: Record<string, string> = {}) =>
      flow.admin(path, owner.headers, body, extra);

    beforeAll(async () => {
      container = getContainer();
      owner = await createMfaAdmin(rawApi as unknown as HttpClient, container, { roles: ["owner"] });
      setVnpayGatewayForTest(gateway);
    });
    afterAll(() => {
      setVnpayGatewayForTest(null);
      setGhnClientForTest(null);
    });
    beforeEach(async () => {
      container = getContainer();
      const locking = container.resolve(Modules.LOCKING) as unknown as LockingInternals;
      redis = locking.providerService_.retrieveProviderRegistration(locking.defaultProviderId).redisClient;
      originalAcquire = redis.acquireLock;
      originalRelease = redis.releaseLock;
      fx = await seedCatalog(container, { stock: { "Đen/S": 20, "Đen/M": 20 } });
      ghn = new MockModeGhnClient();
      setGhnClientForTest(ghn);
      clearShippingFeeCache();
      ip = newIp();
    });
    afterEach(() => {
      restoreRedis();
      // Chỉ khóa checkout/tồn: lượt đồng bộ catalog do sự kiện chỉnh tồn kích có thể đang giữ lease hợp lệ (T-137/T-146).
      expect(activeLeaseCount([CATALOG_INDEX_LOCK])).toBe(0);
    });

    describe("hủy đơn", () => {
      it("nhân viên + khách hủy đồng thời khi Redis câm → cả hai 503 trong hạn; đơn/reservation/lệnh hủy không đổi; Redis về → hủy được", async () => {
        const o = await flow.place([["Đen/S", 2]], "cod");
        const reservedBefore = await reservationsOf(container, fx, "Đen/S");
        expect(reservedBefore).not.toHaveLength(0);
        const k = key();

        silentAcquire();
        const { value: results } = await timed("hủy đơn", () =>
          Promise.all([
            adminPost(
              `/admin/x/orders/${o.orderId}/cancel`,
              { reason: "Khách gọi hotline xin hủy" },
              {
                "Idempotency-Key": k,
              },
            ),
            flow.cancel(o),
          ]),
        );
        expectLockUnavailable(results[0], "nhân viên hủy");
        expectLockUnavailable(results[1], "khách hủy");
        restoreRedis();

        const [fin] = await checkout().listOrderFinances({ order_id: o.orderId });
        expect(fin!.state).toBe("confirmed");
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(reservedBefore.length);
        expect(
          await container.resolve<ReturnsModuleService>(RETURNS_MODULE).findOrderCancelByKey(`staff:${k}`),
        ).toBeNull();
        expect((await container.resolve(Modules.ORDER).retrieveOrder(o.orderId)).status).not.toBe("canceled");

        // Redis khỏe: cùng Idempotency-Key gửi lại → hủy đúng một lần (hành vi cũ).
        const again = await adminPost(
          `/admin/x/orders/${o.orderId}/cancel`,
          { reason: "Khách gọi hotline xin hủy" },
          { "Idempotency-Key": k },
        );
        expect(again).toMatchObject({ status: 200, data: { cancel: { outcome: "cancelled" } } });
        expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(0);
      });
    });

    describe("tạo vận đơn", () => {
      it("Redis câm → 503 trong hạn, không gọi hãng, không ghi vận đơn; Redis về → 201", async () => {
        const o: PlacedOrder = await flow.place([["Đen/M", 1]], "cod");
        silentAcquire();
        const { value: res } = await timed("tạo vận đơn", () =>
          adminPost(`/admin/x/orders/${o.orderId}/shipments`),
        );
        expectLockUnavailable(res, "tạo vận đơn");
        restoreRedis();
        expect(ghn.mock.orders.size).toBe(0);
        expect(
          await container.resolve<ShippingModuleService>(SHIPPING_MODULE).shipmentOfOrder(o.orderId),
        ).toBeNull();

        const ok = await adminPost(`/admin/x/orders/${o.orderId}/shipments`);
        expect(ok.status).toBe(201);
      });
    });

    describe("chỉnh tồn", () => {
      const adjust = (k: string, delta: number) =>
        adminPost(
          "/admin/x/inventory/adjustments",
          {
            inventory_item_id: fx.variants["Đen/S"]!.inventoryItemId,
            location_id: fx.sellableLocationId,
            delta,
            reason: delta > 0 ? "receiving" : "damaged",
          },
          { "Idempotency-Key": k },
        );
      const ledger = () => container.resolve<AuditModuleService>(AUDIT_MODULE);

      it("3 lệnh đồng thời khi Redis câm → cả ba 503 trong hạn; tồn và sổ không đổi; Redis về → cùng khóa ghi đúng một lần", async () => {
        const before = await inventoryLevel(container, fx, "Đen/S");
        const keys = [`adj-${randomUUID()}`, `adj-${randomUUID()}`, `adj-${randomUUID()}`];
        silentAcquire();
        const { value: results } = await timed("chỉnh tồn", () => Promise.all(keys.map((k) => adjust(k, 5))));
        results.forEach((r, i) => expectLockUnavailable(r, `chỉnh tồn #${i}`));
        restoreRedis();
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual(before);
        for (const k of keys) expect(await ledger().findAdjustmentByKey(k)).toBeNull();

        const ok = await adjust(keys[0]!, 5);
        expect(ok.status).toBe(201);
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({
          ...before,
          stocked: before.stocked + 5,
        });
      });

      it("nhả khóa treo sau khi đã ghi → vẫn 201 trong hạn (kết quả không bị đổi thành lỗi); khóa tự hết theo TTL", async () => {
        const before = await inventoryLevel(container, fx, "Đen/S");
        const k = `adj-${randomUUID()}`;
        silentRelease();
        const { value: res } = await timed("chỉnh tồn (nhả treo)", () => adjust(k, 3));
        expect(res.status).toBe(201);
        restoreRedis();
        expect(await inventoryLevel(container, fx, "Đen/S")).toEqual({
          ...before,
          stocked: before.stocked + 3,
        });
        expect(await ledger().findAdjustmentByKey(k)).not.toBeNull();
        // Khóa không được nhả nhưng đã ngừng gia hạn → còn sống ≤ TTL rồi tự hết.
        const lockKey = `medusa_lock:${lockKeys.inventoryItem(fx.variants["Đen/S"]!.inventoryItemId)}`;
        const ttl = await redis.ttl(lockKey);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(CHECKOUT_CONFIG.lockTtlSeconds);
        await redis.del(lockKey);
      });
    });

    describe("commit import CSV", () => {
      it("Redis câm → 503 trong hạn (không chờ 300 giây), job giữ trạng thái preview, không ghi catalog; Redis về → commit chạy (hành vi cũ)", async () => {
        const csv = [
          IMPORT_COLUMNS.join(","),
          "ao-mat-khoa,Áo thử mất khóa,apparel,khong-co-danh-muc,Cotton,Mô tả,AMK-DEN-S,den,s,100000,1",
        ].join("\n");
        const warehouseOnly = await createAdmin(rawApi as unknown as HttpClient, container, {
          roles: ["warehouse"],
        });
        const preview = (await api.post("/admin/x/imports/preview", csv, {
          headers: { ...owner.headers, "content-type": "text/csv" },
          validateStatus: () => true,
        })) as Res<J>;
        expect(preview.status).toBe(201);
        const importId = preview.data.import_id as string;
        const products = async () =>
          (await container.resolve(Modules.PRODUCT).listProducts({}, { take: null })).length;
        const productsBefore = await products();

        silentAcquire();
        // Phân quyền vẫn kiểm TRƯỚC khóa: thiếu catalog.import → 403 ngay cả khi Redis câm (không lộ 503/không chờ).
        const { value: denied } = await timed("commit import (không quyền)", () =>
          flow.admin(`/admin/x/imports/${importId}/commit`, warehouseOnly.headers),
        );
        expect(denied.status).toBe(403);
        const { value: res } = await timed("commit import", () =>
          adminPost(`/admin/x/imports/${importId}/commit`),
        );
        expectLockUnavailable(res, "commit import");
        restoreRedis();
        const [job] = await container
          .resolve<CatalogImportModuleService>(CATALOG_IMPORT_MODULE)
          .listCatalogImportJobs({ id: importId });
        expect(job).toMatchObject({ status: "previewed" });
        expect(await products()).toBe(productsBefore);

        const after = await adminPost(`/admin/x/imports/${importId}/commit`);
        expect({ status: after.status, code: after.data.code }).toEqual({
          status: 422,
          code: "IMPORT_HAS_ERRORS",
        });
      });
    });

    describe("recheck thanh toán", () => {
      it("Redis câm → 503 (không phải 429) trong hạn cho cả hai route; không đổi trạng thái; Redis về → 200 rồi 429 như cũ", async () => {
        const cartId = await flow.client.createCart([["Đen/S", 1]]);
        const q = await flow.client.quote(cartId, { payment_method: "vnpay" });
        const submitted = (await flow.client.submit(q)) as unknown as Res<J>;
        expect(submitted.status).toBe(200);
        const attemptId = submitted.data.checkout_attempt_id as string;
        const ref = submitted.data.order.display_ref as string;
        const orderId = submitted.data.order.id as string;
        const access = submitted.data.order_access as string;
        const store = (extra: Record<string, string> = {}) =>
          flow.client.cfg({ "x-forwarded-for": ip, ...extra });
        const attemptRecheck = () =>
          api.post(
            `/store/x/checkout/attempts/${attemptId}/recheck?cart_id=${encodeURIComponent(cartId)}`,
            {},
            store(),
          ) as Promise<Res<J>>;
        const orderRecheck = () =>
          api.post(`/store/x/orders/${ref}/recheck`, {}, store({ "x-order-access": access })) as Promise<
            Res<J>
          >;

        silentAcquire();
        const { value: results } = await timed("recheck", () =>
          Promise.all([attemptRecheck(), orderRecheck()]),
        );
        expectLockUnavailable(results[0], "recheck attempt");
        expectLockUnavailable(results[1], "recheck đơn");
        restoreRedis();
        const [fin] = await checkout().listOrderFinances({ order_id: orderId });
        expect(fin!.state).toBe("awaiting_payment");
        expect(await checkout().listPaymentAttempts({ order_id: orderId })).toHaveLength(1);

        const ok = await orderRecheck();
        expect(ok.status).toBe(200);
        const limited = await attemptRecheck(); // chung khóa tần suất 10 giây
        expect(limited.status).toBe(429);
      });
    });

    describe("revise bảng size", () => {
      it("Redis câm → 503 trong hạn, không tạo phiên bản mới; Redis về → 201", async () => {
        const code = `mat-khoa-${randomUUID().slice(0, 8)}`;
        const created = await adminPost("/admin/x/size-charts", { code, ...TEST_CHART });
        expect(created.status).toBe(201);
        silentAcquire();
        const { value: res } = await timed("revise bảng size", () =>
          adminPost(`/admin/x/size-charts/${code}/revise`, TEST_CHART),
        );
        expectLockUnavailable(res, "revise bảng size");
        restoreRedis();
        const fashion = container.resolve<FashionModuleService>(FASHION_MODULE);
        const charts = (await fashion.listSizeCharts({ code })) as unknown as Array<{ version: number }>;
        expect(charts.map((c) => c.version)).toEqual([1]);

        const ok = await adminPost(`/admin/x/size-charts/${code}/revise`, TEST_CHART);
        expect(ok.status).toBe(201);
      });
    });
  },
});
