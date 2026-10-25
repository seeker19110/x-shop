import { parseListingQuery, sanitizeQuery } from "../listing";

describe("parseListingQuery", () => {
  it("mặc định: trang 1, 24/trang, không danh mục", () => {
    const { request, errors } = parseListingQuery({});
    expect(errors).toEqual([]);
    expect(request).toMatchObject({ pageSize: 24, category: null, filter: { page: 1, sort: "newest" } });
  });

  it("page_size kẹp ≤ 48; sai định dạng → lỗi", () => {
    expect(parseListingQuery({ page_size: "1000" }).request.pageSize).toBe(48);
    expect(parseListingQuery({ page_size: "0" }).errors).toEqual([
      { param: "page_size", reason: expect.any(String) },
    ]);
    expect(parseListingQuery({ page_size: "-1" }).errors[0]?.param).toBe("page_size");
  });

  it("price_min > price_max → lỗi invalid_range (API trả 422)", () => {
    expect(parseListingQuery({ price_min: "600000", price_max: "500000" }).errors).toEqual([
      { param: "price_min", reason: "invalid_range" },
    ]);
  });

  it("danh mục được slugify; object lồng nhau (qs) bị bỏ như tham số lạ", () => {
    expect(parseListingQuery({ category: "Áo Nữ" }).request.category).toBe("ao-nu");
    expect(sanitizeQuery({ color: { $ne: "x" }, size: ["m", 1, "s"], q: "ao" })).toEqual({
      size: ["m", "s"],
      q: ["ao"],
    });
    expect(parseListingQuery({ color: { $gt: "" } }).request.filter.colors).toEqual([]);
  });
});
