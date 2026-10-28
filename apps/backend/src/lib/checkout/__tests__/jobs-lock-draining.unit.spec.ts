import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import { resetShutdownStateForTest, shutdownState } from "../../lifecycle/shutdown";
import { activeLeaseCount, lockKeys, type LockingLike } from "../locks";
import { expireHolds, reconcileAttempts } from "../jobs";

/**
 * T-174: `withLock` của job truyền `abortWhenDraining` — khoá đơn/giỏ đang bị chủ khác giữ, bật cờ tắt giữa lúc chờ →
 * lượt chạy trả về sớm (đồng hồ giả, không chờ tới `orderLockWaitMs` 15 s), đơn vị nằm trong `skipped`. Dùng `acquireOrdered`
 * THẬT (không mock) nên xoá `abortWhenDraining: true` ở `withLock` làm các ca này đỏ.
 */

jest.mock("../recheck", () => ({ queryAndProcess: jest.fn(async () => ({ outcome: "not_paid" })) }));

class FakeLocking implements LockingLike {
  readonly owners = new Map<string, string>();
  async acquire(keys: string | string[], args: { ownerId?: string | null } = {}): Promise<void> {
    const owner = args.ownerId ?? "*";
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const cur = this.owners.get(key);
      if (cur !== undefined && cur !== owner) throw new Error(`Failed to acquire lock for key "${key}"`);
      this.owners.set(key, owner);
    }
  }
  async release(keys: string | string[], args: { ownerId?: string | null } = {}): Promise<boolean> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.owners.get(key) === (args.ownerId ?? "*")) this.owners.delete(key);
    }
    return true;
  }
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function containerOf(service: Record<string, unknown>, locking: LockingLike): MedusaContainer {
  return {
    resolve: (key: string) => {
      if (key === CHECKOUT_MODULE) return service;
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      if (key === Modules.LOCKING) return locking;
      throw new Error(`không có ${key}`);
    },
  } as unknown as MedusaContainer;
}

beforeEach(() => {
  resetShutdownStateForTest();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  resetShutdownStateForTest();
  expect(activeLeaseCount()).toBe(0);
});

describe("job chờ khoá khi tắt (T-174)", () => {
  it("expireHolds: khoá order: bận, bật cờ tắt giữa lúc chờ → về sớm, đơn nằm trong skipped", async () => {
    const locking = new FakeLocking();
    await locking.acquire(lockKeys.order("ord_1"), { ownerId: "OTHER" });
    const service = {
      listExpiredHoldOrderIds: async () => ["ord_1"],
      readJobBreaker: async () => null,
      countUnknownHoldBacklog: async () => 0,
    };
    const start = Date.now();
    const p = expireHolds(containerOf(service, locking), { now: new Date() });
    await jest.advanceTimersByTimeAsync(300);
    shutdownState().draining = true;
    await jest.advanceTimersByTimeAsync(200);
    const r = await p;
    expect(r.skipped).toEqual(["ord_1"]);
    expect(r.cancelled).toEqual([]);
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("reconcileAttempts: khoá cart: bận, bật cờ tắt giữa lúc chờ → về sớm, attempt nằm trong skipped", async () => {
    const locking = new FakeLocking();
    await locking.acquire(lockKeys.cart("cart_1"), { ownerId: "OTHER" });
    const service = {
      listStaleAttempts: async () => [{ id: "att_1", cart_id: "cart_1" }],
      claimStaleAttempt: jest.fn(async () => true),
    };
    const start = Date.now();
    const p = reconcileAttempts(containerOf(service, locking), { now: new Date() });
    await jest.advanceTimersByTimeAsync(100);
    shutdownState().draining = true;
    await jest.advanceTimersByTimeAsync(100);
    const r = await p;
    expect(r.skipped).toEqual(["att_1"]);
    expect(service.claimStaleAttempt).not.toHaveBeenCalled();
    expect(Date.now() - start).toBeLessThan(500);
  });
});
