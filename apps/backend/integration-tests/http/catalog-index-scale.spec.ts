import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { rebuildCatalogIndex, syncCatalogProducts } from "../../src/lib/catalog/indexer";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import seedCatalog, { type CatalogSeedResult } from "../../src/scripts/seed-catalog";

jest.setTimeout(300 * 1000);

/**
 * T-057: read model đủ dòng ở catalog lớn. Trước khi sửa, `rebuildCatalogIndex` gom mọi biến thể vào MỘT lời gọi
 * `query.graph` lấy calculated_price; từ 4.000 id Query của Medusa tự chia lô và các lô sau mất giá → chỉ 4.000 dòng,
 * im lặng. Ở đây sinh nhanh bằng SQL hàng loạt > 5.000 biến thể có giá (mỗi sản phẩm 5 SKU, giá VND nguyên, không
 * quản tồn) + một sản phẩm thật sự không có giá.
 */
const PRODUCTS = 1_100;
const SKUS_PER_PRODUCT = 5;
const PRICED_VARIANTS = PRODUCTS * SKUS_PER_PRODUCT; // 5.500 > 5.000
const NO_PRICE_PRODUCT = "prod_SCALE_NOPRICE";
const NO_PRICE_VARIANTS = 3;

/** Sinh dữ liệu trong một giao dịch: sản phẩm published + kênh bán, biến thể, price_set/price (VND, không rule). */
async function generate(db: Knex, salesChannelId: string): Promise<void> {
  await db.transaction(async (trx) => {
    await trx.raw(
      `CREATE TEMP TABLE sp ON COMMIT DROP AS
       SELECT g AS n, 'prod_SCALE' || lpad(g::text, 5, '0') AS id FROM generate_series(1, ?::int) g`,
      [PRODUCTS],
    );
    await trx.raw(
      `CREATE TEMP TABLE sv ON COMMIT DROP AS
       SELECT sp.n, sp.id AS pid, s AS si,
              'variant_SCALE' || lpad(sp.n::text, 5, '0') || s::text AS vid,
              'SCALE' || lpad(sp.n::text, 5, '0') || '-' || s::text AS sku,
              (99 + (sp.n * 37 + s) % 400) * 1000 AS price
         FROM sp CROSS JOIN generate_series(0, ?::int - 1) s`,
      [SKUS_PER_PRODUCT],
    );
    await trx.raw(
      `INSERT INTO product (id, title, handle, status, created_at, updated_at)
       SELECT id, 'Sản phẩm quy mô ' || n, 'sp-scale-' || lpad(n::text, 5, '0'), 'published',
              timestamptz '2026-01-01 00:00:00+00' + n * interval '1 second',
              timestamptz '2026-01-01 00:00:00+00' + n * interval '1 second'
         FROM sp
       UNION ALL SELECT ?, 'Sản phẩm chưa có giá', 'sp-scale-khong-gia', 'published', now(), now()`,
      [NO_PRICE_PRODUCT],
    );
    await trx.raw(
      `INSERT INTO product_sales_channel (id, product_id, sales_channel_id)
       SELECT 'prodsc_' || substr(id, 6), id, ? FROM (SELECT id FROM sp UNION ALL SELECT ?) p`,
      [salesChannelId, NO_PRICE_PRODUCT],
    );
    await trx.raw(
      `INSERT INTO product_variant (id, title, sku, allow_backorder, manage_inventory, variant_rank, product_id)
       SELECT vid, 'Biến thể ' || si, sku, false, false, si, pid FROM sv
       UNION ALL
       SELECT 'variant_SCALE_NOPRICE' || g, 'Không giá ' || g, 'SCALE-NOPRICE-' || g, false, false, g, ?
         FROM generate_series(1, ?::int) g`,
      [NO_PRICE_PRODUCT, NO_PRICE_VARIANTS],
    );
    await trx.raw(`INSERT INTO price_set (id) SELECT 'pset_' || substr(vid, 9) FROM sv`);
    await trx.raw(
      `INSERT INTO price (id, price_set_id, currency_code, raw_amount, rules_count, amount)
       SELECT 'price_' || substr(vid, 9), 'pset_' || substr(vid, 9), 'vnd',
              jsonb_build_object('value', price::text, 'precision', 20), 0, price FROM sv`,
    );
    await trx.raw(
      `INSERT INTO product_variant_price_set (id, variant_id, price_set_id)
       SELECT 'pvps_' || substr(vid, 9), vid, 'pset_' || substr(vid, 9) FROM sv`,
    );
  });
  await db.raw("ANALYZE");
}

/**
 * Oracle độc lập với code index (SQL thẳng trên bảng nguồn): dòng bán được = biến thể có SKU của sản phẩm published
 * × kênh bán, có giá VND niêm yết (không rule, không price list).
 */
async function sellableRows(db: Knex): Promise<number> {
  const res = await db.raw(
    `SELECT count(*)::int AS n
       FROM product_variant v
       JOIN product p ON p.id = v.product_id AND p.status = 'published' AND p.deleted_at IS NULL
       JOIN product_sales_channel psc ON psc.product_id = p.id AND psc.deleted_at IS NULL
      WHERE v.deleted_at IS NULL AND coalesce(v.sku, '') <> ''
        AND EXISTS (
          SELECT 1 FROM product_variant_price_set l
            JOIN price pr ON pr.price_set_id = l.price_set_id AND pr.deleted_at IS NULL AND pr.currency_code = 'vnd'
                         AND pr.price_list_id IS NULL AND pr.rules_count = 0
           WHERE l.variant_id = v.id AND l.deleted_at IS NULL)`,
  );
  return (res.rows[0] as { n: number }).n;
}

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    let container: MedusaContainer;
    let seed: CatalogSeedResult;
    let db: Knex;
    let logger: Logger;
    let expectedTotal: number;

    const index = (): CatalogIndexModuleService => container.resolve(CATALOG_INDEX_MODULE);
    const count = async (where = "true", bindings: unknown[] = []): Promise<number> => {
      const res = await db.raw(
        `SELECT count(*)::int AS n FROM catalog_variant_index WHERE ${where}`,
        bindings as Knex.ValueDict[],
      );
      return (res.rows[0] as { n: number }).n;
    };
    const scaleRows = () => count("product_id LIKE 'prod_SCALE%'");
    const distinctKeys = async () => {
      const res = await db.raw(
        `SELECT count(DISTINCT (variant_id, sales_channel_id))::int AS n FROM catalog_variant_index`,
      );
      return (res.rows[0] as { n: number }).n;
    };
    const generatedIds = async (): Promise<string[]> =>
      (await db.raw(`SELECT id FROM product WHERE id LIKE 'prod_SCALE%' ORDER BY id`)).rows.map(
        (r: { id: string }) => r.id,
      );
    const logged = (spy: jest.SpyInstance, needle: string) =>
      spy.mock.calls.some((args: unknown[]) => String(args[0]).includes(needle));

    beforeAll(async () => {
      container = getContainer();
      seed = await seedCatalog({ container });
      db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
      logger = container.resolve(ContainerRegistrationKeys.LOGGER);
      await generate(db, seed.base.salesChannelId);
      expectedTotal = await sellableRows(db);
    });

    afterEach(() => jest.restoreAllMocks());

    it("oracle: dữ liệu sinh đủ > 5.000 biến thể có giá", async () => {
      expect(PRICED_VARIANTS).toBeGreaterThan(5_000);
      expect(expectedTotal).toBeGreaterThanOrEqual(PRICED_VARIANTS);
    });

    it("rebuild toàn phần: số dòng = số biến thể bán được; sản phẩm thiếu giá bị loại có log, không kéo theo ai", async () => {
      const warn = jest.spyOn(logger, "warn");
      const error = jest.spyOn(logger, "error");
      const result = await rebuildCatalogIndex(container);

      expect(await scaleRows()).toBe(PRICED_VARIANTS);
      expect(await count()).toBe(expectedTotal);
      expect(await distinctKeys()).toBe(expectedTotal);
      expect(result.rows).toBe(expectedTotal);
      expect(result.missing).toBe(0);
      expect(result.expected).toBe(expectedTotal);
      expect(result.unpriced).toBeGreaterThanOrEqual(NO_PRICE_VARIANTS);

      // Sản phẩm thật sự không có giá: không dòng nào, có cảnh báo nêu SKU; không có lỗi lệch.
      expect(await count("product_id = ?", [NO_PRICE_PRODUCT])).toBe(0);
      expect(logged(warn, "variant_SCALE_NOPRICE1")).toBe(true);
      expect(logged(error, "LỆCH")).toBe(false);
      // Mọi sản phẩm sinh có giá đều có đủ 5 dòng.
      const perProduct = await db.raw(
        `SELECT count(*)::int AS n FROM (
           SELECT product_id FROM catalog_variant_index WHERE product_id LIKE 'prod_SCALE0%'
            GROUP BY product_id HAVING count(*) = ?) t`,
        [SKUS_PER_PRODUCT],
      );
      expect((perProduct.rows[0] as { n: number }).n).toBe(PRODUCTS);
    });

    it("đồng bộ theo lô lớn (mọi sản phẩm sinh một lần gọi) cũng đủ dòng", async () => {
      await db.raw(`DELETE FROM catalog_variant_index WHERE product_id LIKE 'prod_SCALE%'`);
      const error = jest.spyOn(logger, "error");
      const ids = await generatedIds();
      expect(ids).toHaveLength(PRODUCTS + 1);

      const written = await syncCatalogProducts(container, ids);

      expect(written).toBe(PRICED_VARIANTS);
      expect(await scaleRows()).toBe(PRICED_VARIANTS);
      expect(await count("product_id = ?", [NO_PRICE_PRODUCT])).toBe(0);
      expect(logged(error, "LỆCH")).toBe(false);
    });

    it("rebuild đồng thời với đồng bộ lô lớn: đủ dòng, không trùng", async () => {
      const ids = await generatedIds();
      await Promise.all([
        rebuildCatalogIndex(container),
        syncCatalogProducts(container, ids.slice(0, 600)),
        syncCatalogProducts(container, ids.slice(500)),
      ]);
      expect(await count()).toBe(expectedTotal);
      expect(await distinctKeys()).toBe(expectedTotal);
      expect(await scaleRows()).toBe(PRICED_VARIANTS);
    });

    it("kiểm cuối báo lỗi có số liệu khi bảng lệch số dòng vừa ghi (không im lặng)", async () => {
      // Mô phỏng ghi hụt: bảng sẽ có ít dòng hơn số đã dựng → reportBuild phải log ERROR kèm số liệu.
      const svc = index();
      const original = svc.countRows.bind(svc);
      jest.spyOn(svc, "countRows").mockImplementation(async (ids?: string[]) => (await original(ids)) - 1);
      const error = jest.spyOn(logger, "error");
      await syncCatalogProducts(container, (await generatedIds()).slice(0, 10));
      const msg = error.mock.calls.map((a: unknown[]) => String(a[0])).find((m) => m.includes("LỆCH"));
      expect(msg).toBeDefined();
      expect(msg).toContain("dựng 50");
      expect(msg).toContain("trong bảng 49");
    });
  },
});
