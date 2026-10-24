import { toProductSource, toVnd, type RawProduct } from "../product-source";
import { readinessOf, toPublishCandidate } from "../publish-readiness";

const raw = (over: Partial<RawProduct> = {}): RawProduct => ({
  id: "prod_1",
  handle: "ao",
  title: "Áo sơ mi lụa",
  description: "Mô tả đủ dài cho sản phẩm thử nghiệm.",
  status: "draft",
  created_at: "2026-10-24T00:00:00.000Z",
  updated_at: "2026-10-24T00:00:00.000Z",
  variants: [
    {
      id: "v_den_m",
      sku: "SM-DEN-M",
      variant_rank: 1,
      options: [
        { value: "den", option: { title: "Màu" } },
        { value: "m", option: { title: "Size" } },
      ],
      prices: [
        { amount: 500_000, currency_code: "vnd", rules_count: 0, price_list_id: "plist_sale" },
        { amount: 650_000, currency_code: "vnd", rules_count: 1 },
        { amount: 30, currency_code: "usd", rules_count: 0 },
        { amount: 700_000, currency_code: "vnd", rules_count: 0 },
      ],
    },
    {
      id: "v_trang_s",
      sku: "SM-TRANG-S",
      variant_rank: 0,
      options: [
        { value: "trang", option: { title: "Màu" } },
        { value: "s", option: { title: "Size" } },
      ],
      prices: [{ amount: "300000.5", currency_code: "vnd" }],
    },
  ],
  images: [
    { id: "img_b", url: "b", rank: 1, metadata: { alt: "Sau", color: "den", width: 800, height: 1000 } },
    { id: "img_a", url: "a", rank: 0, metadata: { alt: "Trước" }, variants: [{ id: "v_trang_s" }] },
    { id: "img_c", url: "c", rank: 2, metadata: null, variants: [{ id: "v_den_m" }, { id: "v_trang_s" }] },
  ],
  ...over,
});

describe("toProductSource", () => {
  it("giá niêm yết = giá VND không rule, không price list; giữ phần lẻ để kiểm báo PRICE_INVALID", () => {
    const p = toProductSource(raw());
    expect(p.variants.map((v) => [v.sku, v.color, v.size, v.basePrice])).toEqual([
      ["SM-TRANG-S", "trang", "s", 300000.5],
      ["SM-DEN-M", "den", "m", 700_000],
    ]);
  });

  it("màu ảnh: metadata trước, rồi màu chung của biến thể gắn ảnh; khác màu → null; sắp theo rank", () => {
    const p = toProductSource(raw());
    expect(p.images.map((i) => [i.url, i.color, i.alt])).toEqual([
      ["a", "trang", "Trước"],
      ["b", "den", "Sau"],
      ["c", null, null],
    ]);
    expect(p.images[1]).toMatchObject({ width: 800, height: 1000 });
  });

  it("thiếu thuộc tính thời trang → kiểm xuất bản theo luật hàng may mặc", () => {
    const p = toProductSource(raw());
    expect(toPublishCandidate(p).kind).toBe("apparel");
    expect(readinessOf(p).map((i) => i.issue)).toEqual(
      expect.arrayContaining(["PRICE_INVALID", "IMAGE_ALT_MISSING", "SIZE_CHART_MISSING"]),
    );
  });

  it("rỗng/null không làm vỡ", () => {
    const p = toProductSource(raw({ variants: null, images: undefined, categories: [null] }));
    expect(p.variants).toEqual([]);
    expect(p.images).toEqual([]);
    expect(p.categories).toEqual([]);
    expect(readinessOf(p).map((i) => i.issue)).toContain("NO_VARIANTS");
  });
});

describe("toVnd", () => {
  it("chỉ nhận số nguyên an toàn", () => {
    expect(toVnd(0)).toBe(0);
    expect(toVnd("700000")).toBe(700_000);
    expect(toVnd(1.5)).toBeNull();
    expect(toVnd(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(toVnd(null)).toBeNull();
    expect(toVnd("abc")).toBeNull();
  });
});
