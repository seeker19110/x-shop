import { Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CATALOG_INDEX_MODULE } from "../../../modules/catalog-index";
import { LOCK_CALL_TIMEOUT_MS } from "../../checkout/locks";
import { resetShutdownStateForTest, shutdownState } from "../../lifecycle/shutdown";
import {
  CATALOG_INDEX_LOCK,
  DRAIN_LOCK_EXPIRE_SECONDS,
  DRAIN_WAIT_SLICE_MS,
  drainCatalogIndex,
  drainCatalogIndexForJob,
  rebuildCatalogIndex,
  scheduleCatalogDrain,
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

/**
 * T-137: khoá bận khi xả mà người giữ KHÔNG phải lượt xả (rebuild/sync dài, tiến trình khác) → bỏ lượt làm dấu nằm chờ
 * job mỗi phút. Lượt xả có `waitMs` chờ khoá; hết dấu đến hạn trong lúc chờ (người khác đã xả) thì thôi.
 */
describe("drainCatalogIndex — chờ khoá bận (T-137)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const busy = () => new Error("Failed to acquire lock for key x-shop:catalog-index");

  function setup() {
    const state = { held: true, dirty: 1 };
    const owners: string[] = [];
    const acquire = jest.fn(async (_key: string, args: { ownerId: string; expire: number }) => {
      if (!owners.includes(args.ownerId)) owners.push(args.ownerId);
      if (state.held) throw busy();
    });
    const release = jest.fn(async () => true);
    const index = {
      // Xả xong lô → không còn dấu.
      claimDirty: jest.fn(async () => {
        state.dirty = 0;
        return [];
      }),
      clearDirty: jest.fn(),
      dirtyCount: jest.fn(async () => state.dirty),
    };
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    const container = {
      resolve: (key: string) =>
        key === Modules.LOCKING ? { acquire, release } : key === CATALOG_INDEX_MODULE ? index : logger,
    } as unknown as MedusaContainer;
    return { state, owners, acquire, index, logger, container };
  }

  it("khoá bận rồi nhả: chờ (thăm dò ≤ 80 ms) và xả ngay sau khi nhả, không bỏ lượt", async () => {
    const { state, index, container, logger } = setup();
    let done: number | undefined;
    const run = drainCatalogIndex(container, { waitMs: 60_000 }).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(done).toBeUndefined();
    expect(index.claimDirty).not.toHaveBeenCalled();
    state.held = false;
    await jest.advanceTimersByTimeAsync(150);
    await run;
    expect(done).toBe(0);
    expect(index.claimDirty).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("bận nhưng dấu đã được lượt xả khác xả hết: thôi chờ sau ≤ một lát, không giành khoá", async () => {
    const { state, acquire, index, container } = setup();
    let done: number | undefined;
    const run = drainCatalogIndex(container, { waitMs: 60_000 }).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(1_000);
    state.dirty = 0;
    await jest.advanceTimersByTimeAsync(DRAIN_WAIT_SLICE_MS + 200);
    await run;
    expect(done).toBe(0);
    expect(index.claimDirty).not.toHaveBeenCalled();
    const calls = acquire.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(acquire).toHaveBeenCalledTimes(calls);
  });

  it("bận quá hạn chờ: trả 0, warn một lần, dấu để lượt/job sau", async () => {
    const { index, container, logger } = setup();
    let done: number | undefined;
    const run = drainCatalogIndex(container, { waitMs: 5_000 }).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(4_900);
    expect(done).toBeUndefined();
    await jest.advanceTimersByTimeAsync(300);
    await run;
    expect(done).toBe(0);
    expect(index.claimDirty).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("Redis lỗi trong lúc chờ: bỏ lượt ngay (LOCK_UNAVAILABLE), không chờ hết hạn", async () => {
    const { acquire, index, container, logger } = setup();
    acquire.mockImplementationOnce(async () => {
      throw busy();
    });
    acquire.mockImplementationOnce(async () => {
      throw new Error("Connection is closed.");
    });
    let done: number | undefined;
    const run = drainCatalogIndex(container, { waitMs: 60_000 }).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(500);
    await run;
    expect(done).toBe(0);
    expect(index.claimDirty).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("scheduleCatalogDrain đồng thời: một lượt chờ khoá mỗi tiến trình; yêu cầu trong lúc chờ gộp thành MỘT lượt chạy lại", async () => {
    const { state, owners, index, container } = setup();
    for (let i = 0; i < 5; i++) scheduleCatalogDrain(container);
    await jest.advanceTimersByTimeAsync(300);
    // Sự kiện tiếp tục tới trong lúc lượt đầu đang chờ khoá.
    for (let i = 0; i < 10; i++) {
      scheduleCatalogDrain(container);
      await jest.advanceTimersByTimeAsync(500);
    }
    expect(owners).toHaveLength(1);
    expect(index.claimDirty).not.toHaveBeenCalled();
    state.held = false;
    await jest.advanceTimersByTimeAsync(1_000);
    // Lượt đầu xả + đúng một lượt chạy lại (yêu cầu đến trong lúc chờ), rồi dừng.
    expect(owners).toHaveLength(2);
    expect(index.claimDirty).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(owners).toHaveLength(2);
    // Hết lượt đang chạy → yêu cầu mới hẹn lượt mới bình thường.
    scheduleCatalogDrain(container);
    await jest.advanceTimersByTimeAsync(500);
    expect(owners).toHaveLength(3);
  });

  it("job (D-081): khoá bận → trả ngay (không chiếm khe job worker), giao lượt nền xả khi khoá nhả", async () => {
    const { state, owners, index, container } = setup();
    await expect(drainCatalogIndexForJob(container)).resolves.toBe(0);
    expect(owners).toHaveLength(1); // chỉ thử một lần, không chờ
    await jest.advanceTimersByTimeAsync(3_000);
    expect(owners).toHaveLength(2); // lượt nền đang chờ khoá
    expect(index.claimDirty).not.toHaveBeenCalled();
    state.held = false;
    await jest.advanceTimersByTimeAsync(500);
    expect(index.claimDirty).toHaveBeenCalledTimes(1);
  });

  it("job: không còn dấu đến hạn → không hẹn lượt nền", async () => {
    const { state, owners, container } = setup();
    state.dirty = 0;
    await expect(drainCatalogIndexForJob(container)).resolves.toBe(0);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(owners).toHaveLength(1);
  });
});

/** D-081 F2: lượt xả biết tiến trình đang tắt (T-094) — không chờ/không giành khoá/không bắt đầu đồng bộ giữa lúc tắt. */
describe("drainCatalogIndex — đang tắt (T-137, D-081)", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    resetShutdownStateForTest();
    jest.useRealTimers();
  });

  const busy = () => new Error("Failed to acquire lock for key x-shop:catalog-index");

  function setup() {
    const state = { held: true, dirty: 1 };
    const owners: string[] = [];
    const acquire = jest.fn(async (_key: string, args: { ownerId: string; expire: number }) => {
      if (!owners.includes(args.ownerId)) owners.push(args.ownerId);
      if (state.held) throw busy();
    });
    const release = jest.fn(async () => true);
    const index = {
      claimDirty: jest.fn(async () => {
        state.dirty = 0;
        return [];
      }),
      clearDirty: jest.fn(),
      dirtyCount: jest.fn(async () => state.dirty),
    };
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    const container = {
      resolve: (key: string) =>
        key === Modules.LOCKING ? { acquire, release } : key === CATALOG_INDEX_MODULE ? index : logger,
    } as unknown as MedusaContainer;
    return { state, owners, acquire, release, index, container };
  }

  it("tín hiệu tắt khi đang chờ khoá: thôi chờ sau ≤ một lát, không giành khoá, không xả", async () => {
    const { acquire, index, container } = setup();
    let done: number | undefined;
    const run = drainCatalogIndex(container, { waitMs: 300_000 }).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(1_000);
    shutdownState().draining = true;
    await jest.advanceTimersByTimeAsync(DRAIN_WAIT_SLICE_MS + 200);
    await run;
    expect(done).toBe(0);
    expect(index.claimDirty).not.toHaveBeenCalled();
    const calls = acquire.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(acquire).toHaveBeenCalledTimes(calls);
  });

  it("khoá nhả đúng lúc đang tắt: giành được thì nhả ngay, không bắt đầu đồng bộ", async () => {
    const { state, release, index, container } = setup();
    let done: number | undefined;
    const run = drainCatalogIndex(container, { waitMs: 300_000 }).then((n) => (done = n));
    await jest.advanceTimersByTimeAsync(1_000);
    shutdownState().draining = true;
    state.held = false;
    await jest.advanceTimersByTimeAsync(200);
    await run;
    expect(done).toBe(0);
    expect(index.claimDirty).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith([CATALOG_INDEX_LOCK], expect.anything());
  });

  it("đang tắt: scheduleCatalogDrain không hẹn; job không hẹn lượt nền", async () => {
    const { owners, container } = setup();
    shutdownState().draining = true;
    scheduleCatalogDrain(container, 0);
    await drainCatalogIndexForJob(container);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(owners).toHaveLength(0);
  });

  it("tín hiệu tắt khi lượt hẹn đang chờ: không chạy lại dù có yêu cầu gộp", async () => {
    const { owners, index, container } = setup();
    scheduleCatalogDrain(container, 0);
    await jest.advanceTimersByTimeAsync(500);
    scheduleCatalogDrain(container); // yêu cầu gộp trong lúc chờ
    shutdownState().draining = true;
    await jest.advanceTimersByTimeAsync(DRAIN_WAIT_SLICE_MS * 3);
    expect(owners).toHaveLength(1);
    expect(index.claimDirty).not.toHaveBeenCalled();
    // Lượt hẹn đã kết thúc: sau khi tắt xong (test đặt lại trạng thái), hẹn mới chạy bình thường.
    resetShutdownStateForTest();
    scheduleCatalogDrain(container, 0);
    await jest.advanceTimersByTimeAsync(100);
    expect(owners).toHaveLength(2);
  });
});
