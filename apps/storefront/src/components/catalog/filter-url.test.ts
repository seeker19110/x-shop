// @vitest-environment node
import { EMPTY_FILTER, parseFilter, serializeFilter, type CatalogFilter } from "@x-shop/domain";
import { hrefFor, serializeQuery, withoutConditions } from "./filter-url";

const f = (q: string): CatalogFilter => parseFilter(new URLSearchParams(q)).filter;

const SAMPLES = [
  "",
  "q=áo sơ mi",
  "q=%C4%90%E1%BA%A7m",
  "color=den",
  "color=trang,den,den&size=m&size=s",
  "material=lua,cotton&in_stock=1",
  "price_min=0&price_max=500000",
  "price_min=100000",
  "sort=price_desc&page=3",
  "q=x&color=den&size=m&material=lua&price_min=1&price_max=2&in_stock=1&sort=price_asc&page=9",
  "page=1&sort=newest",
  "color=,,&size=%20",
  "utm_source=a&color=do-do",
];

describe("serializeQuery (client) khớp serializeFilter của domain (catalog)", () => {
  it.each(SAMPLES)("mẫu %j", (qs) => {
    const filter = f(qs);
    expect(serializeQuery(filter)).toBe(serializeFilter(filter));
  });

  it("khớp trên bộ lọc sinh ngẫu nhiên có hạt giống cố định (đủ tổ hợp trường)", () => {
    let seed = 20261024;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const some = (xs: readonly string[]) => xs.filter(() => rnd() < 0.4);
    for (let i = 0; i < 300; i++) {
      const filter: CatalogFilter = {
        q: rnd() < 0.3 ? pick(["áo", "đầm lụa", "a b"]) : null,
        colors: some(["den", "trang", "be", "do-do"]),
        sizes: some(["s", "m", "l", "xl"]),
        materials: some(["lua", "cotton"]),
        priceMin: rnd() < 0.4 ? Math.floor(rnd() * 1e6) : null,
        priceMax: rnd() < 0.4 ? Math.floor(rnd() * 1e6) : null,
        inStock: rnd() < 0.5,
        sort: pick(["newest", "price_asc", "price_desc"] as const),
        page: 1 + Math.floor(rnd() * 5),
      };
      expect(serializeQuery(filter)).toBe(serializeFilter(filter));
    }
  });
});

describe("hrefFor / withoutConditions (catalog)", () => {
  it("không điều kiện → chỉ đường dẫn; có điều kiện → ?query chuẩn", () => {
    expect(hrefFor("/tim-kiem", EMPTY_FILTER)).toBe("/tim-kiem");
    expect(hrefFor("/danh-muc/ao", f("size=m&color=den"))).toBe("/danh-muc/ao?color=den&size=m");
  });
  it("withoutConditions giữ sort và (tùy chọn) q, về trang 1", () => {
    const cleared = withoutConditions(f("q=áo&color=den&sort=price_asc&page=4"), { keepQuery: true });
    expect(cleared).toEqual({ ...EMPTY_FILTER, q: "áo", sort: "price_asc" });
  });
});
