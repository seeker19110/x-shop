import type { MedusaContainer } from "@medusajs/framework/types";
import { CATALOG_PRODUCTS_CHANGED } from "../constants";
import { targetsForEvent } from "../index-triggers";

/** Payload sự kiện đến từ Event Bus (có thể từ module ngoài) → parse bằng zod, kiểu lạ không làm sập subscriber. */
const container = {} as MedusaContainer;

describe("targetsForEvent: payload sự kiện qua schema (BASE-SEC-001)", () => {
  const productIds = (data: unknown) =>
    targetsForEvent(container, CATALOG_PRODUCTS_CHANGED, data as Record<string, unknown>);

  it("mảng id hợp lệ → giữ nguyên", async () => {
    await expect(productIds({ product_ids: ["p1", "p2"] })).resolves.toEqual({
      rebuild: false,
      productIds: ["p1", "p2"],
    });
  });

  it("một id đơn → mảng một phần tử (product.updated {id})", async () => {
    await expect(targetsForEvent(container, "product.updated", { id: "p1" })).resolves.toEqual({
      rebuild: false,
      productIds: ["p1"],
    });
  });

  it("phần tử sai kiểu / rỗng bị bỏ, không ném", async () => {
    await expect(productIds({ product_ids: ["p1", "", null, 5, { a: 1 }, ["x"], "p2"] })).resolves.toEqual({
      rebuild: false,
      productIds: ["p1", "p2"],
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["chuỗi", "x"],
    ["mảng", ["p1"]],
    ["số", 3],
    ["object rỗng", {}],
  ])("payload %s → không có sản phẩm, không ném", async (_name, data) => {
    await expect(productIds(data)).resolves.toEqual({ rebuild: false, productIds: [] });
  });

  it("sự kiện lạ → rebuild (an toàn, không bỏ sót)", async () => {
    await expect(targetsForEvent(container, "price-list.deleted", "rác" as never)).resolves.toEqual({
      rebuild: true,
    });
  });
});
