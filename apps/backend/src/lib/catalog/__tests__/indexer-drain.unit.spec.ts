import { Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CATALOG_INDEX_MODULE } from "../../../modules/catalog-index";
import { CATALOG_INDEX_LOCK, DRAIN_LOCK_EXPIRE_SECONDS, drainCatalogIndex } from "../indexer";

/** Lượt xả giữ khoá bằng lease ngắn có gia hạn — tiến trình chết thì khoá tự hết, không chặn rebuild 10 phút. */
describe("drainCatalogIndex — lease khoá", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(opts: { renewFails?: boolean } = {}) {
    let finishClaim: (v: never[]) => void = () => undefined;
    const acquire = jest.fn(async (_key: string, _args: { ownerId: string; expire: number }) => {
      if (opts.renewFails && acquire.mock.calls.length > 1) throw new Error("Connection is closed.");
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
    expect(release).toHaveBeenCalledWith(CATALOG_INDEX_LOCK, { ownerId: first.ownerId });
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
