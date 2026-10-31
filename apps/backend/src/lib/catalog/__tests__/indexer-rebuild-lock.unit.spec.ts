import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CATALOG_INDEX_MODULE } from "../../../modules/catalog-index";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { DirtyClaim } from "../../../modules/catalog-index/service";
import {
  CATALOG_INDEX_LOCK,
  CATALOG_REBUILD_LOCK,
  drainCatalogIndex,
  rebuildCatalogIndex,
  REBUILD_MARK,
} from "../indexer";
import type { ProductSource } from "../product-source";

/**
 * T-167 (D-076): dấu '*' trong hàng đợi → rebuild chạy SAU khi lượt xả nhả khoá ghi; rebuild đọc nguồn khi KHÔNG giữ khoá
 * ghi (chỉ giữ khoá rebuild), giữ khoá ghi đúng lúc `replaceAll`; sản phẩm bẩn cùng lô vẫn đồng bộ ngay; dấu '*' chỉ xoá
 * sau khi rebuild thay bảng, rebuild khác đang chạy (bận) thì giữ dấu cho lượt sau.
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

const claim = (id: string): DirtyClaim => ({
  product_id: id,
  marked_at: "2026-10-27 00:00:00.000001+00",
  attempts: 0,
});

function setup(opts: { rebuildBusy?: boolean } = {}) {
  const log: string[] = [];
  const held = new Set<string>();
  const state = () => `[${[...held].sort().join(",")}]`;
  let starPending = true;
  let productServed = false;
  const locking = {
    acquire: jest.fn(async (key: string) => {
      if (key === CATALOG_REBUILD_LOCK && opts.rebuildBusy === true) {
        throw new Error(`Failed to acquire lock for key ${key}`);
      }
      held.add(key);
    }),
    release: jest.fn(async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) held.delete(k);
      return true;
    }),
  };
  const index = {
    claimDirty: jest.fn(async () => {
      const out: DirtyClaim[] = [];
      if (starPending) out.push(claim(REBUILD_MARK));
      if (!productServed) {
        productServed = true;
        out.push(claim("prod_1"));
      }
      return out;
    }),
    clearDirty: jest.fn(async (claims: DirtyClaim[]) => {
      if (claims.some((c) => c.product_id === REBUILD_MARK)) {
        starPending = false;
        log.push(`clear:*${state()}`);
      }
    }),
    deferDirty: jest.fn(async () => undefined),
    dirtyCount: jest.fn(async () => 0),
    replaceProducts: jest.fn(async (ids: string[]) => {
      log.push(`replaceProducts:${ids.join(",")}${state()}`);
    }),
    clockNow: jest.fn(async () => "2026-10-27 00:00:01.000001+00"),
    replaceAll: jest.fn(async (rows: unknown[]) => {
      log.push(`replaceAll${state()}`);
      return { applied: true, inserted: rows.length, keptProducts: [] as string[], keptRows: 0 };
    }),
    countRows: jest.fn(async (ids?: string[]) => (ids ?? ["prod_1", "prod_2"]).length),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  mockSources.mockImplementation(async (_c: unknown, q: { id: string[] }) => {
    log.push(`read:${q.id.join(",")}${state()}`);
    return q.id.map(product);
  });
  const container = {
    resolve: (key: string) => {
      if (key === Modules.LOCKING) return locking;
      if (key === Modules.PRODUCT) {
        return {
          listProducts: async () => {
            log.push(`listProducts${state()}`);
            return [{ id: "prod_1" }, { id: "prod_2" }];
          },
        };
      }
      if (key === CATALOG_INDEX_MODULE) return index;
      if (key === CHECKOUT_MODULE)
        return { insertOutbox: jest.fn(), openOpsExceptionIfNoneActive: jest.fn() };
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      return null;
    },
  } as unknown as MedusaContainer;
  return { container, log, index, logger };
}

const saved = { ...process.env };
beforeEach(() => {
  // Webhook revalidate tắt (không khoá) — chỉ kiểm khoá/thứ tự ghi.
  delete process.env.CATALOG_REVALIDATE_SECRET;
  delete process.env.CATALOG_REVALIDATE_URLS;
  process.env.DATABASE_URL ??= "postgres://xshop:xshop@localhost:5432/xshop";
  mockSources.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
});

describe("lượt xả gặp dấu '*' (T-167)", () => {
  it("đồng bộ sản phẩm bẩn trong khoá ghi trước; rebuild đọc nguồn NGOÀI khoá ghi, chỉ giữ khoá ghi lúc replaceAll; xoá '*' sau khi thay bảng", async () => {
    const { container, log } = setup();
    const n = await drainCatalogIndex(container);
    expect(n).toBe(2);
    const W = CATALOG_INDEX_LOCK;
    const R = CATALOG_REBUILD_LOCK;
    expect(log).toEqual([
      `read:prod_1[${W}]`,
      `replaceProducts:prod_1[${W}]`,
      `listProducts[${R}]`,
      `read:prod_1,prod_2[${R}]`,
      `replaceAll[${[W, R].sort().join(",")}]`,
      "clear:*[]",
    ]);
  });

  it("rebuild khác đang chạy (khoá rebuild bận, lượt xả không chờ): sản phẩm vẫn đồng bộ, dấu '*' GIỮ cho lượt sau, warn", async () => {
    const { container, log, index, logger } = setup({ rebuildBusy: true });
    const n = await drainCatalogIndex(container);
    expect(n).toBe(1);
    expect(log).toEqual([
      `read:prod_1[${CATALOG_INDEX_LOCK}]`,
      `replaceProducts:prod_1[${CATALOG_INDEX_LOCK}]`,
    ]);
    expect(index.replaceAll).not.toHaveBeenCalled();
    expect(
      index.clearDirty.mock.calls.flat(2).some((c) => (c as DirtyClaim).product_id === REBUILD_MARK),
    ).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("dấu '*'"));
  });
});

/**
 * Review T-167 🔴1/🟢A: sản phẩm giữ bản đồng bộ được đánh dấu bẩn lại trong replaceAll → rebuild xong phải HẸN lượt xả
 * ngay (không để bản có thể cũ chờ job mỗi phút). Không giữ sản phẩm nào → không hẹn.
 */
describe("rebuild xong hẹn lượt xả cho sản phẩm giữ bản đồng bộ (T-167)", () => {
  async function run(keptProducts: string[]) {
    const { container, index } = setup();
    // Hàng đợi rỗng: lượt xả hẹn (nếu có) chỉ gọi claimDirty rồi thôi.
    index.claimDirty.mockImplementation(async () => []);
    index.replaceAll.mockImplementation(async (rows: unknown[]) => ({
      applied: true,
      inserted: rows.length - keptProducts.length,
      keptProducts,
      keptRows: keptProducts.length,
    }));
    const result = await rebuildCatalogIndex(container);
    expect(index.claimDirty).not.toHaveBeenCalled(); // rebuild không tự xả trong chính lời gọi
    await new Promise((r) => setTimeout(r, 100)); // lượt hẹn `scheduleCatalogDrain(container, 0)` chạy trên timer
    return { result, index };
  }

  it("có sản phẩm giữ lại → lượt xả hẹn chạy (claimDirty được gọi)", async () => {
    const { result, index } = await run(["prod_1"]);
    expect(result.kept).toBe(1);
    expect(index.claimDirty).toHaveBeenCalled();
  });

  it("không giữ sản phẩm nào → không hẹn lượt xả", async () => {
    const { result, index } = await run([]);
    expect(result.kept).toBe(0);
    expect(index.claimDirty).not.toHaveBeenCalled();
  });
});
