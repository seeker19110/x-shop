// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assetUrl, mapCategories, mapList, mapProduct, mapSearch, mapSizeChart } from "./backend-map";

/** Hợp đồng với backend: fixture JSON là phản hồi THẬT của `medusa develop` + seed demo (xem README bên dưới). */
const fx = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./__fixtures__/backend/${name}.json`, import.meta.url)), "utf8"),
  );
const BASE = "http://backend.test:9000";

describe("mapList (phản hồi thật GET /store/x/products)", () => {
  const r = mapList(fx("list"), BASE);

  it("giữ tổng, trang, giá nguyên và đổi tên compare_at → compare_at_max", () => {
    expect(r.total).toBeGreaterThan(0);
    expect(r.page).toBe(1);
    expect(r.items).toHaveLength(2);
    const first = r.items[0]!;
    expect(first.price_min).toBe(450000);
    expect(first.compare_at_max).toBeNull();
    expect(Number.isInteger(first.price_max)).toBe(true);
  });

  it("thumbnail chuỗi tương đối → ảnh tuyệt đối có alt = tên và kích thước", () => {
    const t = r.items[0]!.thumbnail;
    expect(t.url).toMatch(/^http:\/\/backend\.test:9000\/static\/demo\/.+\.svg/);
    expect(t.alt).toBe("Thắt lưng da bò");
    expect(t.width).toBeGreaterThan(0);
    expect(t.height).toBeGreaterThan(0);
  });

  it("facet đủ 3 nhóm; màu có hex", () => {
    expect(Object.keys(r.facets).sort()).toEqual(["color", "material", "size"]);
    expect(r.items[0]!.colors[0]).toEqual({ value: "den", label: "Đen", hex: "#1A1A1A" });
  });
});

describe("mapSearch", () => {
  it("kết quả: không gợi ý", () => {
    const r = mapSearch(fx("search"), BASE);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.suggestions).toBeUndefined();
  });

  it("không kết quả: suggestions {categories} → mảng {type:'category'}", () => {
    const r = mapSearch(fx("search-empty"), BASE);
    expect(r.total).toBe(0);
    expect(r.suggestions?.length).toBeGreaterThan(0);
    expect(r.suggestions![0]).toMatchObject({ type: "category" });
    expect(typeof r.suggestions![0]!.handle).toBe("string");
  });
});

describe("mapProduct (phản hồi thật GET /store/x/products/:handle)", () => {
  const p = mapProduct(fx("product"), BASE)!;

  it("options.colors/sizes → options.color/size", () => {
    expect(p.options.color.map((c) => c.value)).toEqual(["den", "trang"]);
    expect(p.options.size.map((s) => s.value)).toEqual(["s", "m"]);
  });

  it("biến thể: giá nguyên, tồn tại từng SKU", () => {
    expect(p.variants).toHaveLength(4);
    expect(p.variants.find((v) => v.sku === "SMLUA-DEN-S")).toMatchObject({
      price: 650000,
      in_stock: false,
      color: "den",
      size: "s",
    });
  });

  it("ảnh: URL tuyệt đối, alt có chữ, màu giữ nguyên", () => {
    expect(p.images).toHaveLength(6);
    expect(p.images[0]!.url.startsWith(`${BASE}/static/`)).toBe(true);
    expect(p.images[0]!.alt).not.toBe("");
    expect(p.images[0]!.color).toBe("den");
  });

  it("bảng size backend (cột/dòng dạng đối tượng) → bảng chuỗi cho dialog", () => {
    expect(p.size_chart?.columns).toEqual(["Size", "Vòng ngực", "Vòng eo", "Dài áo"]);
    expect(p.size_chart?.rows[0]).toEqual(["XS", "78–82", "60–64", "60"]);
    expect(p.size_chart?.rows).toHaveLength(5);
    expect(p.size_chart?.unit).toBe("cm");
  });

  it("số đo người mẫu: chest_cm → bust_cm, size_worn → wearing_size", () => {
    expect(p.model_measurements).toEqual([
      { image_set: "den", height_cm: 168, bust_cm: 82, wearing_size: "s" },
    ]);
  });

  it("danh mục, thuộc tính, thời điểm cập nhật giữ nguyên", () => {
    expect(p.category).toEqual({ handle: "ao-nu", name: "Áo nữ" });
    expect(p.attributes.material).toBe("Lụa");
    expect(p.updated_at).toMatch(/Z$/);
  });
});

describe("mapProduct / mapSizeChart: ca biên", () => {
  const base = fx("product") as Record<string, unknown>;

  it("không phải đối tượng hoặc thiếu id/handle → null", () => {
    expect(mapProduct(null, BASE)).toBeNull();
    expect(mapProduct([], BASE)).toBeNull();
    expect(mapProduct({ ...base, handle: "" }, BASE)).toBeNull();
  });

  it("category null, ảnh thiếu kích thước/alt, màu thiếu hex không làm hỏng", () => {
    const p = mapProduct(
      {
        ...base,
        category: null,
        images: [{ url: "https://cdn.test/a.jpg", alt: null, color: null, width: null, height: null }],
        options: { colors: [{ value: "x", label: "X", hex: null }], sizes: [] },
      },
      BASE,
    )!;
    expect(p.category).toBeNull();
    expect(p.images[0]).toEqual({
      url: "https://cdn.test/a.jpg",
      alt: "",
      color: null,
      width: 800,
      height: 1000,
    });
    expect(p.options.color[0]!.hex).toMatch(/^#/);
  });

  it("bảng size: thiếu giá trị → '—'; min = max → một số; rỗng → null", () => {
    const chart = mapSizeChart({
      version: 2,
      columns: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
      rows: [{ size: "m", label: "M", values: { a: [70, 70] } }],
    });
    expect(chart?.rows).toEqual([["M", "70", "—"]]);
    expect(mapSizeChart({ columns: [], rows: [] })).toBeNull();
    expect(mapSizeChart(null)).toBeNull();
  });

  it("model_measurements thiếu chiều cao → bỏ (không bịa số đo)", () => {
    const p = mapProduct({ ...base, model_measurements: [{ image_set: "den", height_cm: null }] }, BASE)!;
    expect(p.model_measurements).toEqual([]);
  });
});

describe("mapCategories / assetUrl", () => {
  it("phản hồi thật: có cha/con, đếm nguyên", () => {
    const c = mapCategories(fx("categories"));
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((x) => x.parent_handle === null)).toBe(true);
    expect(c.every((x) => Number.isInteger(x.product_count) && x.product_count > 0)).toBe(true);
  });

  it("dữ liệu rác → rỗng", () => {
    expect(mapCategories(null)).toEqual([]);
    expect(mapCategories({ categories: [1, { name: "no handle" }] })).toEqual([]);
  });

  it("assetUrl: tương đối thêm gốc; tuyệt đối và //cdn giữ nguyên", () => {
    expect(assetUrl("/static/a.svg", BASE)).toBe(`${BASE}/static/a.svg`);
    expect(assetUrl("https://cdn.test/a.jpg", BASE)).toBe("https://cdn.test/a.jpg");
    expect(assetUrl("//cdn.test/a.jpg", BASE)).toBe("//cdn.test/a.jpg");
  });
});
