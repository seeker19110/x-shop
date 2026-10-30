import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { updateProductsWorkflow } from "@medusajs/medusa/core-flows";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { isNonEmpty } from "@x-shop/domain";
import { rebuildCatalogIndex } from "../../src/lib/catalog/indexer";
import { DEMO_CATEGORIES, DEMO_PRODUCTS } from "../../src/scripts/catalog-demo-data";
import seedCatalog, { type CatalogSeedResult } from "../../src/scripts/seed-catalog";
import { storeHeaders } from "../helpers/auth";

jest.setTimeout(300 * 1000);

type Cat = { handle: string; name: string; parent_handle: string | null; product_count: number };
type Res = { status: number; data: { categories: Cat[] }; headers: Record<string, string> };

/** Oracle độc lập: đếm sản phẩm demo theo danh mục (gồm tổ tiên), bỏ những sản phẩm không published. */
function expectedCounts(published: (handle: string) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of DEMO_PRODUCTS) {
    if (!published(p.handle)) continue;
    let h: string | null = p.category;
    while (isNonEmpty(h)) {
      out.set(h, (out.get(h) ?? 0) + 1);
      const cur: string = h;
      h = DEMO_CATEGORIES.find((c) => c.handle === cur)?.parent ?? null;
    }
  }
  return out;
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let container: MedusaContainer;
    let seed: CatalogSeedResult;
    let headers: Record<string, string>;
    const categories = async () =>
      ((await api.get("/store/x/categories", { headers })) as Res).data.categories;

    beforeAll(async () => {
      container = getContainer();
      seed = await seedCatalog({ container });
      headers = await storeHeaders(container);
    });

    it("chỉ danh mục có sản phẩm published, kèm đếm gồm danh mục con, cha ghi rõ", async () => {
      const res = (await api.get("/store/x/categories", { headers })) as Res;
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, s-maxage=60, stale-while-revalidate=300");
      const want = expectedCounts(() => true);
      const got = new Map(res.data.categories.map((c) => [c.handle, c]));
      expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
      for (const [handle, n] of want) {
        const c = got.get(handle) as Cat;
        const demo = DEMO_CATEGORIES.find((d) => d.handle === handle);
        expect(c.product_count).toBe(n);
        expect(c.parent_handle).toBe(demo?.parent ?? null);
        expect(c.name).toBe(demo?.name);
      }
      for (const c of DEMO_CATEGORIES.filter((d) => !want.has(d.handle)))
        expect(got.has(c.handle)).toBe(false);
    });

    it("danh mục nội bộ/không hoạt động không lộ ra", async () => {
      const product = container.resolve(Modules.PRODUCT);
      const [ao] = await product.listProductCategories({ handle: "ao-nu" });
      await product.updateProductCategories(ao!.id, { is_active: false });
      try {
        expect((await categories()).map((c) => c.handle)).not.toContain("ao-nu");
      } finally {
        await product.updateProductCategories(ao!.id, { is_active: true });
      }
    });

    it("ẩn sản phẩm về draft → đếm giảm; hết sản phẩm → danh mục biến mất", async () => {
      const victims = DEMO_PRODUCTS.filter((p) => p.category === "quan-nam");
      expect(victims.length).toBeGreaterThan(0);
      await updateProductsWorkflow(container).run({
        input: {
          selector: { id: victims.map((v) => seed.products[v.handle] as string) },
          update: { status: "draft" },
        },
      });
      await rebuildCatalogIndex(container);
      const want = expectedCounts((h) => !victims.some((v) => v.handle === h));
      const got = new Map((await categories()).map((c) => [c.handle, c.product_count]));
      expect(got.has("quan-nam")).toBe(false);
      expect(got.get("nam")).toBe(want.get("nam"));
    });

    it("thiếu publishable key → bị từ chối", async () => {
      await expect(api.get("/store/x/categories")).rejects.toMatchObject({
        response: { status: expect.any(Number) },
      });
    });
  },
});
