import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { QUERY_ID_BATCH } from "../constants";
import type { SourceVariant } from "../product-source";
import { chunked, loadInStock, loadVariantPrices } from "../sell-state";

/** Ngưỡng tự chia lô của Query ở Medusa 2.22.1 (ModuleDataFetcher.MAX_BATCH_SIZE). */
const MEDUSA_AUTO_BATCH = 4_000;

/**
 * Query giả mô phỏng đúng lỗi của Medusa 2.22.1 (T-057): lời gọi có ≥ 4.000 id bị chia lô dùng chung `options`, Pricing
 * xoá `calculated_price` ở lô đầu → chỉ 4.000 biến thể đầu có giá, phần còn lại trả về KHÔNG có giá.
 */
function fakeContainer() {
  const calls: { entity: string; size: number }[] = [];
  const graph = jest.fn(async (q: { entity: string; filters: Record<string, string[]> }) => {
    const ids = q.filters.id ?? q.filters.variant_id ?? [];
    calls.push({ entity: q.entity, size: ids.length });
    if (q.entity === "product_variant") {
      return {
        data: ids.map((id, i) => ({
          id,
          calculated_price:
            ids.length >= MEDUSA_AUTO_BATCH && i >= MEDUSA_AUTO_BATCH
              ? null
              : {
                  calculated_amount: 100_000,
                  original_amount: 100_000,
                  currency_code: "vnd",
                },
        })),
      };
    }
    if (q.entity === "product_variant_inventory_items") {
      // Mỗi biến thể một inventory item, tồn 1 ở kho của kênh.
      return {
        data: ids.map((variant_id) => ({
          variant_id,
          required_quantity: 1,
          inventory: {
            location_levels: [{ location_id: "sloc_1", available_quantity: 1 }],
          },
        })),
      };
    }
    if (q.entity === "sales_channel_locations") return { data: [{ stock_location_id: "sloc_1" }] };
    return { data: [] };
  });
  const listPriceLists = jest.fn(async () => []);
  const container = {
    resolve: (key: string) =>
      key === ContainerRegistrationKeys.QUERY
        ? { graph }
        : key === Modules.PRICING
          ? { listPriceLists }
          : null,
  } as unknown as MedusaContainer;
  return { container, calls, graph };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `variant_${String(i).padStart(5, "0")}`);
const ctx = { regionId: "reg_1", currencyCode: "vnd" };

describe("chunked", () => {
  it("rỗng → không lô; chia đúng biên; lô cuối ngắn hơn", () => {
    expect(chunked([], 3)).toEqual([]);
    expect(chunked([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
    expect(chunked([1, 2, 3, 4], 3)).toEqual([[1, 2, 3], [4]]);
  });
  it("kích thước lô không hợp lệ → ném lỗi (không lặp vô hạn)", () => {
    expect(() => chunked([1], 0)).toThrow();
    expect(() => chunked([1], 1.5)).toThrow();
    expect(() => chunked([1], Number.NaN)).toThrow();
  });
  it("QUERY_ID_BATCH dưới ngưỡng tự chia lô của Query", () => {
    expect(QUERY_ID_BATCH).toBeLessThan(MEDUSA_AUTO_BATCH);
  });
});

describe("loadVariantPrices — theo lô cố định (T-057)", () => {
  it("9.000 biến thể: đủ giá cho mọi biến thể, mỗi lời gọi ≤ QUERY_ID_BATCH id", async () => {
    const { container, calls } = fakeContainer();
    const all = ids(9_000);
    const prices = await loadVariantPrices(container, all, ctx);
    expect(prices.size).toBe(9_000);
    expect(all.every((id) => prices.get(id)?.price === 100_000)).toBe(true);
    expect(calls.length).toBe(Math.ceil(9_000 / QUERY_ID_BATCH));
    expect(Math.max(...calls.map((c) => c.size))).toBeLessThanOrEqual(QUERY_ID_BATCH);
  });

  it("id trùng gộp lại; danh sách rỗng không gọi Query", async () => {
    const { container, calls } = fakeContainer();
    expect((await loadVariantPrices(container, [], ctx)).size).toBe(0);
    expect(calls).toHaveLength(0);
    const prices = await loadVariantPrices(container, ["a", "a", "b"], ctx);
    expect(prices.size).toBe(2);
    expect(calls).toEqual([{ entity: "product_variant", size: 2 }]);
  });
});

describe("loadInStock — theo lô cố định", () => {
  const variant = (id: string, managed = true): SourceVariant => ({
    id,
    sku: id,
    rank: 0,
    color: null,
    size: null,
    manageInventory: managed,
    allowBackorder: false,
    basePrice: 100_000,
  });

  it("5.000 biến thể quản tồn + 1 không quản: đủ kết quả, mỗi truy vấn tồn ≤ QUERY_ID_BATCH id", async () => {
    const { container, calls } = fakeContainer();
    const vs = [...ids(5_000).map((id) => variant(id)), variant("unmanaged", false)];
    const stock = await loadInStock(container, vs, "sc_1");
    expect(stock.size).toBe(5_001);
    expect([...stock.values()].every(Boolean)).toBe(true);
    const inv = calls.filter((c) => c.entity === "product_variant_inventory_items");
    expect(inv.length).toBe(Math.ceil(5_000 / QUERY_ID_BATCH));
    expect(Math.max(...inv.map((c) => c.size))).toBeLessThanOrEqual(QUERY_ID_BATCH);
  });

  it("không biến thể quản tồn → không gọi Query", async () => {
    const { container, calls } = fakeContainer();
    const stock = await loadInStock(container, [variant("x", false)], "sc_1");
    expect(stock.get("x")).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
