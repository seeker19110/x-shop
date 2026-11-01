import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import catalogIndexRebuildJob from "../../../jobs/catalog-index-rebuild";
import { CATALOG_INDEX_MODULE } from "../../../modules/catalog-index";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { DirtyClaim } from "../../../modules/catalog-index/service";
import { activeLeaseCount } from "../../checkout/locks";
import { resetShutdownStateForTest, shutdownState } from "../../lifecycle/shutdown";
import {
  CATALOG_INDEX_LOCK,
  CATALOG_REBUILD_LOCK,
  drainCatalogIndex,
  rebuildCatalogIndex,
  REBUILD_MARK,
} from "../indexer";
import type { ProductSource } from "../product-source";

/**
 * T-237 (D-081/T-174 "mọi vòng chờ kiểm isDraining"): rebuild chạy từ job (job rebuild 30 phút, dấu '*' trong lượt xả)
 * chờ khoá rebuild rồi khoá ghi index, mỗi khoá tới `LOCK_WAIT_MS` = 5 phút. Trước T-237 `withOwnedLock` bỏ rơi
 * `abortWhenDraining` → SIGTERM giữa lúc chờ giữ tiến trình tới 2×5 phút (vượt trần tắt êm 25 s). Sau: thôi chờ ngay,
 * job kết thúc gọn (không log error, không ném); đường không phải job (CLI/không truyền tuỳ chọn) vẫn chờ như cũ.
 * Đồng hồ thật: backoff chờ khoá ≤ ~120 ms/lần nên "trả về trong vài giây" đo được trực tiếp.
 */

const mockSources = jest.fn();

jest.mock("../product-source", () => ({
  ...jest.requireActual("../product-source"),
  loadProductSources: (...args: unknown[]) => mockSources(...args),
}));
jest.mock("../dictionary", () => ({
  ...jest.requireActual("../dictionary"),
  loadDictionary: async () => ({ colors: new Map(), sizes: new Map() }),
}));
jest.mock("../sell-state", () => ({
  ...jest.requireActual("../sell-state"),
  resolvePricingContext: async () => ({ regionId: null, currencyCode: "vnd" }),
  loadVariantPrices: async (_c: unknown, ids: string[]) =>
    new Map(ids.map((v) => [v, { price: 100_000, compareAt: null, validUntil: null }])),
  loadInStock: async () => new Map<string, boolean>(),
}));

const product = (id: string): ProductSource => ({
  id,
  handle: id,
  title: id,
  description: null,
  status: "published",
  thumbnail: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  categories: [],
  salesChannelIds: ["sc_1"],
  images: [],
  variants: [
    {
      id: `${id}_v1`,
      sku: `${id}-SKU`,
      rank: 0,
      color: null,
      size: null,
      manageInventory: false,
      allowBackorder: true,
      basePrice: 100_000,
    },
  ],
  attributes: null,
  sizeChart: null,
});

const OTHER = "OTHER";

/** Khoá giả theo chủ: khoá đang thuộc chủ khác → lỗi "đang bận" như provider locking-redis. */
function setup(opts: { holdRebuild?: boolean; holdIndexOnRead?: boolean; star?: boolean } = {}) {
  const owners = new Map<string, string>();
  if (opts.holdRebuild === true) owners.set(CATALOG_REBUILD_LOCK, OTHER);
  const locking = {
    acquire: jest.fn(async (keys: string | string[], args: { ownerId?: string | null } = {}) => {
      const owner = args.ownerId ?? "*";
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        const cur = owners.get(key);
        if (cur !== undefined && cur !== owner) throw new Error(`Failed to acquire lock for key ${key}`);
        owners.set(key, owner);
      }
    }),
    release: jest.fn(async (keys: string | string[], args: { ownerId?: string | null } = {}) => {
      for (const k of Array.isArray(keys) ? keys : [keys])
        if (owners.get(k) === (args.ownerId ?? "*")) owners.delete(k);
      return true;
    }),
  };
  let starPending = opts.star === true;
  const index = {
    claimDirty: jest.fn(async () => {
      const out: DirtyClaim[] = starPending
        ? [{ product_id: REBUILD_MARK, marked_at: "2026-10-31 00:00:00.000001+00", attempts: 0 }]
        : [];
      return out;
    }),
    clearDirty: jest.fn(async (claims: DirtyClaim[]) => {
      if (claims.some((c) => c.product_id === REBUILD_MARK)) starPending = false;
    }),
    deferDirty: jest.fn(async () => undefined),
    dirtyCount: jest.fn(async () => (starPending ? 1 : 0)),
    replaceProducts: jest.fn(async () => undefined),
    clockNow: jest.fn(async () => "2026-10-31 00:00:01.000001+00"),
    replaceAll: jest.fn(async (rows: unknown[]) => ({
      applied: true,
      inserted: rows.length,
      keptProducts: [] as string[],
      keptRows: 0,
    })),
    countRows: jest.fn(async () => 2),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const listProducts = jest.fn(async () => {
    // Một tiến trình khác (lượt xả/đồng bộ) giành khoá ghi index trong lúc rebuild đọc nguồn ngoài khoá ghi.
    if (opts.holdIndexOnRead === true) owners.set(CATALOG_INDEX_LOCK, OTHER);
    return [{ id: "prod_1" }, { id: "prod_2" }];
  });
  mockSources.mockImplementation(async (_c: unknown, q: { id: string[] }) => q.id.map(product));
  const container = {
    resolve: (key: string) => {
      if (key === Modules.LOCKING) return locking;
      if (key === Modules.PRODUCT) return { listProducts };
      if (key === CATALOG_INDEX_MODULE) return index;
      if (key === CHECKOUT_MODULE)
        return { insertOutbox: jest.fn(), openOpsExceptionIfNoneActive: jest.fn() };
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      return null;
    },
  } as unknown as MedusaContainer;
  return { container, owners, index, logger, listProducts };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Chờ `p` tối đa `ms` (đồng hồ thật): "done" + giá trị/lỗi, hoặc "pending" nếu chưa xong. */
async function within<T>(p: Promise<T>, ms: number) {
  const settled = p.then(
    (value) => ({ state: "done" as const, value, error: undefined as unknown }),
    (error: unknown) => ({ state: "done" as const, value: undefined, error }),
  );
  return Promise.race([settled, sleep(ms).then(() => ({ state: "pending" as const }))]);
}

/** Chờ điều kiện (đồng hồ thật, thăm dò 10 ms). */
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("điều kiện không đạt trong hạn");
    await sleep(10);
  }
}

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.CATALOG_REVALIDATE_SECRET;
  delete process.env.CATALOG_REVALIDATE_URLS;
  process.env.DATABASE_URL ??= "postgres://xshop:xshop@localhost:5432/xshop";
  mockSources.mockReset();
  resetShutdownStateForTest();
});
afterEach(() => {
  process.env = { ...saved };
  resetShutdownStateForTest();
});

describe("job rebuild catalog khi tắt giữa lúc chờ khoá (T-237)", () => {
  it("chờ khoá REBUILD (rebuild khác đang chạy) → bật cờ tắt, job trả về trong ≤ 2 s, không ném, không log error, không đọc nguồn", async () => {
    const { container, owners, logger, listProducts, index } = setup({ holdRebuild: true });
    const job = catalogIndexRebuildJob(container);
    await sleep(200);
    expect((await within(job, 0)).state).toBe("pending"); // đang chờ khoá thật
    shutdownState().draining = true;
    const start = Date.now();
    const r = await within(job, 2_000);
    expect(r.state).toBe("done");
    expect(r.state === "done" ? r.error : "x").toBeUndefined();
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(listProducts).not.toHaveBeenCalled();
    expect(index.replaceAll).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Đang tắt"));
    expect(owners.get(CATALOG_REBUILD_LOCK)).toBe(OTHER);
    expect(activeLeaseCount()).toBe(0);
  });

  it("chờ khoá GHI index (đã đọc xong nguồn, khoá ghi đang bị giữ) → bật cờ tắt, job trả về ≤ 2 s, bảng không thay, khoá rebuild được nhả", async () => {
    const { container, owners, logger, listProducts, index } = setup({ holdIndexOnRead: true });
    const job = catalogIndexRebuildJob(container);
    await until(() => listProducts.mock.calls.length > 0);
    await sleep(200);
    expect((await within(job, 0)).state).toBe("pending");
    expect(owners.get(CATALOG_REBUILD_LOCK)).toMatch(/^lock:/); // đang giữ khoá rebuild, chờ khoá ghi
    shutdownState().draining = true;
    const r = await within(job, 2_000);
    expect(r.state).toBe("done");
    expect(r.state === "done" ? r.error : "x").toBeUndefined();
    expect(index.replaceAll).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(owners.has(CATALOG_REBUILD_LOCK)).toBe(false);
    expect(owners.get(CATALOG_INDEX_LOCK)).toBe(OTHER);
    expect(activeLeaseCount()).toBe(0);
  });

  it("không tắt: khoá rebuild nhả sau 300 ms → job vẫn chờ và rebuild trọn (abortWhenDraining không đổi hành vi bình thường)", async () => {
    const { container, owners, index, logger } = setup({ holdRebuild: true });
    const job = catalogIndexRebuildJob(container);
    await sleep(300);
    owners.delete(CATALOG_REBUILD_LOCK);
    const r = await within(job, 2_000);
    expect(r.state).toBe("done");
    expect(r.state === "done" ? r.error : "x").toBeUndefined();
    expect(index.replaceAll).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(owners.size).toBe(0);
  });

  it("job rebuild: lỗi KHÁC khi đang tắt (không phải thôi chờ khoá) vẫn ném — không nuốt lỗi thật", async () => {
    const { container, index } = setup();
    index.clockNow.mockImplementation(async () => {
      shutdownState().draining = true;
      throw new Error("db down");
    });
    await expect(catalogIndexRebuildJob(container)).rejects.toThrow("db down");
  });
});

describe("rebuildCatalogIndex — tuỳ chọn abortWhenDraining (T-237)", () => {
  it("không truyền tuỳ chọn (CLI/seed) → đang tắt vẫn chờ khoá rebuild; khoá nhả thì rebuild trọn", async () => {
    const { container, owners, index } = setup({ holdRebuild: true });
    shutdownState().draining = true;
    const p = rebuildCatalogIndex(container);
    expect((await within(p, 600)).state).toBe("pending");
    owners.delete(CATALOG_REBUILD_LOCK);
    const r = await within(p, 2_000);
    expect(r.state).toBe("done");
    expect(r.state === "done" ? r.error : "x").toBeUndefined();
    expect(index.replaceAll).toHaveBeenCalledTimes(1);
  });

  it("abortWhenDraining + đang tắt → BUSY_RETRY (caller quyết định im lặng), không chạy rebuild", async () => {
    const { container, index } = setup({ holdRebuild: true });
    const p = rebuildCatalogIndex(container, { abortWhenDraining: true });
    await sleep(100);
    shutdownState().draining = true;
    const r = await within(p, 2_000);
    expect(r.state).toBe("done");
    expect((r.state === "done" ? (r.error as { code?: string }) : null)?.code).toBe("BUSY_RETRY");
    expect(index.clockNow).not.toHaveBeenCalled();
  });
});

describe("lượt xả gặp dấu '*' khi tắt giữa lúc rebuild chờ khoá ghi (T-237)", () => {
  it("rebuild theo dấu '*' chờ khoá ghi, bật cờ tắt → lượt xả trả về ≤ 2 s, GIỮ dấu '*', không log error/warn", async () => {
    const { container, index, logger, listProducts } = setup({ star: true, holdIndexOnRead: true });
    const drain = drainCatalogIndex(container);
    await until(() => listProducts.mock.calls.length > 0);
    await sleep(200);
    expect((await within(drain, 0)).state).toBe("pending");
    shutdownState().draining = true;
    const r = await within(drain, 2_000);
    expect(r.state).toBe("done");
    expect(r.state === "done" ? r.error : "x").toBeUndefined();
    expect(index.replaceAll).not.toHaveBeenCalled();
    expect(
      index.clearDirty.mock.calls.flat(2).some((c) => (c as DirtyClaim).product_id === REBUILD_MARK),
    ).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(activeLeaseCount()).toBe(0);
  });
});
