import { afterEach, describe, expect, it, vi } from "vitest";
import { allMessageKeys, interpolate, rawMessage, t, type MessageKey } from "./index";

afterEach(() => vi.unstubAllEnvs());

describe("t", () => {
  it("trả đúng chuỗi, giữ nguyên dấu tiếng Việt", () => {
    expect(t("header.search")).toBe("Tìm kiếm");
    expect(t("footer.copyright")).toBe("© X-Shop");
    expect(t("layout.titleTemplate")).toBe("%s | X-Shop");
    expect(t("static.policy.pendingBadge")).toBe("Chưa chính thức.");
  });

  it("khoá thiếu: ném lỗi ở dev/test (khoá lạ, nhánh không phải lá, khoá nguyên mẫu)", () => {
    expect(() => t("khong.ton.tai" as MessageKey)).toThrow(/thiếu khoá/);
    expect(() => t("static" as MessageKey)).toThrow(/thiếu khoá/);
    expect(() => t("static.__proto__.x" as MessageKey)).toThrow(/thiếu khoá/);
    expect(() => t("" as MessageKey)).toThrow(/thiếu khoá/);
  });

  it("khoá thiếu: production trả lại chính khoá, không ném", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(t("khong.ton.tai" as MessageKey)).toBe("khong.ton.tai");
  });
});

describe("interpolate", () => {
  it("thay tham số chuỗi/số (kể cả 0 và Unicode), kể cả khi lặp", () => {
    expect(interpolate("Xin chào {name}, {n} món, {name}!", { name: "Linh Đan", n: 0 }, "k")).toBe(
      "Xin chào Linh Đan, 0 món, Linh Đan!",
    );
  });

  it("mẫu không có tham số giữ nguyên, chuỗi rỗng là giá trị hợp lệ", () => {
    expect(interpolate("không đổi", undefined, "k")).toBe("không đổi");
    expect(interpolate("[{x}]", { x: "" }, "k")).toBe("[]");
  });

  it("thiếu tham số: ném lỗi ở dev/test, production thay bằng rỗng", () => {
    expect(() => interpolate("a {x}", {}, "k")).toThrow(/thiếu tham số "x"/);
    expect(() => interpolate("a {toString}", {}, "k")).toThrow(/thiếu tham số "toString"/);
    vi.stubEnv("NODE_ENV", "production");
    expect(interpolate("a {x}", {}, "k")).toBe("a ");
  });
});

describe("vi.json", () => {
  const keys = allMessageKeys();

  it("có khoá, và mọi khoá cho chuỗi không rỗng", () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const params = Object.fromEntries(
        [...rawMessage(k).matchAll(/\{(\w+)\}/g)].map((m) => [m[1] as string, "x"]),
      );
      expect(t(k, params).trim(), k).not.toBe("");
    }
  });
});

describe("khoá nội suy của danh mục/tìm kiếm/PDP (T-220)", () => {
  it("giữ nguyên chữ gốc, kể cả tham số 0 và Unicode", () => {
    expect(t("catalog.count", { total: 0 })).toBe("0 sản phẩm");
    expect(t("catalog.pageEmptyDescription", { total: 25, pages: 3 })).toBe(
      "Bộ lọc hiện có 25 sản phẩm, trong 3 trang.",
    );
    expect(t("catalog.chip.priceRange", { min: "100.000 ₫", max: "200.000 ₫" })).toBe(
      "Giá: 100.000 ₫ – 200.000 ₫",
    );
    expect(t("catalog.issue.invalidParam", { param: "Số trang", reason: "invalid" })).toBe(
      "Số trang không hợp lệ (invalid) — đã bỏ qua.",
    );
    expect(t("search.headingWithQuery", { q: "áo {x}" })).toBe("Kết quả cho “áo {x}”");
    expect(t("product.sizeChart.model", { parts: "cao 170 cm", size: "M" })).toBe(
      "Người mẫu cao 170 cm, mặc size M.",
    );
    expect(t("product.gallery.zoomLabel", { index: 1, count: 3, alt: "Áo" })).toBe("Phóng ảnh 1/3: Áo");
  });

  it("thiếu tham số: ném lỗi ở dev/test", () => {
    expect(() => t("catalog.filters.viewCount")).toThrow(/thiếu tham số "count"/);
    expect(() => t("product.notice.sizeSoldOut", { size: "M" })).toThrow(/thiếu tham số "color"/);
  });
});
