import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import {
  CATALOG_INDEX_LOCK,
  drainCatalogIndex,
  rebuildCatalogIndex,
  syncCatalogProducts,
} from "../../src/lib/catalog/indexer";
import { Migration20261026120000 } from "../../src/modules/catalog-index/migrations/Migration20261026120000";
import { Migration20261026030000 } from "../../src/modules/checkout/migrations/Migration20261026030000";
import { CATALOG_INDEX_MODULE } from "../../src/modules/catalog-index";
import type CatalogIndexModuleService from "../../src/modules/catalog-index/service";
import type { CatalogIndexRow } from "../../src/modules/catalog-index/service";
import seedCatalog, { type CatalogSeedResult } from "../../src/scripts/seed-catalog";
import { pauseAfterPriceRead } from "../helpers/catalog-rebuild";

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

    it("T-140: rebuild ghi theo lô cố định — mỗi INSERT ≤ 500 dòng, số INSERT = ⌈dòng/500⌉ (chi phí mỗi câu không lớn theo catalog, xa statement_timeout)", async () => {
      // Đo 50k SKU (docs/db/connections.md §5): câu dài nhất 60–71 ms (DELETE cả bảng), INSERT ≤ 45 ms/lô. Hàng rào:
      // gộp ghi thành một câu cho cả catalog (chi phí tăng theo số SKU) sẽ làm đỏ ở đây trước khi chạm 30 s production.
      const CHUNK_ROWS = 500;
      const COLUMNS = 25;
      const inserts: number[] = [];
      const onQuery = (q: { sql?: string; bindings?: unknown[] }) => {
        if (/^insert into "catalog_variant_index"/i.test(q.sql ?? ""))
          inserts.push((q.bindings ?? []).length);
      };
      db.on("query", onQuery);
      try {
        const result = await rebuildCatalogIndex(container);
        expect(result.rows).toBe(expectedTotal);
      } finally {
        db.removeListener("query", onQuery);
      }
      expect(inserts).toHaveLength(Math.ceil(expectedTotal / CHUNK_ROWS));
      expect(Math.max(...inserts)).toBe(CHUNK_ROWS * COLUMNS);
      expect(inserts.reduce((a, b) => a + b, 0)).toBe(expectedTotal * COLUMNS);
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

    // ---- T-167 (D-076): rebuild dựng dòng NGOÀI khoá ghi, chỉ giữ khoá lúc replaceAll ----
    const pricesOf = async (variantId: string): Promise<number[]> =>
      (
        await db.raw(
          `SELECT price FROM catalog_variant_index WHERE variant_id = ? ORDER BY sales_channel_id`,
          [variantId],
        )
      ).rows.map((r: { price: string | number }) => Number(r.price));
    /** Đổi giá niêm yết ở NGUỒN (bảng price của biến thể sinh ở `generate`) — không phát sự kiện. */
    const setSourcePrice = (variantId: string, amount: number) =>
      db.raw(
        `UPDATE price SET amount = ?, raw_amount = jsonb_build_object('value', ?::text, 'precision', 20)
          WHERE price_set_id = ?`,
        [amount, amount, `pset_${variantId.slice("variant_".length)}`],
      );
    const isDirty = async (productId: string): Promise<boolean> =>
      (await db.raw(`SELECT 1 FROM catalog_index_dirty WHERE product_id = ?`, [productId])).rows.length > 0;
    /** Biến thể đầu (si = 0) của sản phẩm sinh ở `generate`. */
    const firstVariant = (pid: string) => `variant_SCALE${pid.slice("prod_SCALE".length)}0`;
    /**
     * Xả tới khi không còn dấu đến hạn (gồm lượt xả rebuild hẹn cho sản phẩm giữ bản đồng bộ) — ca sau không gặp khoá
     * ghi bận vì lượt xả nền của ca trước.
     */
    const settle = async () => {
      for (let i = 0; i < 20 && (await index().dirtyCount(true)) > 0; i++)
        await drainCatalogIndex(container, { waitMs: 5_000 });
      expect(await index().dirtyCount(true)).toBe(0);
      await new Promise((r) => setTimeout(r, 300));
    };
    /** Mốc sạch: bảng đúng nguồn và hàng đợi rỗng (dấu còn sót của ca trước đã được rebuild này phủ). */
    const baseline = async () => {
      await rebuildCatalogIndex(container);
      await settle();
      await db.raw(`DELETE FROM catalog_index_dirty`);
    };
    /**
     * Chạy rebuild, dừng nó ngay sau khi đọc xong GIÁ của lô chứa `variantId` (ảnh chụp sản phẩm + giá CŨ đã nằm trong
     * tay rebuild), chạy `during` trong lúc dừng rồi cho rebuild chạy tiếp tới hết. `atReplace` đọc trạng thái NGAY sau
     * `replaceAll` (còn giữ khoá ghi — lượt xả hẹn sau rebuild chưa thể chen vào): bằng chứng ảnh chụp có ghi đè hay không.
     */
    const rebuildPausedAt = async <T>(
      variantId: string,
      during: () => Promise<void>,
      atReplace: () => Promise<T>,
    ) => {
      const svc = index();
      const replace = svc.replaceAll.bind(svc);
      const seen: { value?: T } = {};
      const spy = jest.spyOn(svc, "replaceAll").mockImplementation(async (rows, since) => {
        const r = await replace(rows, since);
        seen.value = await atReplace();
        return r;
      });
      const gate = pauseAfterPriceRead(container, variantId);
      const run = rebuildCatalogIndex(container);
      try {
        await gate.reached;
        await during();
      } finally {
        gate.restore();
      }
      const result = await run.finally(() => spy.mockRestore());
      return { result, atReplace: seen.value };
    };

    it("T-167: sửa giá trong lúc rebuild đang đọc nguồn → lượt xả ghi ngay (khoá ghi không bị rebuild giữ), rebuild không ghi đè bằng ảnh chụp cũ", async () => {
      await baseline();
      const pid = "prod_SCALE00010";
      const vid = firstVariant(pid);
      const [before] = await pricesOf(vid);
      const NEW = before! + 7_000;

      const { result, atReplace } = await rebuildPausedAt(
        vid,
        async () => {
          await setSourcePrice(vid, NEW);
          await index().markDirty([pid]);
          // Trước T-167 rebuild giữ khoá suốt lúc đọc → lượt xả hết hạn chờ, giá cũ tới hết rebuild (~1 phút ở 50k).
          await drainCatalogIndex(container, { waitMs: 5_000 });
          expect(await pricesOf(vid)).toEqual([NEW]);
        },
        async () => ({ price: await pricesOf(vid), dirty: await isDirty(pid) }),
      );

      expect(result.superseded).toBe(false);
      expect(result.kept).toBe(1);
      // Ảnh chụp (giá CŨ đã đọc) không ghi đè bản đồng bộ; sản phẩm giữ lại được đánh dấu bẩn lại (review 🔴1).
      expect(atReplace).toEqual({ price: [NEW], dirty: true });
      expect(result.rows).toBe(expectedTotal);
      await settle();
      expect(await pricesOf(vid)).toEqual([NEW]);
      expect(await isDirty(pid)).toBe(false);
      expect(await count()).toBe(expectedTotal);
      expect(await distinctKeys()).toBe(expectedTotal);

      await setSourcePrice(vid, before!);
      await syncCatalogProducts(container, [pid]);
      expect(await pricesOf(vid)).toEqual([before]);
    });

    it("T-167: ẩn sản phẩm (draft) trong lúc rebuild đọc nguồn → không còn dòng sau rebuild", async () => {
      await baseline();
      const pid = "prod_SCALE00011";
      expect(await count("product_id = ?", [pid])).toBe(SKUS_PER_PRODUCT);

      const { result, atReplace } = await rebuildPausedAt(
        firstVariant(pid),
        async () => {
          await db.raw(`UPDATE product SET status = 'draft' WHERE id = ?`, [pid]);
          await index().markDirty([pid]);
          await drainCatalogIndex(container, { waitMs: 5_000 });
          expect(await count("product_id = ?", [pid])).toBe(0);
        },
        () => count("product_id = ?", [pid]),
      );

      expect(result.kept).toBe(1);
      expect(atReplace).toBe(0);
      await settle();
      expect(await count("product_id = ?", [pid])).toBe(0);
      expect(await count()).toBe(expectedTotal - SKUS_PER_PRODUCT);

      await db.raw(`UPDATE product SET status = 'published' WHERE id = ?`, [pid]);
      await syncCatalogProducts(container, [pid]);
      expect(await count()).toBe(expectedTotal);
    });

    it("T-167: xoá sản phẩm trong lúc rebuild đọc nguồn → không dòng ma sau rebuild", async () => {
      await baseline();
      const pid = "prod_SCALE00012";
      expect(await count("product_id = ?", [pid])).toBe(SKUS_PER_PRODUCT);

      const { result, atReplace } = await rebuildPausedAt(
        firstVariant(pid),
        async () => {
          await db.raw(`UPDATE product SET deleted_at = now() WHERE id = ?`, [pid]);
          await index().markDirty([pid]);
          await drainCatalogIndex(container, { waitMs: 5_000 });
          expect(await count("product_id = ?", [pid])).toBe(0);
        },
        () => count("product_id = ?", [pid]),
      );

      expect(result.kept).toBe(1);
      expect(atReplace).toBe(0);
      await settle();
      expect(await count("product_id = ?", [pid])).toBe(0);
      expect(await count()).toBe(expectedTotal - SKUS_PER_PRODUCT);
      expect(await distinctKeys()).toBe(expectedTotal - SKUS_PER_PRODUCT);

      await db.raw(`UPDATE product SET deleted_at = NULL WHERE id = ?`, [pid]);
      await syncCatalogProducts(container, [pid]);
      expect(await count()).toBe(expectedTotal);
    });

    it("T-167: thay đổi chưa kịp xả trước replaceAll → dấu bẩn còn nguyên sau rebuild, lượt xả kế tiếp ghi bản mới", async () => {
      await baseline();
      const pid = "prod_SCALE00013";
      const vid = firstVariant(pid);
      const [before] = await pricesOf(vid);
      const NEW = before! + 9_000;

      const { result, atReplace } = await rebuildPausedAt(
        vid,
        async () => {
          await setSourcePrice(vid, NEW);
          await index().markDirty([pid]);
        },
        async () => ({ price: await pricesOf(vid), dirty: await isDirty(pid) }),
      );

      expect(result.kept).toBe(0);
      // Ảnh chụp đã cầm giá cũ (móc dừng SAU khi đọc giá); dấu đặt sau mốc bắt đầu không bị rebuild nuốt.
      expect(atReplace).toEqual({ price: [before], dirty: true });
      expect(await drainCatalogIndex(container, { waitMs: 5_000 })).toBe(1);
      expect(await pricesOf(vid)).toEqual([NEW]);
      expect(await isDirty(pid)).toBe(false);

      await setSourcePrice(vid, before!);
      await syncCatalogProducts(container, [pid]);
    });

    it("T-167 (review 🔴1): đồng bộ đọc nguồn TRƯỚC mốc rebuild nhưng ghi SAU mốc → thay đổi không phát sự kiện trước mốc không bị mất", async () => {
      await baseline();
      const svc = index();
      const pid = "prod_SCALE00900";
      const vid = firstVariant(pid);
      const [before] = await pricesOf(vid);
      const NEW = before! + 11_000;
      let reachedWrite!: () => void;
      const writeReached = new Promise<void>((r) => (reachedWrite = r));
      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((r) => (releaseWrite = r));
      const replaceProducts = svc.replaceProducts.bind(svc);
      jest.spyOn(svc, "replaceProducts").mockImplementation(async (ids, rows) => {
        if (ids.includes(pid)) {
          reachedWrite();
          await writeGate;
        }
        return replaceProducts(ids, rows);
      });
      let sinceTaken!: (s: string) => void;
      const sinceP = new Promise<string>((r) => (sinceTaken = r));
      const clock = svc.clockNow.bind(svc);
      jest.spyOn(svc, "clockNow").mockImplementation(async () => {
        const s = await clock();
        sinceTaken(s);
        return s;
      });
      const replace = svc.replaceAll.bind(svc);
      let atReplace: { price: number[]; dirty: boolean } | undefined;
      jest.spyOn(svc, "replaceAll").mockImplementation(async (rows, since) => {
        const r = await replace(rows, since);
        atReplace = { price: await pricesOf(vid), dirty: await isDirty(pid) };
        return r;
      });
      try {
        // 1) Lượt đồng bộ pid đã ĐỌC nguồn (giá cũ), dừng ngay trước replaceProducts (đang giữ khoá ghi).
        await svc.markDirty([pid]);
        const drain = drainCatalogIndex(container);
        await writeReached;
        // 2) Thay đổi KHÔNG phát sự kiện (price list tới giờ, bảng màu/size, link kho↔kênh): nguồn đổi, không dấu.
        await setSourcePrice(vid, NEW);
        const changedAt = (await db.raw(`SELECT clock_timestamp()::text AS t`)).rows[0].t as string;
        // 3) Rebuild định kỳ (job */30) bắt đầu SAU thay đổi.
        const run = rebuildCatalogIndex(container);
        const since = await sinceP;
        expect(
          (await db.raw(`SELECT ?::timestamptz < ?::timestamptz AS ok`, [changedAt, since])).rows[0].ok,
        ).toBe(true);
        // 4) Lượt đồng bộ ghi (mốc ≥ since) bằng dữ liệu đọc TRƯỚC thay đổi, rồi xoá dấu.
        releaseWrite();
        expect(await drain).toBe(1);
        const result = await run;
        expect(result.kept).toBe(1);
        // Bản giữ lại (cũ) được đánh dấu bẩn lại cùng giao dịch replaceAll → lượt xả đọc nguồn mới nhất.
        expect(atReplace).toEqual({ price: [before], dirty: true });
        await settle();
        expect(await pricesOf(vid)).toEqual([NEW]);
      } finally {
        releaseWrite();
        jest.restoreAllMocks();
        await setSourcePrice(vid, before!);
        await syncCatalogProducts(container, [pid]);
      }
    });
    it("T-167: hai rebuild đồng thời chạy tuần tự (mỗi lần thay là MỘT ảnh chụp, không xen lúc đọc); ảnh chụp cũ hơn ảnh chụp đã áp bị bỏ", async () => {
      const svc = index();
      const order: string[] = [];
      const clock = svc.clockNow.bind(svc);
      const replace = svc.replaceAll.bind(svc);
      jest.spyOn(svc, "clockNow").mockImplementation(async () => {
        order.push("đọc");
        return clock();
      });
      jest.spyOn(svc, "replaceAll").mockImplementation(async (rows, since) => {
        order.push("thay");
        return replace(rows, since);
      });
      const [a, b] = await Promise.all([rebuildCatalogIndex(container), rebuildCatalogIndex(container)]);
      expect(order).toEqual(["đọc", "thay", "đọc", "thay"]);
      for (const r of [a, b]) {
        expect(r.superseded).toBe(false);
        expect(r.rows).toBe(expectedTotal);
      }
      expect(await count()).toBe(expectedTotal);
      expect(await distinctKeys()).toBe(expectedTotal);
      jest.restoreAllMocks();

      // Chốt ở DB, không dựa vào khoá Redis (lease mất, tiến trình treo): ảnh chụp bắt đầu trước ảnh chụp đã áp → không ghi.
      const older = await svc.clockNow();
      const newer = await svc.clockNow();
      const rows = (await db.raw(`SELECT * FROM catalog_variant_index`)).rows as CatalogIndexRow[];
      expect((await svc.replaceAll(rows, newer)).applied).toBe(true);
      const stale = await svc.replaceAll(rows.slice(0, 10), older);
      expect(stale).toEqual({ applied: false, inserted: 0, keptProducts: [], keptRows: 0 });
      expect(await count()).toBe(expectedTotal);
    });

    it("T-167: khoá ghi chỉ giữ lúc thay bảng — câu SQL trong khoá ≤ ⌈dòng/500⌉ + hằng số, không câu nào đọc nguồn, phần lớn câu chạy ngoài khoá", async () => {
      // Đo theo SỐ CÂU, không theo đồng hồ (máy tải nặng làm wall-clock chập chờn). Trước T-167 mọi câu (kể cả đọc nguồn
      // 50k SKU ~51–69 s, docs/db/connections.md §5) chạy trong khoá → tỉ lệ 1,0.
      const locking = container.resolve(Modules.LOCKING);
      const acquire = locking.acquire.bind(locking);
      const release = locking.release.bind(locking);
      const isIndexLock = (keys: string | string[]) =>
        (Array.isArray(keys) ? keys : [keys]).includes(CATALOG_INDEX_LOCK);
      let held = false;
      jest.spyOn(locking, "acquire").mockImplementation(async (keys, args) => {
        await acquire(keys, args);
        if (isIndexLock(keys)) held = true;
      });
      jest.spyOn(locking, "release").mockImplementation(async (keys, args) => {
        if (isIndexLock(keys)) held = false;
        return release(keys, args);
      });
      const inLock: string[] = [];
      let outside = 0;
      const onQuery = (q: { sql?: string }) => {
        if (held) inLock.push(q.sql ?? "");
        else outside += 1;
      };
      db.on("query", onQuery);
      const result = await rebuildCatalogIndex(container).finally(() => db.removeListener("query", onQuery));
      expect(result.rows).toBe(expectedTotal);
      const SOURCE =
        /\b(from|join)\s+"?(product|product_variant|price|price_set|price_list|inventory_item|inventory_level|reservation_item|product_category|sales_channel)"?(\s|$)/i;
      expect(inLock.filter((s) => SOURCE.test(s))).toEqual([]);
      expect(inLock.length).toBeLessThanOrEqual(Math.ceil(expectedTotal / 500) + 12);
      // Đo 2026-10-27 (5.605 dòng): 21 câu trong khoá (BEGIN, 6 câu write log/chốt, DELETE, 12 INSERT, COMMIT, đếm cuối)
      // trên 252 câu cả lượt (8 %); trước T-167: mọi câu trong khoá, gồm 391 câu đọc nguồn.
      expect(inLock.length / (inLock.length + outside)).toBeLessThan(0.5);
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

    it("T-061: drain giữ dấu sản phẩm lệch giá, thử lại khi đến hạn (backoff), ghi được khi giá sửa xong; sản phẩm tốt ghi ngay", async () => {
      await rebuildCatalogIndex(container);
      await db.raw(`DELETE FROM ops_exception WHERE kind = ?`, [KIND]);
      await markSentinel("prod_SCALE0000%");
      const bad = "prod_SCALE00001";
      const good = "prod_SCALE00002";
      const dirty = async (id: string) =>
        (
          await db.raw(
            `SELECT attempts, next_attempt_at > clock_timestamp() AS waiting FROM catalog_index_dirty WHERE product_id = ?`,
            [id],
          )
        ).rows[0] as { attempts: number; waiting: boolean } | undefined;
      const makeDue = () =>
        db.raw(
          `UPDATE catalog_index_dirty SET next_attempt_at = clock_timestamp() - interval '1 second' WHERE product_id = ?`,
          [bad],
        );

      await index().markDirty([bad, good]);
      const stub = breakPricing();
      await drainCatalogIndex(container);
      // Sản phẩm tốt ghi ngay (sentinel biến mất, dấu xoá); sản phẩm lệch giữ dòng cũ + dấu hẹn lại.
      expect(await count("product_id = ? AND title = ?", [good, SENTINEL])).toBe(0);
      expect(await dirty(good)).toBeUndefined();
      expect(await count("product_id = ? AND title = ?", [bad, SENTINEL])).toBe(SKUS_PER_PRODUCT);
      expect(await dirty(bad)).toEqual({ attempts: 1, waiting: true });

      // Chưa đến hạn: drain không đọc nguồn (không lặp nóng).
      const graph = jest.spyOn(container.resolve(ContainerRegistrationKeys.QUERY), "graph");
      const before = graph.mock.calls.length;
      await drainCatalogIndex(container);
      expect(graph.mock.calls.length).toBe(before);
      expect(await dirty(bad)).toEqual({ attempts: 1, waiting: true });

      // Đến hạn mà giá vẫn hỏng: thử lại, attempts tăng, hẹn lùi tiếp.
      await makeDue();
      await drainCatalogIndex(container);
      expect(await dirty(bad)).toEqual({ attempts: 2, waiting: true });
      expect(await count("product_id = ? AND title = ?", [bad, SENTINEL])).toBe(SKUS_PER_PRODUCT);

      // Giá sửa xong + đến hạn: ghi được, dấu xoá, ngoại lệ đã mở vẫn còn (không tự đóng).
      stub.mockRestore();
      await makeDue();
      await drainCatalogIndex(container);
      expect(await dirty(bad)).toBeUndefined();
      expect(await count("product_id = ? AND title = ?", [bad, SENTINEL])).toBe(0);
      expect(await count("product_id = ?", [bad])).toBe(SKUS_PER_PRODUCT);
      expect(await exceptions("open")).toBe(1);
    });

    it("T-061: markDirty mới trên dấu đang chờ backoff đặt lại attempts và đến hạn ngay; migration down/up khứ hồi", async () => {
      const bad = "prod_SCALE00003";
      await index().markDirty([bad]);
      await db.raw(
        `UPDATE catalog_index_dirty SET attempts = 3, next_attempt_at = clock_timestamp() + interval '1 hour' WHERE product_id = ?`,
        [bad],
      );
      expect((await index().claimDirty(1000)).map((c) => c.product_id)).not.toContain(bad);
      await index().markDirty([bad]);
      const claims = await index().claimDirty(1000);
      expect(claims.find((c) => c.product_id === bad)?.attempts).toBe(0);
      await index().clearDirty(claims);

      const run = async (direction: "up" | "down") => {
        const m = new Migration20261026120000({} as never, {} as never);
        await m[direction]();
        for (const q of m.getQueries()) await db.raw(String(q));
      };
      const cols = async () =>
        (
          await db.raw(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'catalog_index_dirty' AND column_name IN ('attempts','next_attempt_at')`,
          )
        ).rows.length;
      await run("down");
      expect(await cols()).toBe(0);
      await run("up");
      expect(await cols()).toBe(2);
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
