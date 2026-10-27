import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CATALOG_INDEX_MODULE } from "../../../modules/catalog-index";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { DirtyClaim } from "../../../modules/catalog-index/service";
import { drainCatalogIndex, rebuildCatalogIndex } from "../indexer";
import type { ProductSource } from "../product-source";
import { CATALOG_REVALIDATE_EVENT, resetRevalidateStateForTests } from "../revalidate";

/**
 * T-142 (review 🟠1): outbox `catalog.revalidate` chỉ được ghi SAU khi read model đã ghi xong (đồng bộ từng sản phẩm và
 * rebuild toàn phần) — danh sách/tìm kiếm storefront nạp lại ngay khi nhận webhook phải đọc được bản mới. Đảo thứ tự
 * (ghi outbox trước `replaceProducts`/`replaceAll`) → test đỏ.
 */

const mockSources = jest.fn();
const mockPrices = jest.fn();

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
  loadVariantPrices: (...args: unknown[]) => mockPrices(...args),
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

/** Ghi lại thứ tự: thao tác read model và ghi outbox revalidate vào cùng một mảng. */
function setup(opts: { missingPrice?: boolean } = {}) {
  const order: string[] = [];
  let served = false;
  const index = {
    claimDirty: jest.fn(async () => {
      if (served) return [];
      served = true;
      return [claim("prod_1"), claim("prod_2")];
    }),
    clearDirty: jest.fn(async () => undefined),
    deferDirty: jest.fn(async () => undefined),
    dirtyCount: jest.fn(async () => 0),
    replaceProducts: jest.fn(async (ids: string[]) => {
      await new Promise((r) => setImmediate(r));
      order.push(`index:replaceProducts:${ids.join(",")}`);
    }),
    replaceAll: jest.fn(async () => {
      await new Promise((r) => setImmediate(r));
      order.push("index:replaceAll");
    }),
    countRows: jest.fn(async (ids?: string[]) => (ids ?? ["prod_1", "prod_2"]).length),
  };
  const checkout = {
    insertOutbox: jest.fn(async (key: string, _agg: string, type: string) => {
      if (type === CATALOG_REVALIDATE_EVENT) order.push(`outbox:${key.split(":").slice(1, 2).join("")}`);
    }),
    openOpsExceptionIfNoneActive: jest.fn(async () => true),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  mockSources.mockImplementation(async (_c: unknown, q: { id: string[] }) => q.id.map(product));
  mockPrices.mockImplementation(async (_c: unknown, variantIds: string[]) => {
    const out = new Map<string, unknown>();
    if (opts.missingPrice !== true) {
      for (const v of variantIds) out.set(v, { price: 100_000, compareAt: null, validUntil: null });
    }
    return out;
  });
  const container = {
    resolve: (key: string) => {
      if (key === Modules.LOCKING) return { acquire: async () => undefined, release: async () => true };
      if (key === Modules.PRODUCT) {
        return { listProducts: async () => [{ id: "prod_1" }, { id: "prod_2" }] };
      }
      if (key === CATALOG_INDEX_MODULE) return index;
      if (key === CHECKOUT_MODULE) return checkout;
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      return null;
    },
  } as unknown as MedusaContainer;
  return { container, order };
}

const saved = { ...process.env };
beforeEach(() => {
  process.env.DATABASE_URL ??= "postgres://xshop:xshop@localhost:5432/xshop";
  process.env.CATALOG_REVALIDATE_SECRET = "khoa-revalidate-thu-nghiem-0123456789abcdef";
  process.env.CATALOG_REVALIDATE_URLS = "http://sf.test/api/revalidate";
  resetRevalidateStateForTests();
  mockSources.mockReset();
  mockPrices.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
  resetRevalidateStateForTests();
});

describe("thứ tự: read model trước, outbox revalidate sau", () => {
  it("lượt xả đồng bộ sản phẩm: replaceProducts xong rồi mới ghi outbox từng sản phẩm", async () => {
    const { container, order } = setup();
    await drainCatalogIndex(container);
    expect(order).toEqual(["index:replaceProducts:prod_1,prod_2", "outbox:p", "outbox:p"]);
  });

  it("rebuild toàn phần: replaceAll xong rồi mới ghi outbox `cả catalog`", async () => {
    const { container, order } = setup();
    await rebuildCatalogIndex(container);
    expect(order).toEqual(["index:replaceAll", "outbox:all"]);
  });

  it("rebuild bị huỷ (lệch giá, giữ bảng cũ) vẫn báo `cả catalog` — PDP đọc nguồn trực tiếp", async () => {
    const { container, order } = setup({ missingPrice: true });
    await rebuildCatalogIndex(container);
    expect(order).toEqual(["outbox:all"]);
  });

  it("webhook tắt (không khoá) → không ghi outbox, read model vẫn đồng bộ", async () => {
    delete process.env.CATALOG_REVALIDATE_SECRET;
    delete process.env.CATALOG_REVALIDATE_URLS;
    resetRevalidateStateForTests();
    const { container, order } = setup();
    await drainCatalogIndex(container);
    expect(order).toEqual(["index:replaceProducts:prod_1,prod_2"]);
  });
});
