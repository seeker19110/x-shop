// @vitest-environment node
import { EMPTY_FILTER, parseFilter, serializeFilter, type CatalogFilter } from "@x-shop/domain";
import type { Facets } from "../../lib/catalog/types";
import {
  chipsFor,
  describeIssues,
  hrefFor,
  pageWindow,
  totalPages,
  withoutCondition,
  withoutConditions,
} from "./filter-state";

const parse = (q: string) => parseFilter(new URLSearchParams(q));
const f = (q: string): CatalogFilter => parse(q).filter;

const FACETS: Facets = {
  color: [
    { value: "den", label: "Đen", count: 3 },
    { value: "trang", label: "Trắng", count: 2 },
  ],
  size: [{ value: "m", label: "M", count: 4 }],
  material: [{ value: "lua", label: "Lụa", count: 1 }],
};

describe("hrefFor / serialize ổn định (catalog)", () => {
  it("cùng bộ lọc viết theo thứ tự/trùng/hoa khác nhau → cùng một URL chuẩn", () => {
    const a = hrefFor("/danh-muc/ao", f("size=m&color=trang&color=den&color=den&utm_source=x"));
    const b = hrefFor("/danh-muc/ao", f("color=den,trang&size=M"));
    expect(a).toBe("/danh-muc/ao?color=den%2Ctrang&size=m");
    expect(b).toBe(a);
  });

  it("không có điều kiện → chỉ đường dẫn gốc (không dấu ?)", () => {
    expect(hrefFor("/tim-kiem", EMPTY_FILTER)).toBe("/tim-kiem");
  });

  it("serialize rồi parse lại ra đúng bộ lọc (khứ hồi)", () => {
    const original = f(
      "q=áo sơ mi&color=den&size=m&price_min=1000&price_max=900000&in_stock=1&sort=price_asc&page=3",
    );
    expect(f(serializeFilter(original))).toEqual(original);
  });
});

describe("chip gỡ từng điều kiện (catalog)", () => {
  const filter = f(
    "color=den,trang&size=m&material=lua&price_min=100000&price_max=500000&in_stock=1&sort=price_asc&page=2",
  );
  const chips = chipsFor("/danh-muc/ao", filter, FACETS);

  it("một chip cho mỗi giá trị, nhãn lấy từ facet (có dấu)", () => {
    expect(chips.map((c) => c.label)).toEqual([
      "Màu: Đen",
      "Màu: Trắng",
      "Size: M",
      "Chất liệu: Lụa",
      "Giá: 100.000 ₫ – 500.000 ₫",
      "Còn hàng",
    ]);
  });

  it("gỡ chip màu Đen → URL chỉ còn Trắng, các điều kiện khác và sort giữ nguyên, về trang 1", () => {
    const den = chips.find((c) => c.key === "color:den")!;
    const u = new URLSearchParams(den.href.split("?")[1]);
    expect(u.get("color")).toBe("trang");
    expect(u.get("size")).toBe("m");
    expect(u.get("sort")).toBe("price_asc");
    expect(u.get("page")).toBeNull();
  });

  it("gỡ giá bỏ cả price_min và price_max; gỡ in_stock bỏ in_stock", () => {
    const price = new URLSearchParams(chips.find((c) => c.key === "price")!.href.split("?")[1]);
    expect(price.has("price_min") || price.has("price_max")).toBe(false);
    expect(
      new URLSearchParams(chips.find((c) => c.key === "in_stock")!.href.split("?")[1]).has("in_stock"),
    ).toBe(false);
  });

  it("gỡ điều kiện cuối cùng (chỉ còn sort mặc định) → về đường dẫn gốc", () => {
    const only = chipsFor("/danh-muc/ao", f("color=den"), FACETS);
    expect(only).toHaveLength(1);
    expect(only[0]!.href).toBe("/danh-muc/ao");
  });

  it("giá chỉ một đầu; thiếu facet → nhãn dự phòng từ giá trị", () => {
    expect(chipsFor("/x", f("price_min=200000"), null)[0]!.label).toBe("Giá: từ 200.000 ₫");
    expect(chipsFor("/x", f("price_max=200000"), null)[0]!.label).toBe("Giá: đến 200.000 ₫");
    expect(chipsFor("/x", f("size=xl&color=do-do"), null).map((c) => c.label)).toEqual([
      "Màu: do-do",
      "Size: XL",
    ]);
  });

  it("từ khóa chỉ thành chip khi includeQuery (trang danh mục), không ở trang tìm kiếm", () => {
    expect(chipsFor("/x", f("q=áo"), null).map((c) => c.key)).toEqual([]);
    expect(chipsFor("/x", f("q=áo"), null, { includeQuery: true }).map((c) => c.key)).toEqual(["q"]);
  });

  it("Xóa tất cả giữ sort; tùy chọn giữ q", () => {
    const cleared = withoutConditions(filter);
    expect(cleared.sort).toBe("price_asc");
    expect(cleared.colors).toEqual([]);
    expect(cleared.q).toBeNull();
    expect(withoutConditions(f("q=áo&color=den"), { keepQuery: true }).q).toBe("áo");
  });

  it("withoutCondition với khóa lạ không đổi điều kiện nào (chỉ về trang 1)", () => {
    const next = withoutCondition(f("color=den&page=2"), "khong-co");
    expect(next.colors).toEqual(["den"]);
    expect(next.page).toBe(1);
  });
});

describe("describeIssues", () => {
  it("giá sai khoảng và số sai đều ra câu tiếng Việt", () => {
    const msgs = describeIssues(parse("price_min=900&price_max=100&page=abc&price_max=x").issues);
    expect(msgs.some((m) => m.includes("lớn hơn"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("Số trang không hợp lệ"))).toBe(true);
  });
  it("không lỗi → rỗng", () => {
    expect(describeIssues([])).toEqual([]);
  });
});

describe("phân trang", () => {
  it("totalPages: 0 kết quả vẫn 1 trang; chia lẻ làm tròn lên", () => {
    expect(totalPages(0, 12)).toBe(1);
    expect(totalPages(12, 12)).toBe(1);
    expect(totalPages(13, 12)).toBe(2);
    expect(totalPages(5, 0)).toBe(5);
  });
  it("pageWindow: ít trang → đủ; nhiều trang → đầu, cuối, ±1 và dấu …", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(1, 10)).toEqual([1, 2, null, 10]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(10, 10)).toEqual([1, null, 9, 10]);
    expect(pageWindow(99, 10)).toEqual([1, null, 10]);
  });
});
