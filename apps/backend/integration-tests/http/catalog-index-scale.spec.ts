import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { rebuildCatalogIndex, syncCatalogProducts } from "../../src/lib/catalog/indexer";
import { Migration20261026030000 } from "../../src/modules/checkout/migrations/Migration20261026030000";
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

    // ---- D-040: lệch giá bán (missing > 0) → không thay bảng, mở ngoại lệ ----
    const KIND = "catalog_index_mismatch";
    const BAD_PREFIX = "variant_SCALE00001"; // 5 biến thể của sản phẩm prod_SCALE00001
    const SENTINEL = "SENTINEL-CU";
    const exceptions = async (state?: string): Promise<number> => {
      const res = await db.raw(
        `SELECT count(*)::int AS n FROM ops_exception WHERE kind = ? AND (?::text IS NULL OR state = ?)`,
        [KIND, state ?? null, state ?? null],
      );
      return (res.rows[0] as { n: number }).n;
    };
    const sentinelCount = async (): Promise<number> => count("title = ?", [SENTINEL]);
    const markSentinel = (productLike: string) =>
      db.raw(`UPDATE catalog_variant_index SET title = ? WHERE product_id LIKE ?`, [SENTINEL, productLike]);
    /** Ép lỗi đọc giá: biến thể của một sản phẩm "mất" calculated_price (có giá niêm yết, không ra giá bán). */
    const breakPricing = () => {
      const query = container.resolve(ContainerRegistrationKeys.QUERY);
      const original = query.graph.bind(query);
      return jest.spyOn(query, "graph").mockImplementation((async (...args: Parameters<typeof original>) => {
        const out = await original(...args);
        const fields = (args[0] as { fields?: string[] }).fields ?? [];
        if (!fields.includes("calculated_price.*")) return out;
        return {
          ...out,
          data: (out.data as { id: string }[]).map((r) =>
            r.id.startsWith(BAD_PREFIX) ? { id: r.id, calculated_price: null } : r,
          ),
        };
      }) as typeof original);
    };

    it("rebuild khi missing > 0: giữ nguyên bảng cũ, log lỗi, ngoại lệ mở đúng 1 lần dù gọi 2 lần; hết lỗi thì thay bảng", async () => {
      await rebuildCatalogIndex(container);
      await db.raw(`DELETE FROM ops_exception WHERE kind = ?`, [KIND]);
      await markSentinel("prod_SCALE0000%");
      const before = await count();
      const sentinels = await sentinelCount();
      expect(sentinels).toBeGreaterThan(0);

      const error = jest.spyOn(logger, "error");
      const stub = breakPricing();
      const r1 = await rebuildCatalogIndex(container);
      const r2 = await rebuildCatalogIndex(container);
      stub.mockRestore();

      for (const r of [r1, r2]) {
        expect(r.missing).toBe(SKUS_PER_PRODUCT);
        expect(r.rows).toBe(0);
      }
      expect(await count()).toBe(before);
      expect(await sentinelCount()).toBe(sentinels); // bảng cũ còn nguyên (không bị dựng lại)
      expect(logged(error, "BỊ HỦY")).toBe(true);
      expect(await exceptions()).toBe(1);
      expect(await exceptions("open")).toBe(1);
      const detail = (await db.raw(`SELECT detail, priority FROM ops_exception WHERE kind = ?`, [KIND]))
        .rows[0] as { detail: { op: string; missing: number }; priority: string };
      expect(detail.detail).toMatchObject({ op: "rebuild", missing: SKUS_PER_PRODUCT });
      expect(detail.priority).toBe("high");

      // Bình thường: vẫn thay cả bảng (sentinel biến mất), ngoại lệ cũ không tự đóng, không mở thêm.
      const ok = await rebuildCatalogIndex(container);
      expect(ok.missing).toBe(0);
      expect(await count()).toBe(expectedTotal);
      expect(await sentinelCount()).toBe(0);
      expect(await exceptions()).toBe(1);

      // Xử lý xong (resolved) rồi lỗi tái diễn → mở lại (không bị dedupe vĩnh viễn).
      await db.raw(`UPDATE ops_exception SET state = 'resolved' WHERE kind = ?`, [KIND]);
      const stub2 = breakPricing();
      await rebuildCatalogIndex(container);
      stub2.mockRestore();
      expect(await exceptions()).toBe(2);
      expect(await exceptions("open")).toBe(1);
    });

    it("đồng bộ theo sản phẩm gặp missing: không ghi sản phẩm đó (giữ dòng cũ), sản phẩm khác trong lô vẫn ghi; ngoại lệ không mở trùng", async () => {
      await rebuildCatalogIndex(container);
      await db.raw(`DELETE FROM ops_exception WHERE kind = ?`, [KIND]);
      await markSentinel("prod_SCALE0000%");
      const bad = "prod_SCALE00001";
      const good = "prod_SCALE00002";
      const badBefore = await count("product_id = ?", [bad]);
      expect(badBefore).toBe(SKUS_PER_PRODUCT);

      const stub = breakPricing();
      const written = await syncCatalogProducts(container, [bad, good]);
      await syncCatalogProducts(container, [bad]);
      stub.mockRestore();

      expect(written).toBe(SKUS_PER_PRODUCT); // chỉ sản phẩm tốt được ghi
      expect(await count("product_id = ? AND title = ?", [bad, SENTINEL])).toBe(SKUS_PER_PRODUCT);
      expect(await count("product_id = ?", [bad])).toBe(badBefore);
      expect(await count("product_id = ? AND title = ?", [good, SENTINEL])).toBe(0);
      expect(await count("product_id = ?", [good])).toBe(SKUS_PER_PRODUCT);
      expect(await exceptions("open")).toBe(1);
    });

    it("sync/rebuild với dữ liệu rỗng: không lỗi, không mở ngoại lệ", async () => {
      await db.raw(`DELETE FROM ops_exception WHERE kind = ?`, [KIND]);
      expect(await syncCatalogProducts(container, [])).toBe(0);
      expect(await exceptions()).toBe(0);
    });

    it("migration 20261026030000: down trả CHECK cũ (dòng kind mới → outbox_dead + original_kind), up cho phép lại", async () => {
      const insert = (kind: string, key: string) =>
        db.raw(`INSERT INTO ops_exception (id, kind, dedupe_key) VALUES (?, ?, ?)`, [
          `opx_${key}`,
          kind,
          key,
        ]);
      const failsWithCheck = async (kind: string, key: string): Promise<boolean> => {
        try {
          await insert(kind, key);
          return false;
        } catch (e) {
          return (e as { code?: string }).code === "23514";
        }
      };
      const run = async (direction: "up" | "down") => {
        const m = new Migration20261026030000({} as never, {} as never);
        await m[direction]();
        for (const q of m.getQueries()) await db.raw(String(q));
      };
      await db.raw(`DELETE FROM ops_exception WHERE dedupe_key LIKE 'mig-%'`);
      await insert(KIND, "mig-1");
      await run("down");
      const row = (await db.raw(`SELECT kind, detail FROM ops_exception WHERE dedupe_key = 'mig-1'`))
        .rows[0] as { kind: string; detail: { original_kind: string } };
      expect(row.kind).toBe("outbox_dead");
      expect(row.detail.original_kind).toBe(KIND);
      expect(await failsWithCheck(KIND, "mig-2")).toBe(true);
      await run("up");
      expect(await failsWithCheck(KIND, "mig-3")).toBe(false);
      expect(await failsWithCheck("khong_ton_tai", "mig-4")).toBe(true);
    });
  },
});
