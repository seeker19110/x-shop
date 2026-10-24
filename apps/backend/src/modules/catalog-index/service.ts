import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import type { CatalogFilter, FacetName } from "@x-shop/domain";
import { facetSql, inList, pageSql, TABLE, type Scope } from "./query";

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

  /** Thay toàn bộ dòng của các sản phẩm (gồm xoá sản phẩm không còn dòng nào: draft, xoá, rời kênh). */
  async replaceProducts(productIds: string[], rows: CatalogIndexRow[]): Promise<void> {
    if (productIds.length === 0) return;
    await this.db.transaction(async (trx) => {
      const del = inList("product_id", productIds);
      await trx.raw(`DELETE FROM ${TABLE} WHERE ${del.sql}`, del.bindings as Knex.ValueDict[]);
      await this.insertRows(trx, rows);
    });
  }

  /** Thay cả bảng trong một giao dịch (rebuild toàn phần). */
  async replaceAll(rows: CatalogIndexRow[]): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx.raw(`DELETE FROM ${TABLE}`);
      await this.insertRows(trx, rows);
    });
  }

  /** Đánh dấu sản phẩm cần đồng bộ (idempotent; đánh dấu lại cập nhật mốc thời gian). '*' = rebuild toàn phần. */
  async markDirty(productIds: string[]): Promise<void> {
    const ids = [...new Set(productIds.filter(Boolean))];
    if (ids.length === 0) return;
    const w = inList("x", ids);
    await this.db.raw(
      `INSERT INTO catalog_index_dirty (product_id, marked_at)
       SELECT x, clock_timestamp() FROM (SELECT jsonb_array_elements_text(?::jsonb) AS x) s
       ON CONFLICT (product_id) DO UPDATE SET marked_at = EXCLUDED.marked_at`,
      w.bindings as Knex.ValueDict[],
    );
  }

  /** Lấy một lô sản phẩm bẩn (không xoá) — xoá sau khi đồng bộ xong bằng `clearDirty` với đúng mốc đã lấy. */
  async claimDirty(limit: number): Promise<DirtyClaim[]> {
    // marked_at dạng text: giữ đủ micro giây (Date của JS chỉ tới mili giây → so sánh `<=` sai).
    const res = await this.db.raw(
      `SELECT product_id, marked_at::text AS marked_at FROM catalog_index_dirty ORDER BY marked_at ASC LIMIT ?`,
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

  async dirtyCount(): Promise<number> {
    const res = await this.db.raw(`SELECT count(*)::int AS n FROM catalog_index_dirty`);
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

  async page(
    scope: Scope,
    f: CatalogFilter,
    pageSize: number,
  ): Promise<{ total: number; items: PageItem[] }> {
    const q = pageSql(scope, f, pageSize);
    const res = await this.db.raw(q.sql, q.bindings as Knex.ValueDict[]);
    const row = res.rows[0] as { total: number; items: Record<string, unknown>[] };
    return {
      total: row.total,
      items: row.items.map((i) => ({
        product_id: i.product_id as string,
        price_min: num(i.price_min),
        price_max: num(i.price_max),
        in_stock: i.in_stock as boolean,
      })),
    };
  }

  async facet(scope: Scope, f: CatalogFilter, facet: FacetName): Promise<FacetValue[]> {
    const q = facetSql(scope, f, facet);
    const res = await this.db.raw(q.sql, q.bindings as Knex.ValueDict[]);
    return res.rows as FacetValue[];
  }
}
