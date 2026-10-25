import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import type Redis from "ioredis";
import { drainCatalogIndex } from "../../src/lib/catalog/indexer";
import { CHECKOUT_CONFIG } from "../../src/lib/checkout/config";
import { LOCK_UNAVAILABLE_RETRY_AFTER_SECONDS } from "../../src/lib/checkout/errors";
import { reconcileAttempts } from "../../src/lib/checkout/jobs";
import { activeLeaseCount, LOCK_CALL_TIMEOUT_MS, lockKeys } from "../../src/lib/checkout/locks";
import { CHECKOUT_MODULE } from "../../src/modules/checkout";
import type CheckoutModuleService from "../../src/modules/checkout/service";
import { submitCheckoutWorkflow } from "../../src/workflows/checkout/submit-checkout";
import { checkoutClient, newKey, type Api, type Res } from "../helpers/checkout-api";
import {
  countOrders,
  inventoryLevel,
  reservationsOf,
  seedCatalog,
  type CatalogFixture,
} from "../helpers/checkout-fixtures";

jest.setTimeout(300 * 1000);

/** Hạn chờ client Redis khóa về `ready` sau khi giả lập sự cố (restoreRedis/afterEach). */
const REDIS_READY_TIMEOUT_MS = 5_000;

/**
 * T-042 — mất hạ tầng khóa (Locking Module, provider Redis) khi submit checkout (đặc tả §13.2): 503 `LOCK_UNAVAILABLE`
 * có hướng dẫn + Retry-After, không tạo đơn/giữ hàng, catalog vẫn đọc được; khác `BUSY_RETRY` 409 (khóa đang bận).
 *
 * Giả lập tất định, không chờ thời gian thật dài, chỉ trên client ioredis của provider locking-redis (event bus/cache/
 * workflow engine vẫn chạy):
 *  - mất kết nối thật: `redisClient.disconnect()` → mọi lệnh bị ioredis từ chối "Connection is closed."; `connect()` = Redis về;
 *  - Redis không trả lời: lệnh khóa treo vô hạn (như hàng đợi offline của ioredis) → cắt sau LOCK_CALL_TIMEOUT_MS;
 *  - mất giữa workflow: chỉ lệnh khóa NATIVE (`createReservationsStep` khóa id thô của inventory item) bị từ chối.
 */

interface ProviderInternals {
  redisClient: Redis & { acquireLock: (...args: unknown[]) => Promise<number> };
}
interface LockingInternals {
  defaultProviderId: string;
  providerService_: { retrieveProviderRegistration(id: string): ProviderInternals };
}

/** Giỏ mà hook trước khi chốt sẽ cắt Redis khóa rồi làm lỗi → bù trừ cần khóa (xoá reservation) không chạy được. */
const outageBeforeFinalize = new Map<string, () => void>();
submitCheckoutWorkflow.hooks.orderPrepared(async ({ cart_id }) => {
  const cut = outageBeforeFinalize.get(cart_id);
  if (cut) {
    cut();
    throw new Error("lỗi giả lập trước khi chốt đơn (Redis khóa vừa mất)");
  }
});

medusaIntegrationTestRunner({
  testSuite: ({ api: rawApi, getContainer }) => {
    const api = rawApi as unknown as Api;
    let fx: CatalogFixture;
    let container: MedusaContainer;
    let redis: ProviderInternals["redisClient"];
    let originalAcquireLock: ProviderInternals["redisClient"]["acquireLock"];
    const client = checkoutClient(api, () => fx);
    const service = () => container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);

    const providerClient = (c: MedusaContainer) => {
      const locking = c.resolve(Modules.LOCKING) as unknown as LockingInternals;
      return locking.providerService_.retrieveProviderRegistration(locking.defaultProviderId).redisClient;
    };
    /** Đợi `promise` kết thúc (xong hay lỗi) trong `ms`; quá hạn → lỗi rõ ràng thay vì treo tới hạn hook của Jest. */
    const settlesWithin = async (promise: Promise<unknown>, ms: number, what: string) => {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: quá ${ms}ms vẫn chưa kết thúc`)), ms);
      });
      try {
        return await Promise.race([
          promise.then(
            () => "settled",
            () => "settled",
          ),
          deadline,
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    /** Redis khóa mất hẳn (đóng kết nối, không tự nối lại). */
    const cutRedis = () => redis.disconnect();
    /**
     * Lệnh khóa "câm": không trả lời cho tới khi Redis "về" (restoreRedis) — lúc đó mọi lời gọi còn treo bị từ chối như
     * khi ioredis mất kết nối thật. KHÔNG treo vĩnh viễn: lời gọi của tác vụ nền (job mỗi phút/lượt xả catalog) vào đúng
     * khoảng này sẽ kẹt mãi, và `jobWorker.close()` của workflow engine ở teardown chờ job đó tới hạn hook 300 giây (T-047).
     */
    const hungCalls: Array<(error: Error) => void> = [];
    const silentRedis = () => {
      redis.acquireLock = () => new Promise<number>((_, reject) => void hungCalls.push(reject));
    };
    /** Đợi client ở `ready` (≤ timeoutMs) rồi PING; kẹt ở trạng thái khác → lỗi nêu rõ trạng thái, không để teardown treo. */
    const waitRedisReady = async (timeoutMs = REDIS_READY_TIMEOUT_MS) => {
      const deadline = Date.now() + timeoutMs;
      if (["end", "close", "wait"].includes(redis.status)) {
        await settlesWithin(
          redis.connect().catch(() => undefined),
          timeoutMs,
          `redis.connect() (status=${redis.status})`,
        );
      }
      while (redis.status !== "ready") {
        if (Date.now() >= deadline) {
          throw new Error(
            `Redis khóa không về trạng thái ready trong ${timeoutMs}ms (status=${redis.status})`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      const pong = await Promise.race([
        redis.ping(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Redis khóa không trả PONG trong ${timeoutMs}ms`)),
            timeoutMs,
          ).unref();
        }),
      ]);
      if (pong !== "PONG") throw new Error(`Redis khóa trả "${String(pong)}" thay vì PONG`);
    };
    const restoreRedis = async () => {
      if (!redis) return;
      redis.acquireLock = originalAcquireLock;
      hungCalls.splice(0).forEach((reject) => reject(new Error("Connection is closed.")));
      await waitRedisReady();
    };
    /** Khóa checkout còn sót trong Redis (tiền tố mặc định của provider). */
    const leakedLocks = async (keys: string[]) => {
      const values = await Promise.all(keys.map((k) => redis.get(`medusa_lock:${k}`)));
      return keys.filter((_, i) => values[i] !== null);
    };
    const attemptsOfKey = (key: string) => service().listCheckoutAttempts({ idempotency_key: key });

    const expectLockUnavailable = (res: Res, label: string) => {
      expect({ label, status: res.status, code: res.data.code }).toEqual({
        label,
        status: 503,
        code: "LOCK_UNAVAILABLE",
      });
      expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      expect(res.headers["retry-after"]).toBe(String(LOCK_UNAVAILABLE_RETRY_AFTER_SECONDS));
      expect(res.headers["cache-control"]).toMatch(/no-store/);
      expect(res.data).toMatchObject({
        status: 503,
        action: "retry_same_key",
        detail: "Hệ thống tạm thời không nhận đơn, vui lòng thử lại sau ít phút",
      });
      // Không lộ chi tiết hạ tầng (host/cổng/thông điệp ioredis) cho khách.
      expect(JSON.stringify(res.data)).not.toMatch(/Connection is closed|redis|ECONN|timed out/i);
    };

    beforeEach(async () => {
      container = getContainer();
      redis = providerClient(container);
      expect(redis).toBeDefined(); // chạy với REDIS_URL → provider locking-redis (jest.config đặt sẵn)
      originalAcquireLock = redis.acquireLock;
      fx = await seedCatalog(container);
    });

    afterEach(async () => {
      outageBeforeFinalize.clear();
      await restoreRedis();
      // Không chủ nào còn được gia hạn khóa trong tiến trình (không rò khóa sau sự cố).
      expect(activeLeaseCount()).toBe(0);
    });

    it("mất kết nối Redis khóa → 503 LOCK_UNAVAILABLE + Retry-After, không đơn/không giữ hàng, catalog vẫn 200; cùng key sau khi Redis về → đúng một đơn", async () => {
      const cartId = await client.createCart([["Đen/M", 2]]);
      const q = await client.quote(cartId);
      const ordersBefore = await countOrders(container);
      const key = newKey();

      cutRedis();
      // Ca đồng thời: 3 request cùng key trong lúc Redis mất — tất cả 503, một attempt duy nhất, không treo.
      const started = Date.now();
      const during = await Promise.all([client.submit(q, key), client.submit(q, key), client.submit(q, key)]);
      expect(Date.now() - started).toBeLessThan(CHECKOUT_CONFIG.lockWaitMs);
      during.forEach((r, i) => expectLockUnavailable(r, `submit đồng thời #${i}`));
      const attempts = await attemptsOfKey(key);
      expect(attempts).toHaveLength(1);
      const attemptId = attempts[0]!.id;
      expect(during.map((r) => r.headers["x-checkout-attempt-id"])).toEqual([
        attemptId,
        attemptId,
        attemptId,
      ]);
      // Attempt ở trạng thái kết thúc rõ ràng (failed + mã), không `preparing` dở.
      expect(attempts[0]).toMatchObject({ state: "failed", error_code: "LOCK_UNAVAILABLE", order_id: null });

      // Không tạo đơn, không giữ hàng — không bán bằng tồn đọc ngoài khóa.
      expect(await countOrders(container)).toBe(ordersBefore);
      expect(await reservationsOf(container, fx, "Đen/M")).toHaveLength(0);
      expect(await inventoryLevel(container, fx, "Đen/M")).toEqual({ stocked: 10, reserved: 0 });

      // Catalog vẫn đọc được trong lúc khóa mất (đặc tả §13.2).
      const read = client.cfg();
      const list = await api.get("/store/x/products", read);
      const detail = await api.get(`/store/products/${fx.productId}`, read);
      expect({ list: list.status, detail: detail.status }).toEqual({ list: 200, detail: 200 });
      // Trạng thái attempt cho storefront: failed + mã ổn định.
      const status = await api.get(
        `/store/x/checkout/attempts/${attemptId}?cart_id=${encodeURIComponent(cartId)}`,
        read,
      );
      expect(status.data).toMatchObject({ state: "failed", error: { code: "LOCK_UNAVAILABLE" } });

      await restoreRedis();

      // Redis về: 3 lần gửi lại CÙNG key đồng thời → đúng một đơn, cùng attempt (mở lại attempt lỗi tạm).
      const after = await Promise.all([client.submit(q, key), client.submit(q, key), client.submit(q, key)]);
      for (const r of after) expect([200, 202]).toContain(r.status);
      const ok = after.find((r) => r.status === 200);
      expect(ok?.data).toMatchObject({
        checkout_attempt_id: attemptId,
        state: "ready",
        order: { state: "placed", total: 1_430_000 },
      });
      expect(await countOrders(container)).toBe(ordersBefore + 1);
      expect((await reservationsOf(container, fx, "Đen/M")).map((r) => Number(r.quantity))).toEqual([2]);
      expect(await attemptsOfKey(key)).toHaveLength(1);
      expect(
        await leakedLocks([
          lockKeys.cart(cartId),
          lockKeys.inventoryItem(fx.variants["Đen/M"]!.inventoryItemId),
        ]),
      ).toEqual([]);
    });

    it("Redis khóa không trả lời (lệnh treo) → 503 sau hạn một lời gọi, không treo theo client; khóa không bị giữ", async () => {
      const cartId = await client.createCart([["Trắng/S", 1]]);
      const q = await client.quote(cartId);
      const ordersBefore = await countOrders(container);

      silentRedis();
      const started = Date.now();
      const res = await client.submit(q);
      const elapsed = Date.now() - started;
      expectLockUnavailable(res, "lệnh khóa treo");
      expect(elapsed).toBeGreaterThanOrEqual(LOCK_CALL_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(LOCK_CALL_TIMEOUT_MS + 5_000);
      expect(await countOrders(container)).toBe(ordersBefore);
      expect(await reservationsOf(container, fx, "Trắng/S")).toHaveLength(0);

      // Một tác vụ nền (job mỗi phút `x-catalog-index-drain`, lượt xả hẹn giờ) gọi khóa đúng lúc Redis câm: lời gọi ấy
      // không được kẹt vĩnh viễn — hạn đóng của runner (`jobWorker.close()` chờ job đang chạy) là nguyên nhân treo
      // teardown 300 giây (T-047). Redis "về" (restoreRedis) thì mọi lời gọi còn treo phải kết thúc.
      const background = drainCatalogIndex(container);
      await restoreRedis();
      await expect(settlesWithin(background, 5_000, "lời gọi khóa của tác vụ nền")).resolves.toBeDefined();
      expect(await leakedLocks([lockKeys.cart(cartId)])).toEqual([]);
    });

    it("Redis mất giữa workflow (khóa native khi giữ hàng) → bù trừ hết (không đơn, không reservation, khóa nhả), 503; Redis về → cùng key đặt được", async () => {
      const cartId = await client.createCart([["Đen/S", 1]]);
      const q = await client.quote(cartId);
      const ordersBefore = await countOrders(container);
      const itemId = fx.variants["Đen/S"]!.inventoryItemId;

      // Khóa checkout (cart:/inventory_item:/promotion:) vẫn lấy được; khóa id thô của Medusa (giữ hàng) thì Redis "mất".
      redis.acquireLock = (async (...args: unknown[]) => {
        const keyName = String(args[0]);
        if (!/^medusa_lock:(cart|inventory_item|promotion):/.test(keyName)) {
          throw new Error("Connection is closed.");
        }
        return originalAcquireLock.apply(redis, args);
      }) as typeof originalAcquireLock;

      const key = newKey();
      const res = await client.submit(q, key);
      expectLockUnavailable(res, "mất giữa workflow");
      const [attempt] = await attemptsOfKey(key);
      expect(attempt).toMatchObject({ state: "failed", error_code: "LOCK_UNAVAILABLE" });
      expect(await countOrders(container)).toBe(ordersBefore);
      expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(0);
      expect(await leakedLocks([lockKeys.cart(cartId), lockKeys.inventoryItem(itemId)])).toEqual([]);

      await restoreRedis();
      const retry = await client.submit(q, key);
      expect(retry.status).toBe(200);
      expect(retry.data).toMatchObject({ checkout_attempt_id: attempt!.id, state: "ready" });
      expect(await countOrders(container)).toBe(ordersBefore + 1);
      expect(await reservationsOf(container, fx, "Đen/S")).toHaveLength(1);
    });

    it("Redis mất khi đang bù trừ (reservation chưa xoá được) → attempt giữ `preparing`, không mở lại cho retry; job đối chiếu dọn khi Redis về", async () => {
      const cartId = await client.createCart([["Trắng/M", 1]]);
      const q = await client.quote(cartId);
      const ordersBefore = await countOrders(container);
      outageBeforeFinalize.set(cartId, cutRedis);

      const key = newKey();
      const res = await client.submit(q, key);
      expect(res.status).toBeGreaterThanOrEqual(500);
      const [attempt] = await attemptsOfKey(key);
      // Phần dở (reservation) còn → KHÔNG failed/retryable (retry sẽ giữ hàng lần hai); để job đối chiếu xử lý.
      expect(attempt).toMatchObject({ state: "preparing" });
      // Tái hiện đúng tình huống: đơn native đã bị xoá nhưng reservation còn (bù trừ lồng không báo lỗi).
      expect(await countOrders(container)).toBe(ordersBefore);
      expect(await reservationsOf(container, fx, "Trắng/M")).toHaveLength(1);

      await restoreRedis();
      // Gửi lại cùng key TRƯỚC khi job chạy → không chạy lại workflow (không giữ hàng lần hai): 202 đang xử lý.
      const early = await client.submit(q, key);
      expect(early.status).toBe(202);
      expect(await reservationsOf(container, fx, "Trắng/M")).toHaveLength(1);

      // Khóa giỏ của attempt không nhả được lúc Redis mất: nó KHÔNG còn được gia hạn, chỉ sống tới hết TTL. Mô phỏng
      // Redis về sau quá TTL (không chờ thời gian thật): rút TTL còn lại rồi đợi hết hạn.
      const cartLock = `medusa_lock:${lockKeys.cart(cartId)}`;
      const ttl = await redis.ttl(cartLock);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(CHECKOUT_CONFIG.lockTtlSeconds);
      await redis.pexpire(cartLock, 1);
      await new Promise((r) => setTimeout(r, 20));
      const leaseEnd = new Date(attempt!.lease_until as unknown as string).getTime();
      const summary = await reconcileAttempts(container, { now: new Date(leaseEnd + 60_000) });
      expect(summary.compensated).toEqual([attempt!.id]);
      expect(await reservationsOf(container, fx, "Trắng/M")).toHaveLength(0);
      expect(await inventoryLevel(container, fx, "Trắng/M")).toEqual({ stocked: 10, reserved: 0 });
      const [after] = await attemptsOfKey(key);
      expect(after).toMatchObject({ state: "compensated" });

      // Gửi lại cùng key → trạng thái kết thúc rõ ràng (đặt lại bằng key mới), không tạo đơn thứ hai.
      const retry = await client.submit(q, key);
      expect({ status: retry.status, code: retry.data.code }).toEqual({
        status: 409,
        code: "ATTEMPT_ABORTED",
      });
      expect(await countOrders(container)).toBe(ordersBefore);
      expect(await reservationsOf(container, fx, "Trắng/M")).toHaveLength(0);
    });

    it("khóa giỏ đang bị giữ khi Redis khỏe → vẫn 409 BUSY_RETRY (không phải 503)", async () => {
      const cartId = await client.createCart([["Đen/M", 1]]);
      const q = await client.quote(cartId);
      const locking = container.resolve(Modules.LOCKING);
      const mutable = CHECKOUT_CONFIG as { lockWaitMs: number };
      const original = mutable.lockWaitMs;
      mutable.lockWaitMs = 300;
      await locking.acquire(lockKeys.cart(cartId), { ownerId: "khach-khac", expire: 30 });
      try {
        const res = await client.submit(q);
        expect({ status: res.status, code: res.data.code }).toEqual({ status: 409, code: "BUSY_RETRY" });
        expect(res.headers["retry-after"]).toBe("1");
      } finally {
        mutable.lockWaitMs = original;
        await locking.release(lockKeys.cart(cartId), { ownerId: "khach-khac" });
      }
    });
  },
});
