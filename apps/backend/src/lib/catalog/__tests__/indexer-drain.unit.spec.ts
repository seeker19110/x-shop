import { Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CATALOG_INDEX_MODULE } from "../../../modules/catalog-index";
import { LOCK_CALL_TIMEOUT_MS } from "../../checkout/locks";
import {
  CATALOG_INDEX_LOCK,
  DRAIN_LOCK_EXPIRE_SECONDS,
  drainCatalogIndex,
  rebuildCatalogIndex,
  syncCatalogProducts,
} from "../indexer";

/** Lượt xả giữ khoá bằng lease ngắn có gia hạn — tiến trình chết thì khoá tự hết, không chặn rebuild 10 phút. */
describe("drainCatalogIndex — lease khoá", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(opts: { renewFails?: boolean } = {}) {
    let finishClaim: (v: never[]) => void = () => undefined;
    const acquire = jest.fn(async (_key: string, _args: { ownerId: string; expire: number }) => {
      if (opts.renewFails === true && acquire.mock.calls.length > 1) throw new Error("Connection is closed.");
    });
    const release = jest.fn(async () => undefined);
    const index = {
      // Lô đầu treo tới khi test cho xong → mô phỏng một lượt xả dài.
      claimDirty: jest.fn(() => new Promise<never[]>((r) => (finishClaim = r))),
      clearDirty: jest.fn(),
      dirtyCount: jest.fn(async () => 0),
    };
    const container = {
      resolve: (key: string) =>
        key === Modules.LOCKING ? { acquire, release } : key === CATALOG_INDEX_MODULE ? index : null,
    } as unknown as MedusaContainer;
    return { acquire, release, container, finish: () => finishClaim([]) };
  }

  it("lease ≤ 30 giây, gia hạn cùng ownerId khi còn xả, ngừng gia hạn sau khi nhả", async () => {
    const { acquire, release, container, finish } = setup();
    const run = drainCatalogIndex(container);
    await Promise.resolve();
    expect(acquire).toHaveBeenCalledTimes(1);
    const [key, first] = acquire.mock.calls[0]!;
    expect(key).toBe(CATALOG_INDEX_LOCK);
    expect(first.expire).toBe(DRAIN_LOCK_EXPIRE_SECONDS);
    expect(DRAIN_LOCK_EXPIRE_SECONDS).toBeLessThanOrEqual(30);

    await jest.advanceTimersByTimeAsync(DRAIN_LOCK_EXPIRE_SECONDS * 1000); // 3 lần gia hạn trong một lease
    expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [, args] of acquire.mock.calls) expect(args).toEqual(first);

    finish();
    await expect(run).resolves.toBe(0);
    expect(release).toHaveBeenCalledWith([CATALOG_INDEX_LOCK], { ownerId: first.ownerId });
    const after = acquire.mock.calls.length;
    await jest.advanceTimersByTimeAsync(DRAIN_LOCK_EXPIRE_SECONDS * 2000);
    expect(acquire).toHaveBeenCalledTimes(after);
  });

  it("gia hạn lỗi (Redis mất) không làm hỏng lượt xả — lease tự hết", async () => {
    const { release, container, finish } = setup({ renewFails: true });
    const run = drainCatalogIndex(container);
    await jest.advanceTimersByTimeAsync(DRAIN_LOCK_EXPIRE_SECONDS * 1000);
    finish();
    await expect(run).resolves.toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

/** Redis câm (lệnh treo): mọi lời gọi khoá có hạn, không kẹt job/shutdown. */
describe("khoá read model — Redis không trả lời", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const never = () => new Promise<never>(() => undefined);

  function setup(locking: Record<string, unknown>) {
    const warn = jest.fn();
    const index = {
      claimDirty: jest.fn(async () => []),
      clearDirty: jest.fn(),
      dirtyCount: jest.fn(async () => 0),
    };
    const container = {
      resolve: (key: string) =>
        key === Modules.LOCKING
          ? locking
          : key === CATALOG_INDEX_MODULE
            ? index
            : { warn, info: jest.fn(), error: jest.fn() },
    } as unknown as MedusaContainer;
    return { container, index, warn };
  }

  it("acquire treo: drain bỏ lượt sau ≤ hạn, không đụng hàng đợi, log warn, không ném, không gia hạn", async () => {
    const acquire = jest.fn(() => never());
    const release = jest.fn(async () => true);
    const { container, index, warn } = setup({ acquire, release });
    let done: number | undefined;
    const run = drainCatalogIndex(container).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(LOCK_CALL_TIMEOUT_MS - 1);
    expect(done).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await run;
    expect(done).toBe(0);
    expect(index.claimDirty).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const calls = acquire.mock.calls.length;
    await jest.advanceTimersByTimeAsync(DRAIN_LOCK_EXPIRE_SECONDS * 3000);
    expect(acquire).toHaveBeenCalledTimes(calls); // renewal không chạy
  });

  it("khoá bận (đang xả/rebuild): bỏ lượt ngay, không warn", async () => {
    const acquire = jest.fn(async () => {
      throw new Error("Failed to acquire lock for key x");
    });
    const { container, warn } = setup({ acquire, release: jest.fn() });
    await expect(drainCatalogIndex(container)).resolves.toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("release treo: drain vẫn kết thúc sau ≤ hạn, log warn", async () => {
    const acquire = jest.fn(async () => undefined);
    const release = jest.fn(() => never());
    const { container, warn } = setup({ acquire, release });
    let done: number | undefined;
    const run = drainCatalogIndex(container).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(LOCK_CALL_TIMEOUT_MS);
    await run;
    expect(done).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("sync/rebuild gọi từ route/admin: acquire treo → LOCK_UNAVAILABLE sau ≤ hạn, không chạy việc", async () => {
    const acquire = jest.fn(() => never());
    const { container, index } = setup({ acquire, release: jest.fn(async () => true) });
    for (const call of [
      () => syncCatalogProducts(container, ["prod_1"]),
      () => rebuildCatalogIndex(container),
    ]) {
      const settled = call().then(
        () => "ok",
        (e: { code?: string }) => e.code,
      );
      await jest.advanceTimersByTimeAsync(LOCK_CALL_TIMEOUT_MS);
      await expect(settled).resolves.toBe("LOCK_UNAVAILABLE");
    }
    expect(index.claimDirty).not.toHaveBeenCalled();
  });

  it("syncCatalogProducts rỗng không chạm khoá", async () => {
    const acquire = jest.fn(() => never());
    const { container } = setup({ acquire, release: jest.fn() });
    await expect(syncCatalogProducts(container, [])).resolves.toBe(0);
    expect(acquire).not.toHaveBeenCalled();
  });
});
