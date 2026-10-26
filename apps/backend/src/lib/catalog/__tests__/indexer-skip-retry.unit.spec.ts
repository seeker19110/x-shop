import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { CATALOG_INDEX_MODULE } from "../../../modules/catalog-index";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { DirtyClaim } from "../../../modules/catalog-index/service";
import { drainCatalogIndex, SKIP_MAX_ATTEMPTS, SKIP_RETRY_DELAYS_SECONDS } from "../indexer";
import type { ProductSource } from "../product-source";

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

const claim = (id: string, attempts = 0): DirtyClaim => ({
  product_id: id,
  marked_at: "2026-10-26 00:00:00.000001+00",
  attempts,
});

/** Container giả: một lô dấu duy nhất, SKU của các sản phẩm trong `bad` không ra giá bán (lệch giá). */
function setup(claims: DirtyClaim[], bad: string[]) {
  let served = false;
  const index = {
    claimDirty: jest.fn(async () => {
      if (served) return [];
      served = true;
      return claims;
    }),
    clearDirty: jest.fn(async () => undefined),
    deferDirty: jest.fn(async () => undefined),
    dirtyCount: jest.fn(async () => 0),
    replaceProducts: jest.fn(async () => undefined),
    countRows: jest.fn(async (ids?: string[]) => (ids ?? []).length),
  };
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const openOps = jest.fn(async () => undefined);
  mockSources.mockImplementation(async (_c: unknown, q: { id: string[] }) => q.id.map(product));
  mockPrices.mockImplementation(async (_c: unknown, variantIds: string[]) => {
    const out = new Map<string, unknown>();
    for (const v of variantIds)
      if (!bad.some((b) => v.startsWith(`${b}_`)))
        out.set(v, { price: 100_000, compareAt: null, validUntil: null });
    return out;
  });
  const container = {
    resolve: (key: string) => {
      if (key === Modules.LOCKING) return { acquire: async () => undefined, release: async () => true };
      if (key === CATALOG_INDEX_MODULE) return index;
      if (key === CHECKOUT_MODULE) return { openOpsExceptionIfNoneActive: openOps };
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      return null;
    },
  } as unknown as MedusaContainer;
  return { container, index, logger, openOps };
}

const cleared = (index: { clearDirty: jest.Mock }): string[] =>
  (index.clearDirty.mock.calls as unknown as [DirtyClaim[]][]).flatMap(([cs]) => cs.map((c) => c.product_id));
const deferred = (index: { deferDirty: jest.Mock }) =>
  (index.deferDirty.mock.calls as unknown as [Record<string, unknown>[]][]).flatMap(([ds]) => ds);

describe("drainCatalogIndex — sản phẩm bị bỏ qua vì lệch giá (T-061)", () => {
  beforeEach(() => {
    mockSources.mockReset();
    mockPrices.mockReset();
  });

  it("backoff đúng 1 → 5 → 15 → 15 phút, hết lượt thì có đúng SKIP_MAX_ATTEMPTS", () => {
    expect([...SKIP_RETRY_DELAYS_SECONDS]).toEqual([60, 300, 900, 900]);
    expect(SKIP_MAX_ATTEMPTS).toBe(5);
  });

  it("sản phẩm bị bỏ qua giữ dấu (hẹn lại, attempts+1, 60 giây); sản phẩm tốt cùng lô được xoá dấu", async () => {
    const { container, index, openOps } = setup([claim("prod_bad"), claim("prod_ok")], ["prod_bad"]);
    await expect(drainCatalogIndex(container)).resolves.toBe(2);

    expect(cleared(index)).toEqual(["prod_ok"]);
    expect(deferred(index)).toEqual([
      { product_id: "prod_bad", marked_at: "2026-10-26 00:00:00.000001+00", attempts: 1, delay_seconds: 60 },
    ]);
    // Dòng của sản phẩm tốt vẫn ghi ngay; sản phẩm lỗi không bị ghi; ngoại lệ mở.
    expect(index.replaceProducts).toHaveBeenCalledWith(["prod_ok"], expect.any(Array));
    expect(openOps).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1, 300],
    [2, 900],
    [3, 900],
  ])("đã thất bại %i lần → lần này hẹn lùi %i giây", async (attempts, delay) => {
    const { container, index } = setup([claim("prod_bad", attempts)], ["prod_bad"]);
    await drainCatalogIndex(container);
    expect(cleared(index)).toEqual([]);
    expect(deferred(index)).toMatchObject([
      { product_id: "prod_bad", attempts: attempts + 1, delay_seconds: delay },
    ]);
  });

  it("hết N lần: xoá dấu, log ERROR rõ, không hẹn lại", async () => {
    const { container, index, logger } = setup([claim("prod_bad", SKIP_MAX_ATTEMPTS - 1)], ["prod_bad"]);
    await drainCatalogIndex(container);
    expect(cleared(index)).toEqual(["prod_bad"]);
    expect(index.deferDirty).toHaveBeenCalledWith([]);
    const msg = logger.error.mock.calls
      .map((a: unknown[]) => String(a[0]))
      .find((m) => m.includes("Bỏ thử lại"));
    expect(msg).toContain("prod_bad");
    expect(msg).toContain("catalog_index_mismatch");
  });

  it("không sản phẩm nào bị bỏ qua: xoá hết dấu, không hẹn lại (hành vi cũ)", async () => {
    const { container, index } = setup([claim("prod_a"), claim("prod_b")], []);
    await drainCatalogIndex(container);
    expect(cleared(index).sort()).toEqual(["prod_a", "prod_b"]);
    expect(deferred(index)).toEqual([]);
  });

  it("vòng ngoài chỉ đếm dấu đến hạn (dấu đang chờ backoff không làm xả lặp nóng)", async () => {
    const { container, index } = setup([claim("prod_bad")], ["prod_bad"]);
    await drainCatalogIndex(container);
    expect(index.dirtyCount).toHaveBeenCalledWith(true);
    expect(index.claimDirty).toHaveBeenCalledTimes(2); // một lô + một lần rỗng, không lấy lại dấu vừa hẹn
  });
});
