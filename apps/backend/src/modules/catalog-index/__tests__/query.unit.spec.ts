import { EMPTY_FILTER, type CatalogFilter } from "@x-shop/domain";
import {
  candidateTerm,
  facetSql,
  filterSql,
  inList,
  likeContains,
  listingSql,
  pageSql,
  queryTerms,
  termRegex,
  termSql,
  type Scope,
} from "../query";

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

  describe("listingSql (T-058: một câu cho trang + 3 facet)", () => {
    const full: CatalogFilter = {
      ...EMPTY_FILTER,
      q: "Áo sơ-mi lụa",
      colors: ["den", "trang"],
      sizes: ["m"],
      materials: ["lua"],
      priceMin: 100_000,
      priceMax: 500_000,
      inStock: true,
      sort: "price_desc",
      page: 3,
    };
    const variants: CatalogFilter[] = [
      EMPTY_FILTER,
      full,
      { ...full, q: "ao so mi" }, // không từ nào ≥ 3 ký tự → nhánh OR, không LIKE
      { ...full, q: null },
      { ...EMPTY_FILTER, priceMax: 0 },
      { ...EMPTY_FILTER, inStock: true, q: "x" },
    ];

    /** Ghép mỗi `?` với đoạn SQL ngay trước nó — kiểm tham số nằm đúng chỗ (thứ tự đẩy = thứ tự xuất hiện). */
    function paired(sql: string, bindings: unknown[]) {
      const parts = sql.split("?");
      expect(parts.length - 1).toBe(bindings.length);
      return bindings.map((b, i) => ({ before: (parts[i] as string).replace(/\s+/g, " ").slice(-40), b }));
    }

    it("số placeholder khớp số tham số với mọi tổ hợp bộ lọc × phạm vi", () => {
      for (const s of [scope, { ...scope, category: "nu" }, { channelIds: ["a", "b"], category: "ao-nu" }])
        for (const f of variants) {
          const q = listingSql(s, f, 24);
          expect(placeholders(q.sql)).toBe(q.bindings.length);
        }
    });

    it("mỗi tham số nằm đúng vị trí của nó", () => {
      const q = listingSql({ channelIds: ["sc_1"], category: "ao-nu" }, full, 10);
      for (const { before, b } of paired(q.sql, q.bindings)) {
        if (before.endsWith("jsonb_array_elements_text("))
          expect(typeof b === "string" && b.startsWith("[")).toBe(true);
        else if (before.endsWith("ARRAY[")) expect(b).toBe("ao-nu");
        else if (before.endsWith("LIKE ")) expect(b).toBe("%so-mi%");
        else if (before.endsWith("search_text, "))
          expect(typeof b === "string" && b.startsWith(" ")).toBe(true);
        else if (before.endsWith("price >= ")) expect(b).toBe(100_000);
        else if (before.endsWith("price <= ")) expect(b).toBe(500_000);
        else if (/LIMIT $/.test(before)) expect(b).toBe(10);
        else if (/OFFSET $/.test(before)) expect(b).toBe(20);
        else throw new Error(`tham số ở vị trí lạ: …${before}? = ${JSON.stringify(b)}`);
      }
      // Đủ các loại: kênh (×3 phạm vi: v, q, ứng viên, s = 4), danh mục ×4, màu/size/chất liệu, 2 giá, 3 từ + ứng viên.
      expect(q.bindings).toEqual(expect.arrayContaining([" ao", " so-mi", " lua", "%so-mi%", 10, 20]));
    });

    it("không từ khoá → không có CTE q; từ khoá ngắn (< 3 ký tự) → không LIKE (trigram không dùng được)", () => {
      expect(listingSql(scope, { ...full, q: null }, 24).sql).not.toMatch(/\bq AS \(/);
      const short = listingSql(scope, { ...full, q: "ao so mi" }, 24);
      expect(short.sql).toMatch(/\bq AS \(/);
      expect(short.sql).not.toContain("LIKE");
      expect(listingSql(scope, full, 24).sql).toContain("LIKE");
    });

    it("giá trị độc không lọt vào SQL (chỉ đi qua tham số)", () => {
      const evil = "x'); DROP TABLE catalog_variant_index; --";
      const q = listingSql(
        { channelIds: [evil], category: evil },
        { ...full, colors: [evil], sizes: [evil], materials: [evil], q: evil },
        24,
      );
      expect(q.sql).not.toContain("DROP");
      expect(JSON.stringify(q.bindings)).toContain("DROP");
    });
  });

  it("termSql ⇔ regex tiền tố từ của bản tham chiếu (cùng kết quả trên chuỗi ngẫu nhiên)", () => {
    const alphabet = ["a", "o", "s", "m", "i", " ", "-", ".", "*", "1", "đ"];
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const str = (len: number) => Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join("");
    for (let i = 0; i < 3000; i++) {
      const text = str(rnd(12));
      const term = str(1 + rnd(3)).replace(/ /g, "a");
      const viaStrpos = ` ${text}`.includes(termSql(term).bindings[0] as string);
      expect([text, term, viaStrpos]).toEqual([text, term, new RegExp(termRegex(term)).test(text)]);
    }
    expect(termSql("ao")).toEqual({ sql: "strpos(' ' || search_text, ?) > 0", bindings: [" ao"] });
  });

  it("likeContains thoát ký tự đại diện; candidateTerm chọn từ dài nhất ≥ 3 ký tự", () => {
    expect(likeContains("so-mi")).toBe("%so-mi%");
    expect(likeContains("a%b_c\\d")).toBe("%a\\%b\\_c\\\\d%");
    expect(candidateTerm(["ao", "so", "mi"])).toBeNull();
    expect(candidateTerm([])).toBeNull();
    expect(candidateTerm(["ao", "kaki", "denim", "lua"])).toBe("denim");
    expect(candidateTerm(["mau", "00042"])).toBe("00042");
  });
});
