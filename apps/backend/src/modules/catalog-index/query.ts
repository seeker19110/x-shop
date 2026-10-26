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
 *
 * `pageSql` + `facetSql` là BẢN THAM CHIẾU (dịch thẳng oracle, 4 câu, mỗi câu quét lại phạm vi) — production dùng
 * `listingSql` (T-058); test tích hợp so hai bản trên cùng dữ liệu để giữ kết quả y hệt.
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

/* ------------------------------------------------------------------ một truy vấn cho cả trang + 3 facet (T-058) */

/**
 * `column = ANY(mảng)` với MỘT tham số JSON; mảng tính một lần (InitPlan) — rẻ hơn `IN (SELECT …)` (nested loop/hash
 * join) khi điều kiện là cờ trên từng dòng hoặc lọc phạm vi.
 */
export function anyOf(column: string, values: readonly string[]): Sql {
  return {
    sql: `${column} = ANY(ARRAY(SELECT jsonb_array_elements_text(?::jsonb)))`,
    bindings: [JSON.stringify(values)],
  };
}

/**
 * "term là tiền tố của một từ" — tương đương đúng từng ký tự với `search_text ~ termRegex(term)`: term đứng ở đầu
 * chuỗi hoặc ngay sau một dấu cách ⇔ `' ' || term` là chuỗi con của `' ' || search_text`. So chuỗi con (strpos) rẻ
 * hơn regex nhiều lần và không cần thoát ký tự đặc biệt.
 */
export function termSql(term: string, column = "search_text"): Sql {
  return { sql: `strpos(' ' || ${column}, ?) > 0`, bindings: [` ${term}`] };
}

/** Mẫu LIKE "chứa term" (thoát `\ % _`) — điều kiện CẦN của `termSql`, dùng được chỉ mục trigram khi term ≥ 3 ký tự. */
export function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Term dài nhất (≥ 3 ký tự — ngưỡng để pg_trgm trích được trigram) làm bộ lọc ứng viên; không có → null. */
export function candidateTerm(terms: readonly string[]): string | null {
  let best: string | null = null;
  for (const t of terms) if (t.length >= 3 && (best === null || t.length > best.length)) best = t;
  return best;
}

/**
 * Trang + tổng + 3 facet trong MỘT câu lệnh (T-058). Trước đó mỗi listing chạy 4 câu (trang + 3 facet, mỗi facet quét
 * phạm vi 2 lần và đếm `count(DISTINCT)` bằng sắp xếp) → 7 lần quét bảng mỗi request. Ở đây:
 *  - `v`: giá trị facet có trong phạm vi (kể cả giá trị đếm 0) + nhãn, MỘT lần quét gom theo bộ (giá trị, nhãn…) khác
 *    nhau — min trên tập khác nhau = min trên mọi dòng;
 *  - `q` (chỉ khi có từ khoá): sản phẩm mà MỖI từ khớp ít nhất một dòng của nó trong phạm vi; dòng không khớp từ nào
 *    bị bỏ trước khi nhóm. Từ dài nhất (≥ 3 ký tự) lọc ứng viên qua LIKE (chỉ mục trigram) khi đủ chọn lọc;
 *  - `s` (MATERIALIZED): dòng trong phạm vi (∩ `q`) chỉ với cột cần + cờ từng điều kiện trên dòng; danh mục qua `@>`
 *    để dùng chỉ mục GIN;
 *  - trang = nhóm theo sản phẩm trên dòng có mọi cờ đúng; đếm facet X = số sản phẩm trên dòng có mọi cờ trừ cờ của X
 *    (disjunctive), khử trùng bằng nhóm băm (giá trị, sản phẩm) thay cho sắp xếp.
 * Đúng ngữ nghĩa của `pageSql` + `facetSql` (bản tham chiếu ở trên — test tích hợp so hai bản trên cùng dữ liệu).
 * `total` vẫn đếm chính xác (giao ước API không đổi), đếm trên nhóm đã có, không quét lại bảng.
 */
export function listingSql(scope: Scope, f: CatalogFilter, pageSize: number): Sql {
  const bindings: unknown[] = [];
  // Template literal tính các `${…}` từ trái sang phải → gọi `use` ngay tại chỗ giữ thứ tự tham số = thứ tự `?`.
  const use = (x: Sql) => {
    bindings.push(...x.bindings);
    return x.sql;
  };
  const scopeWhere = () =>
    [
      use(anyOf("sales_channel_id", scope.channelIds)),
      ...(scope.category !== null
        ? [use({ sql: "category_handles @> ARRAY[?]::text[]", bindings: [scope.category] })]
        : []),
    ].join(" AND ");
  const terms = queryTerms(f.q);
  const cand = candidateTerm(terms);
  const allTerms = () => terms.map((t) => `bool_or(${use(termSql(t))})`).join(" AND ");
  // Ứng viên: có từ ≥ 3 ký tự → sản phẩm có dòng chứa từ đó (LIKE dùng được trigram); không → dòng khớp ít nhất một từ.
  const narrow = () =>
    cand !== null
      ? `product_id IN (SELECT product_id FROM ${TABLE} WHERE ${scopeWhere()}
           AND search_text LIKE ${use({ sql: "?", bindings: [likeContains(cand)] })} AND ${use(termSql(cand))})`
      : `(${terms.map((t) => use(termSql(t))).join(" OR ")})`;
  const qCte = () =>
    terms.length === 0
      ? ""
      : `q AS (
        SELECT product_id FROM ${TABLE} WHERE ${scopeWhere()} AND ${narrow()}
        GROUP BY product_id HAVING ${allTerms()}
      ),`;
  const flags = () => {
    const fc = f.colors.length ? use(anyOf("color", f.colors)) : "TRUE";
    const fs = f.sizes.length ? use(anyOf("size", f.sizes)) : "TRUE";
    const fm = f.materials.length ? use(anyOf("material", f.materials)) : "TRUE";
    const price: string[] = [];
    if (f.priceMin !== null) price.push(use({ sql: "price >= ?", bindings: [f.priceMin] }));
    if (f.priceMax !== null) price.push(use({ sql: "price <= ?", bindings: [f.priceMax] }));
    if (f.inStock) price.push("in_stock");
    const fp = price.length ? price.join(" AND ") : "TRUE";
    return `${fc} AS fc, ${fs} AS fs, ${fm} AS fm, ${fp} AS fp`;
  };
  const facet = (name: FacetName, others: string) => {
    const c = FACET_COLUMNS[name];
    return `COALESCE((SELECT json_agg(json_build_object(
          'value', fv.value, 'label', fv.label, 'extra', fv.extra, 'rank', fv.rank, 'count', COALESCE(n.count, 0)
        ) ORDER BY fv.rank ASC NULLS LAST, fv.label ASC, fv.value COLLATE "C" ASC)
        FROM (
          SELECT ${name} AS value, min(${c.label}) AS label, min(${c.extra}) AS extra, min(${c.rank}) AS rank
          FROM v WHERE ${name} IS NOT NULL GROUP BY ${name}
        ) fv LEFT JOIN (
          SELECT value, count(*)::int AS count FROM (
            SELECT ${name} AS value, product_id FROM s WHERE ${name} IS NOT NULL AND ${others}
            GROUP BY ${name}, product_id
          ) vp GROUP BY value
        ) n ON n.value = fv.value), '[]'::json) AS ${name}`;
  };
  const sql = `WITH v AS MATERIALIZED (
        SELECT color, color_label, color_hex, color_rank, size, size_label, size_rank, material, material_label
        FROM ${TABLE} WHERE ${scopeWhere()}
        GROUP BY color, color_label, color_hex, color_rank, size, size_label, size_rank, material, material_label
      ), ${qCte()} s AS MATERIALIZED (
        SELECT product_id, price, in_stock, created_at, color, size, material, ${flags()}
        FROM ${TABLE} WHERE ${scopeWhere()}${terms.length ? " AND product_id IN (SELECT product_id FROM q)" : ""}
      ), g AS MATERIALIZED (
        SELECT product_id, min(price) AS price_min, max(price) AS price_max, bool_or(in_stock) AS in_stock,
               max(created_at) AS created_at
        FROM s WHERE fc AND fs AND fm AND fp GROUP BY product_id
      )
      SELECT (SELECT count(*) FROM g)::int AS total,
             COALESCE((SELECT json_agg(json_build_object(
               'product_id', product_id, 'price_min', price_min, 'price_max', price_max, 'in_stock', in_stock
             ) ORDER BY ${ORDER[f.sort]}) FROM (
               SELECT * FROM g ORDER BY ${ORDER[f.sort]} LIMIT ${use({ sql: "?", bindings: [pageSize] })}
               OFFSET ${use({ sql: "?", bindings: [(f.page - 1) * pageSize] })}
             ) p), '[]'::json) AS items,
             ${facet("color", "fs AND fm AND fp")},
             ${facet("size", "fc AND fm AND fp")},
             ${facet("material", "fc AND fs AND fp")}`;
  return { sql, bindings };
}
