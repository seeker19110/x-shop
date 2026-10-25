import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  activeFilterCount,
  facetCounts,
  filterProducts,
  matchProduct,
  parseFilter,
  serializeFilter,
  type CatalogFilter,
  type IndexedProduct,
} from "./filter.js";
import { matchesQuery, normalizeQuery, searchKey, slugify, toNfc } from "./text.js";

const P: IndexedProduct = {
  productId: "p1",
  title: "Áo sơ mi lụa",
  material: "lua",
  createdAt: "2026-10-01T00:00:00Z",
  variants: [
    { variantId: "v1", sku: "SM-DEN-S", color: "den", size: "s", price: 300_000, inStock: true },
    { variantId: "v2", sku: "SM-TRANG-M", color: "trang", size: "m", price: 300_000, inStock: true },
  ],
};
const Q: IndexedProduct = {
  productId: "p2",
  title: "Quần âu",
  material: "len",
  createdAt: "2026-10-05T00:00:00Z",
  variants: [
    { variantId: "w1", sku: "QA-DEN-M", color: "den", size: "m", price: 700_000, inStock: true },
    { variantId: "w2", sku: "QA-TRANG-S", color: "trang", size: "s", price: 300_000, inStock: false },
  ],
};
const f = (patch: Partial<CatalogFilter>): CatalogFilter => ({ ...EMPTY_FILTER, ...patch });

describe("text — CAT01", () => {
  it("tìm có/không dấu, hoa thường, đ", () => {
    expect(searchKey("ÁO SƠ MI Lụa")).toBe("ao so mi lua");
    expect(searchKey("Đầm đen")).toBe("dam den");
    expect(searchKey("áó")).toBe("ao");
    expect(matchesQuery("Áo sơ mi lụa", "so mi lua")).toBe(true);
    expect(matchesQuery("Áo sơ mi lụa", "ao so")).toBe(true);
    expect(matchesQuery("Áo sơ mi lụa", "quan")).toBe(false);
    expect(matchesQuery("SM-DEN-S", "sm-den")).toBe(true);
  });
  it("NFD và NFC là một", () => {
    const nfd = "Việt".normalize("NFD");
    expect(toNfc(nfd)).toBe("Việt");
    expect(searchKey(nfd)).toBe(searchKey("Việt"));
  });
  it("normalizeQuery: rỗng → null, cắt 100 ký tự", () => {
    expect(normalizeQuery("   ")).toBeNull();
    expect(normalizeQuery(undefined)).toBeNull();
    expect(normalizeQuery(null)).toBeNull();
    expect(normalizeQuery("a".repeat(150))?.length).toBe(100);
    expect(normalizeQuery("  áo   sơ mi ")).toBe("áo sơ mi");
  });
  it("slugify", () => {
    expect(slugify("Áo sơ mi lụa")).toBe("ao-so-mi-lua");
    expect(slugify("  --Đen / Trắng-- ")).toBe("den-trang");
  });
});

describe("lọc cùng SKU — AT01, AT31", () => {
  it("AT01: đen-S + trắng-M không khớp đen-M", () => {
    expect(matchProduct(P, f({ colors: ["den"], sizes: ["m"] }))).toBeNull();
    expect(filterProducts([P, Q], f({ colors: ["den"], sizes: ["m"] })).map((m) => m.productId)).toEqual([
      "p2",
    ]);
  });
  it("AT31: đen-M 700k, trắng-S 300k; đen-M ≤ 500k → không khớp; bỏ trần giá → hiển thị 700k", () => {
    expect(matchProduct(Q, f({ colors: ["den"], sizes: ["m"], priceMax: 500_000 }))).toBeNull();
    expect(matchProduct(Q, f({ colors: ["den"], sizes: ["m"] }))).toMatchObject({
      priceMin: 700_000,
      priceMax: 700_000,
      matchedVariantIds: ["w1"],
    });
  });
  it("còn hàng xét trên SKU khớp", () => {
    expect(matchProduct(Q, f({ colors: ["trang"], inStock: true }))).toBeNull();
    expect(matchProduct(Q, f({ colors: ["trang"] }))?.matchedVariantIds).toEqual(["w2"]);
  });
  it("chất liệu, truy vấn theo tên và SKU", () => {
    expect(matchProduct(P, f({ materials: ["len"] }))).toBeNull();
    expect(matchProduct(Q, f({ materials: ["len"] }))).not.toBeNull();
    expect(matchProduct(P, f({ q: "ao so mi" }))).not.toBeNull();
    expect(matchProduct(P, f({ q: "SM-TRANG" }))).not.toBeNull();
    expect(matchProduct(P, f({ q: "quan" }))).toBeNull();
    expect(matchProduct({ ...P, material: null }, f({ materials: ["lua"] }))).toBeNull();
  });
  it("sắp xếp theo giá SKU khớp, mới nhất, ổn định", () => {
    const all = [P, Q];
    expect(filterProducts(all, f({ sort: "price_asc" })).map((m) => m.productId)).toEqual(["p1", "p2"]);
    expect(filterProducts(all, f({ sort: "price_desc" })).map((m) => m.productId)).toEqual(["p2", "p1"]);
    expect(filterProducts(all, f({})).map((m) => m.productId)).toEqual(["p2", "p1"]);
    const twin = { ...P, productId: "p0" };
    expect(filterProducts([P, twin], f({})).map((m) => m.productId)).toEqual(["p0", "p1"]);
    expect(filterProducts([P, twin], f({ sort: "price_asc" })).map((m) => m.productId)).toEqual(["p0", "p1"]);
  });
  it("thuộc tính: mọi sản phẩm trả về có ≥1 SKU thỏa đủ điều kiện, và ngược lại", () => {
    const variant = fc.record({
      variantId: fc.uuid(),
      sku: fc.constantFrom("A", "B"),
      color: fc.constantFrom("den", "trang", "do"),
      size: fc.constantFrom("s", "m", "l"),
      price: fc.integer({ min: 0, max: 1_000_000 }),
      inStock: fc.boolean(),
    });
    const product = fc.record({
      productId: fc.uuid(),
      title: fc.constant("x"),
      material: fc.constantFrom("lua", "len", null),
      createdAt: fc.constant("2026-01-01T00:00:00Z"),
      variants: fc.array(variant, { minLength: 1, maxLength: 6 }),
    });
    const filter = fc.record({
      colors: fc.subarray(["den", "trang", "do"]),
      sizes: fc.subarray(["s", "m", "l"]),
      priceMax: fc.option(fc.integer({ min: 0, max: 1_000_000 })),
      inStock: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(product, { maxLength: 10 }), filter, (ps, fl) => {
        const flt = f(fl);
        const got = new Set(filterProducts(ps, flt).map((m) => m.productId));
        return ps.every((p) => {
          const anySku = p.variants.some(
            (v) =>
              (!flt.colors.length || flt.colors.includes(v.color)) &&
              (!flt.sizes.length || flt.sizes.includes(v.size)) &&
              (flt.priceMax === null || v.price <= flt.priceMax) &&
              (!flt.inStock || v.inStock),
          );
          return got.has(p.productId) === anySku;
        });
      }),
    );
  });
});

describe("facet — disjunctive, cùng SKU", () => {
  it("đang lọc size m: màu đen đếm Q (đen-M), không đếm P", () => {
    const counts = facetCounts([P, Q], f({ sizes: ["m"] }), "color");
    expect(counts.get("den")).toBe(1);
    expect(counts.get("trang")).toBe(1);
    expect(facetCounts([P, Q], f({}), "material")).toEqual(
      new Map([
        ["len", 1],
        ["lua", 1],
      ]),
    );
    expect(facetCounts([P, Q], f({ colors: ["den"] }), "size")).toEqual(
      new Map([
        ["m", 1],
        ["s", 1],
      ]),
    );
  });
});

describe("URL state — CAT03, AT32", () => {
  it("parse theo allowlist, dedupe, sắp xếp, bỏ tham số lạ", () => {
    const { filter, issues } = parseFilter(
      new URLSearchParams("size=m&size=M&color=trang,Đen&utm=x&sort=price_asc&page=2&in_stock=1&q=%20áo%20"),
    );
    expect(issues).toEqual([]);
    expect(filter).toEqual({
      ...EMPTY_FILTER,
      q: "áo",
      colors: ["den", "trang"],
      sizes: ["m"],
      sort: "price_asc",
      page: 2,
      inStock: true,
    });
  });
  it("serialize chuẩn: cùng bộ lọc → cùng URL; mặc định bị bỏ", () => {
    const a = parseFilter(new URLSearchParams("size=m&color=trang,den")).filter;
    const b = parseFilter({ color: ["den", "trang"], size: "m" }).filter;
    expect(serializeFilter(a)).toBe(serializeFilter(b));
    expect(serializeFilter(a)).toBe("color=den%2Ctrang&size=m");
    expect(serializeFilter(EMPTY_FILTER)).toBe("");
    expect(
      serializeFilter(f({ priceMin: 0, priceMax: 500_000, page: 3, sort: "price_desc", materials: ["lua"] })),
    ).toBe("material=lua&price_min=0&price_max=500000&sort=price_desc&page=3");
  });
  it("round-trip: parse(serialize(f)) = f", () => {
    fc.assert(
      fc.property(
        fc.record({
          colors: fc.subarray(["den", "trang"]),
          sizes: fc.subarray(["s", "m"]),
          priceMin: fc.option(fc.integer({ min: 0, max: 10_000_000 })),
          inStock: fc.boolean(),
          page: fc.integer({ min: 1, max: 50 }),
          sort: fc.constantFrom("newest" as const, "price_asc" as const, "price_desc" as const),
        }),
        (patch) => {
          // Trạng thái chuẩn luôn có mảng đã sắp xếp (parseFilter chuẩn hóa).
          const flt = f({ ...patch, colors: [...patch.colors].sort(), sizes: [...patch.sizes].sort() });
          return (
            JSON.stringify(parseFilter(new URLSearchParams(serializeFilter(flt))).filter) ===
            JSON.stringify(flt)
          );
        },
      ),
    );
  });
  it("giá trị sai bị bỏ kèm issue; khoảng giá ngược là issue", () => {
    const { filter, issues } = parseFilter(
      new URLSearchParams("price_min=abc&price_max=1.5&page=0&sort=hot"),
    );
    expect(filter.priceMin).toBeNull();
    expect(filter.priceMax).toBeNull();
    expect(filter.page).toBe(1);
    expect(filter.sort).toBe("newest");
    expect(issues.map((i) => i.param)).toEqual(["price_min", "price_max", "page"]);
    const r = parseFilter(new URLSearchParams("price_min=500000&price_max=100"));
    expect(r.issues).toEqual([{ param: "price_min", reason: "invalid_range" }]);
  });
  it("giới hạn số giá trị và độ dài", () => {
    const many = Array.from({ length: 30 }, (_, i) => `c${i}`).join(",");
    expect(parseFilter(new URLSearchParams(`color=${many}`)).filter.colors).toHaveLength(20);
    expect(parseFilter(new URLSearchParams(`color=${"x".repeat(41)}`)).filter.colors).toEqual([]);
  });
  it("đếm chip", () => {
    expect(activeFilterCount(EMPTY_FILTER)).toBe(0);
    expect(
      activeFilterCount(f({ colors: ["den"], sizes: ["m", "l"], priceMax: 1, inStock: true, q: "a" })),
    ).toBe(6);
  });
});
