import { EMPTY_FILTER, type CatalogFilter } from "@x-shop/domain";
import { facetSql, filterSql, inList, pageSql, queryTerms, termRegex, type Scope } from "../query";

const scope: Scope = { channelIds: ["sc_1"], category: null };
const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length;

describe("query builder của read model", () => {
  it("số placeholder luôn khớp số tham số bind (không nối chuỗi giá trị người dùng)", () => {
    const f: CatalogFilter = {
      ...EMPTY_FILTER,
      q: "áo sơ mi",
      colors: ["den", "trang"],
      sizes: ["m"],
      materials: ["lua"],
      priceMin: 0,
      priceMax: 500_000,
      inStock: true,
      page: 3,
    };
    for (const s of [{ ...scope, category: "nu" }, scope]) {
      for (const q of [
        filterSql(s, f),
        filterSql(s, f, "color"),
        pageSql(s, f, 24),
        facetSql(s, f, "size"),
        facetSql(s, f, "material"),
      ]) {
        expect(placeholders(q.sql)).toBe(q.bindings.length);
      }
    }
  });

  it("giá trị độc không lọt vào SQL", () => {
    const evil = "x'); DROP TABLE catalog_variant_index; --";
    const q = filterSql(scope, { ...EMPTY_FILTER, colors: [evil], q: evil });
    expect(q.sql).not.toContain("DROP");
    expect(JSON.stringify(q.bindings)).toContain("DROP");
  });

  it("facet loại đúng điều kiện của chính nó (disjunctive)", () => {
    const f = { ...EMPTY_FILTER, colors: ["den"], sizes: ["m"] };
    expect(filterSql(scope, f, "color").sql).not.toContain("color IN");
    expect(filterSql(scope, f, "color").sql).toContain("size IN");
    expect(filterSql(scope, f, "size").sql).toContain("color IN");
  });

  it("từ khoá: chuẩn hoá như domain, regex tiền tố từ, ký tự đặc biệt được thoát", () => {
    expect(queryTerms("ÁO  Sơ-Mi")).toEqual(["ao", "so-mi"]);
    expect(queryTerms(null)).toEqual([]);
    expect(termRegex("ao")).toBe("(^| )ao");
    expect(termRegex("a.b*")).toBe("(^| )a\\.b\\*");
  });

  it("inList gói danh sách thành MỘT tham số JSON", () => {
    expect(inList("color", ["den", "trang"])).toEqual({
      sql: "color IN (SELECT jsonb_array_elements_text(?::jsonb))",
      bindings: ['["den","trang"]'],
    });
  });

  it("phân trang: offset theo trang, sắp ổn định theo product_id byte-order", () => {
    const q = pageSql(scope, { ...EMPTY_FILTER, page: 3, sort: "price_desc" }, 10);
    expect(q.bindings.slice(-2)).toEqual([10, 20]);
    expect(q.sql).toContain(`price_max DESC, product_id COLLATE "C" ASC`);
  });
});
