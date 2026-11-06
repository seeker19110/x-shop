import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { CatalogFilter, FacetName } from "@x-shop/domain";
import { inList, listingSql, TABLE, type Scope } from "./query";

/** Một dòng read model: một SKU đã publish ở một kênh bán. Tiền là số nguyên VND. */
export interface CatalogIndexRow {
  variant_id: string;
  sales_channel_id: string;
  product_id: string;
  handle: string;
  title: string;
  sku: string;
  search_text: string;
  category_handles: string[];
  color: string | null;
  color_label: string | null;
  color_hex: string | null;
  color_rank: number | null;
  size: string | null;
  size_label: string | null;
  size_rank: number | null;
  material: string | null;
  material_label: string | null;
  price: number;
  compare_at: number | null;
  price_valid_until: Date | null;
  in_stock: boolean;
  variant_rank: number;
  thumbnail: string | null;
  product_thumbnail: string | null;
  created_at: Date;
}

export interface DirtyClaim {
  product_id: string;
  /** Mốc đánh dấu dạng text của Postgres (độ chính xác micro giây). */
  marked_at: string;
  /** Số lần đồng bộ trước đã bỏ qua sản phẩm này (lệch giá) — 0 với dấu mới. */
  attempts: number;
}

/** Hẹn thử lại một dấu bẩn: `attempts` mới và số giây chờ tới lần lấy kế. */
export interface DirtyDefer extends DirtyClaim {
  delay_seconds: number;
}

export interface PageItem {
  product_id: string;
  price_min: number;
  price_max: number;
  in_stock: boolean;
}

export interface FacetValue {
  value: string;
  label: string | null;
  extra: string | null;
  rank: number | null;
  count: number;
}

const COLUMNS: (keyof CatalogIndexRow)[] = [
  "variant_id",
  "sales_channel_id",
  "product_id",
  "handle",
  "title",
  "sku",
  "search_text",
  "category_handles",
  "color",
  "color_label",
  "color_hex",
  "color_rank",
  "size",
  "size_label",
  "size_rank",
  "material",
  "material_label",
  "price",
  "compare_at",
  "price_valid_until",
  "in_stock",
  "variant_rank",
  "thumbnail",
  "product_thumbnail",
  "created_at",
];

const INSERT_CHUNK = 500;

/** bigint của Postgres về dạng chuỗi — đổi lại số nguyên (VND luôn trong phạm vi an toàn của JS). */
const num = (v: unknown): number => (typeof v === "string" ? Number(v) : (v as number));

function fromDb(r: Record<string, unknown>): CatalogIndexRow {
  return {
    ...(r as unknown as CatalogIndexRow),
    price: num(r.price),
    compare_at: r.compare_at === null ? null : num(r.compare_at),
  };
}

/**
 * Lưu trữ + truy vấn của read model `catalog_variant_index` (T-014). Ghi theo sản phẩm hoặc toàn bảng trong MỘT
 * giao dịch — người đọc (READ COMMITTED) chỉ thấy bản cũ hoặc bản mới của một sản phẩm, không thấy trạng thái nửa vời;
 * rebuild toàn phần thay cả bảng trong một giao dịch nên trong lúc rebuild người đọc vẫn thấy bảng cũ.
 */
export default class CatalogIndexModuleService {
  protected readonly db: Knex;

  constructor({ __pg_connection__ }: { __pg_connection__: Knex }) {
    this.db = __pg_connection__;
  }

  private async insertRows(trx: Knex.Transaction, rows: CatalogIndexRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows
        .slice(i, i + INSERT_CHUNK)
        .map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c]])));
      await trx(TABLE).insert(chunk);
    }
  }

  /**
   * Thay toàn bộ dòng của các sản phẩm (gồm xoá sản phẩm không còn dòng nào: draft, xoá, rời kênh). Cùng giao dịch ghi
   * mốc vào `catalog_index_write_log` (đồng hồ DB) — rebuild đang dựng ngoài khoá giữ bản này nếu mốc ≥ mốc bắt đầu của nó.
   */
  async replaceProducts(productIds: string[], rows: CatalogIndexRow[]): Promise<void> {
    if (productIds.length === 0) return;
    await this.db.transaction(async (trx) => {
      const del = inList("product_id", productIds);
      await trx.raw(`DELETE FROM ${TABLE} WHERE ${del.sql}`, del.bindings as Knex.ValueDict[]);
      await this.insertRows(trx, rows);
      await trx.raw(
        `INSERT INTO catalog_index_write_log (product_id, written_at)
         SELECT x, clock_timestamp() FROM jsonb_array_elements_text(?::jsonb) x
         ON CONFLICT (product_id) DO UPDATE SET written_at = EXCLUDED.written_at`,
        [JSON.stringify([...new Set(productIds)])],
      );
    });
  }

  /** Đồng hồ DB dạng text (micro giây) — mốc bắt đầu rebuild, so với `written_at` cùng đồng hồ. */
  async clockNow(): Promise<string> {
    const res = await this.db.raw(`SELECT clock_timestamp()::text AS now`);
    return (res.rows[0] as { now: string }).now;
  }

  /**
   * Thay cả bảng bằng ảnh chụp dựng từ mốc `since` (rebuild toàn phần, T-167/D-076) trong MỘT giao dịch:
   * - ảnh chụp có mốc cũ hơn lần thay toàn bảng đã áp (`'*'` trong write log) → không ghi gì (`applied: false`);
   * - sản phẩm được `replaceProducts` ghi từ `since` trở đi (đồng bộ chạy song song lúc rebuild đọc nguồn — kể cả ghi
   *   "xoá hết dòng") giữ NGUYÊN dòng hiện tại, bỏ dòng của ảnh chụp (có thể đã cũ), và được đánh dấu bẩn lại (lượt
   *   đồng bộ đó có thể đã đọc nguồn trước `since`);
   * - mọi sản phẩm khác lấy theo ảnh chụp.
   * Người gọi giữ khoá ghi index (không ai `replaceProducts` xen giữa). Write log cũ hơn `since` được dọn: rebuild sau phải
   * có mốc ≥ `since` mới được áp nên không cần chúng.
   */
  async replaceAll(
    rows: CatalogIndexRow[],
    since: string,
  ): Promise<{ applied: boolean; inserted: number; keptProducts: string[]; keptRows: number }> {
    return this.db.transaction(async (trx) => {
      await trx.raw(
        `INSERT INTO catalog_index_write_log (product_id, written_at) VALUES ('*', '-infinity')
         ON CONFLICT (product_id) DO NOTHING`,
      );
      const guard = await trx.raw(
        `SELECT written_at > ?::timestamptz AS newer FROM catalog_index_write_log WHERE product_id = '*' FOR UPDATE`,
        [since],
      );
      if ((guard.rows[0] as { newer: boolean }).newer) {
        return { applied: false, inserted: 0, keptProducts: [], keptRows: 0 };
      }
      await trx.raw(`UPDATE catalog_index_write_log SET written_at = ?::timestamptz WHERE product_id = '*'`, [
        since,
      ]);
      const kept = await trx.raw(
        `SELECT product_id FROM catalog_index_write_log WHERE product_id <> '*' AND written_at >= ?::timestamptz`,
        [since],
      );
      const keptProducts = (kept.rows as { product_id: string }[]).map((r) => r.product_id);
      // Mốc ghi của lượt đồng bộ là lúc GHI, nó có thể đã đọc nguồn TRƯỚC `since` → bản giữ lại có thể cũ hơn ảnh chụp
      // (thay đổi không phát sự kiện — price list tới giờ, bảng màu/size, link kho↔kênh — không có dấu bẩn nào sửa lại).
      // Đánh dấu bẩn lại sản phẩm giữ lại trong cùng giao dịch: lượt xả kế tiếp đọc nguồn mới nhất (review T-167 🔴1).
      await this.upsertDirty(trx, keptProducts);
      await trx.raw(
        `DELETE FROM catalog_index_write_log WHERE product_id <> '*' AND written_at < ?::timestamptz`,
        [since],
      );
      // Danh sách rỗng → NOT IN (tập rỗng) đúng với mọi dòng → xoá cả bảng như trước.
      await trx.raw(
        `DELETE FROM catalog_variant_index WHERE product_id NOT IN (SELECT jsonb_array_elements_text(?::jsonb))`,
        [JSON.stringify(keptProducts)],
      );
      const keptRows =
        keptProducts.length === 0
          ? 0
          : ((await trx.raw(`SELECT count(*)::int AS n FROM catalog_variant_index`)).rows[0] as { n: number })
              .n;
      const skip = new Set(keptProducts);
      const fresh = skip.size === 0 ? rows : rows.filter((r) => !skip.has(r.product_id));
      await this.insertRows(trx, fresh);
      return { applied: true, inserted: fresh.length, keptProducts, keptRows };
    });
  }

  /** Đánh dấu sản phẩm cần đồng bộ (idempotent; đánh dấu lại cập nhật mốc thời gian). '*' = rebuild toàn phần. */
  async markDirty(productIds: string[]): Promise<void> {
    await this.upsertDirty(this.db, productIds);
  }

  /** Câu đánh dấu bẩn dùng chung (`markDirty` và `replaceAll` — trong giao dịch của nó). */
  private async upsertDirty(conn: Knex | Knex.Transaction, productIds: string[]): Promise<void> {
    const ids = [...new Set(productIds.filter(Boolean))];
    if (ids.length === 0) return;
    const w = inList("x", ids);
    await conn.raw(
      `INSERT INTO catalog_index_dirty (product_id, marked_at)
       SELECT x, clock_timestamp() FROM (SELECT jsonb_array_elements_text(?::jsonb) AS x) s
       ON CONFLICT (product_id) DO UPDATE SET marked_at = EXCLUDED.marked_at, attempts = 0, next_attempt_at = NULL`,
      w.bindings as Knex.ValueDict[],
    );
  }

  /** Lấy một lô sản phẩm bẩn ĐẾN HẠN (không xoá) — xoá sau khi đồng bộ xong bằng `clearDirty` với đúng mốc đã lấy. */
  async claimDirty(limit: number): Promise<DirtyClaim[]> {
    // marked_at dạng text: giữ đủ micro giây (Date của JS chỉ tới mili giây → so sánh `<=` sai).
    const res = await this.db.raw(
      `SELECT product_id, marked_at::text AS marked_at, attempts FROM catalog_index_dirty
       WHERE next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()
       ORDER BY marked_at ASC LIMIT ?`,
      [limit],
    );
    return res.rows as DirtyClaim[];
  }

  /** Xoá dấu đã xử lý; dấu được đặt lại SAU khi lấy (marked_at mới hơn) được giữ cho lượt sau. */
  async clearDirty(claims: DirtyClaim[]): Promise<void> {
    if (claims.length === 0) return;
    await this.db.raw(
      `DELETE FROM catalog_index_dirty d USING (
         SELECT x->>'product_id' AS product_id, (x->>'marked_at')::timestamptz AS marked_at
         FROM jsonb_array_elements(?::jsonb) x
       ) c WHERE d.product_id = c.product_id AND d.marked_at <= c.marked_at`,
      [JSON.stringify(claims)],
    );
  }

  /**
   * Hẹn thử lại các dấu (sản phẩm bị bỏ qua): đặt `attempts` và lùi `next_attempt_at`. Dấu đã được đặt lại sau khi lấy
   * (marked_at mới hơn; markDirty cũng reset attempts) thì giữ nguyên để lấy ngay lượt sau.
   */
  async deferDirty(items: DirtyDefer[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.raw(
      `UPDATE catalog_index_dirty d
          SET attempts = c.attempts, next_attempt_at = clock_timestamp() + c.delay_seconds * interval '1 second'
         FROM (
           SELECT x->>'product_id' AS product_id, (x->>'marked_at')::timestamptz AS marked_at,
                  (x->>'attempts')::int AS attempts, (x->>'delay_seconds')::int AS delay_seconds
             FROM jsonb_array_elements(?::jsonb) x
         ) c WHERE d.product_id = c.product_id AND d.marked_at <= c.marked_at`,
      [JSON.stringify(items)],
    );
  }

  /** Số dòng read model (toàn bảng, hoặc chỉ của các sản phẩm) — kiểm cuối sau rebuild/sync. */
  async countRows(productIds?: string[]): Promise<number> {
    if (productIds && productIds.length === 0) return 0;
    const w = productIds ? inList("product_id", productIds) : null;
    const res = await this.db.raw(
      `SELECT count(*)::int AS n FROM ${TABLE}${w ? ` WHERE ${w.sql}` : ""}`,
      (w?.bindings ?? []) as Knex.ValueDict[],
    );
    return (res.rows[0] as { n: number }).n;
  }

  /** Số dấu bẩn; `dueOnly` chỉ đếm dấu đã đến hạn lấy (không tính dấu đang chờ backoff). */
  async dirtyCount(dueOnly = false): Promise<number> {
    const res = await this.db.raw(
      `SELECT count(*)::int AS n FROM catalog_index_dirty${
        dueOnly ? " WHERE next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()" : ""
      }`,
    );
    return (res.rows[0] as { n: number }).n;
  }

  async productIdsForVariants(variantIds: string[]): Promise<string[]> {
    if (variantIds.length === 0) return [];
    const w = inList("variant_id", variantIds);
    const res = await this.db.raw(
      `SELECT DISTINCT product_id FROM ${TABLE} WHERE ${w.sql}`,
      w.bindings as Knex.ValueDict[],
    );
    return (res.rows as { product_id: string }[]).map((r) => r.product_id);
  }

  /** Sản phẩm có giá khuyến mãi đã hết hạn nhưng index chưa cập nhật (job hết hạn giá). */
  async productIdsWithExpiredPrice(now: Date): Promise<string[]> {
    const res = await this.db.raw(
      `SELECT DISTINCT product_id FROM ${TABLE} WHERE price_valid_until IS NOT NULL AND price_valid_until <= ?`,
      [now],
    );
    return (res.rows as { product_id: string }[]).map((r) => r.product_id);
  }

  async listRows(scope: Scope, productIds?: string[]): Promise<CatalogIndexRow[]> {
    const ch = inList("sales_channel_id", scope.channelIds);
    const parts = [ch.sql];
    const bindings = [...ch.bindings];
    if (productIds) {
      const p = inList("product_id", productIds);
      parts.push(p.sql);
      bindings.push(...p.bindings);
    }
    if (scope.category !== null) {
      parts.push("? = ANY(category_handles)");
      bindings.push(scope.category);
    }
    const res = await this.db.raw(
      `SELECT * FROM ${TABLE} WHERE ${parts.join(" AND ")} ORDER BY product_id, variant_rank, variant_id`,
      bindings as Knex.ValueDict[],
    );
    return (res.rows as Record<string, unknown>[]).map(fromDb);
  }

  /**
   * Trang + tổng + 3 facet của một listing trong MỘT câu lệnh (T-058, `listingSql`). Kết quả y hệt bản 4 câu cũ
   * (`pageSql` + `facetSql`), chỉ rẻ hơn.
   */
  async listing(
    scope: Scope,
    f: CatalogFilter,
    pageSize: number,
  ): Promise<{ total: number; items: PageItem[]; facets: Record<FacetName, FacetValue[]> }> {
    const q = listingSql(scope, f, pageSize);
    const res = await this.db.raw(q.sql, q.bindings as Knex.ValueDict[]);
    const row = res.rows[0] as {
      total: number;
      items: Record<string, unknown>[];
    } & Record<FacetName, FacetValue[]>;
    return {
      total: row.total,
      items: row.items.map((i) => ({
        product_id: i.product_id as string,
        price_min: num(i.price_min),
        price_max: num(i.price_max),
        in_stock: i.in_stock as boolean,
      })),
      facets: { color: row.color, size: row.size, material: row.material },
    };
  }

  /** Số sản phẩm (đếm riêng) đã publish theo handle danh mục (gồm danh mục tổ tiên) trong các kênh bán. */
  async categoryCounts(channelIds: string[]): Promise<{ handle: string; count: number }[]> {
    if (channelIds.length === 0) return [];
    const ch = inList("sales_channel_id", channelIds);
    const res = await this.db.raw(
      `SELECT h AS handle, count(DISTINCT product_id)::int AS count
       FROM ${TABLE}, unnest(category_handles) AS h
       WHERE ${ch.sql}
       GROUP BY h`,
      ch.bindings as Knex.ValueDict[],
    );
    return res.rows as { handle: string; count: number }[];
  }
}
