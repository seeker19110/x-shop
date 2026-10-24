import { searchKey, type CatalogFilter, type FacetName } from "@x-shop/domain";

/**
 * Dựng điều kiện SQL cho read model — dịch đúng ngữ nghĩa của oracle `filterProducts`/`facetCounts` (packages/domain):
 *  - màu/size/giá/còn hàng xét trên CÙNG một dòng SKU (AT01, AT31);
 *  - chất liệu và truy vấn q xét ở cấp sản phẩm (mỗi từ là tiền tố của một từ trong tên/SKU/danh mục của sản phẩm);
 *  - mọi giá trị người dùng đi qua tham số bind, không nối chuỗi.
 */

export const TABLE = "catalog_variant_index";

export interface Scope {
  channelIds: string[];
  /** Handle danh mục (đã slugify) — giới hạn tập sản phẩm như truyền tập con cho oracle. */
  category: string | null;
}

export interface Sql {
  sql: string;
  bindings: unknown[];
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Từ khoá tìm kiếm đã chuẩn hoá giống `matchesQuery` của domain; rỗng → []. */
export function queryTerms(q: string | null): string[] {
  if (q === null) return [];
  return searchKey(q).split(" ").filter(Boolean);
}

/** Regex Postgres "từ bắt đầu bằng term" trên search_text (đã chuẩn hoá, từ cách nhau một khoảng trắng). */
export function termRegex(term: string): string {
  return `(^| )${term.replace(REGEX_META, "\\$&")}`;
}

/**
 * `column IN (danh sách)` với MỘT tham số JSON — knex.raw tự bung mảng thành nhiều `?`, nên không bind mảng trực tiếp.
 */
export function inList(column: string, values: readonly string[]): Sql {
  return {
    sql: `${column} IN (SELECT jsonb_array_elements_text(?::jsonb))`,
    bindings: [JSON.stringify(values)],
  };
}

export function scopeSql(scope: Scope, alias = ""): Sql {
  const a = alias ? `${alias}.` : "";
  const ch = inList(`${a}sales_channel_id`, scope.channelIds);
  const parts = [ch.sql];
  const bindings: unknown[] = [...ch.bindings];
  if (scope.category !== null) {
    parts.push(`? = ANY(${a}category_handles)`);
    bindings.push(scope.category);
  }
  return { sql: parts.join(" AND "), bindings };
}

/**
 * Điều kiện của bộ lọc. `exclude` bỏ điều kiện của chính facet đang đếm (facet disjunctive).
 */
export function filterSql(scope: Scope, f: CatalogFilter, exclude: FacetName | null = null): Sql {
  const base = scopeSql(scope);
  const parts = [base.sql];
  const bindings = [...base.bindings];
  if (exclude !== "color" && f.colors.length) {
    const x = inList("color", f.colors);
    parts.push(x.sql);
    bindings.push(...x.bindings);
  }
  if (exclude !== "size" && f.sizes.length) {
    const x = inList("size", f.sizes);
    parts.push(x.sql);
    bindings.push(...x.bindings);
  }
  if (exclude !== "material" && f.materials.length) {
    const x = inList("material", f.materials);
    parts.push(x.sql);
    bindings.push(...x.bindings);
  }
  if (f.priceMin !== null) {
    parts.push("price >= ?");
    bindings.push(f.priceMin);
  }
  if (f.priceMax !== null) {
    parts.push("price <= ?");
    bindings.push(f.priceMax);
  }
  if (f.inStock) parts.push("in_stock");
  for (const term of queryTerms(f.q)) {
    const inner = scopeSql(scope, "s");
    parts.push(
      `product_id IN (SELECT s.product_id FROM ${TABLE} s WHERE ${inner.sql} AND s.search_text ~ ?)`,
    );
    bindings.push(...inner.bindings, termRegex(term));
  }
  return { sql: parts.join(" AND "), bindings };
}

const ORDER: Record<CatalogFilter["sort"], string> = {
  newest: `created_at DESC, product_id COLLATE "C" ASC`,
  price_asc: `price_min ASC, product_id COLLATE "C" ASC`,
  price_desc: `price_max DESC, product_id COLLATE "C" ASC`,
};

/**
 * Trang kết quả + tổng trong một truy vấn: nhóm theo sản phẩm trên các SKU khớp; giá min/max lấy từ SKU khớp.
 * Thứ tự ổn định giống oracle (hoà → product_id theo thứ tự byte, COLLATE "C").
 */
export function pageSql(scope: Scope, f: CatalogFilter, pageSize: number): Sql {
  const w = filterSql(scope, f);
  const offset = (f.page - 1) * pageSize;
  return {
    sql: `WITH g AS (
        SELECT product_id, min(price) AS price_min, max(price) AS price_max, bool_or(in_stock) AS in_stock,
               max(created_at) AS created_at
        FROM ${TABLE} WHERE ${w.sql} GROUP BY product_id
      )
      SELECT (SELECT count(*) FROM g)::int AS total,
             COALESCE((SELECT json_agg(p) FROM (
               SELECT product_id, price_min, price_max, in_stock FROM g ORDER BY ${ORDER[f.sort]} LIMIT ? OFFSET ?
             ) p), '[]'::json) AS items`,
    bindings: [...w.bindings, pageSize, offset],
  };
}

const FACET_COLUMNS: Record<FacetName, { label: string; extra: string; rank: string }> = {
  color: { label: "color_label", extra: "color_hex", rank: "color_rank" },
  size: { label: "size_label", extra: "NULL::text", rank: "size_rank" },
  material: { label: "material_label", extra: "NULL::text", rank: "NULL::int" },
};

/**
 * Facet disjunctive: mọi giá trị có trong phạm vi (kể cả đếm 0 — như oracle), số sản phẩm khớp khi thay điều kiện của
 * chính facet bằng giá trị đó và giữ nguyên điều kiện khác, vẫn trên cùng SKU.
 */
export function facetSql(scope: Scope, f: CatalogFilter, facet: FacetName): Sql {
  const col = facet;
  const c = FACET_COLUMNS[facet];
  const s = scopeSql(scope);
  const w = filterSql(scope, f, facet);
  return {
    sql: `SELECT v.value, v.label, v.extra, v.rank, COALESCE(n.count, 0)::int AS count
      FROM (
        SELECT ${col} AS value, min(${c.label}) AS label, min(${c.extra}) AS extra, min(${c.rank}) AS rank
        FROM ${TABLE} WHERE ${s.sql} AND ${col} IS NOT NULL GROUP BY ${col}
      ) v
      LEFT JOIN (
        SELECT ${col} AS value, count(DISTINCT product_id) AS count
        FROM ${TABLE} WHERE ${w.sql} AND ${col} IS NOT NULL GROUP BY ${col}
      ) n ON n.value = v.value
      ORDER BY v.rank ASC NULLS LAST, v.label ASC, v.value COLLATE "C" ASC`,
    bindings: [...s.bindings, ...w.bindings],
  };
}
