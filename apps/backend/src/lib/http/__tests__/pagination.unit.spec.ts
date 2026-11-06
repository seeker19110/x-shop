import { z } from "zod";
import { adminPageQuery, parseStorePage } from "../pagination";

const OPTS = { limitDefault: 200, limitMax: 200, offsetMax: 1000 };

describe("parseStorePage (quy ước Store: kẹp trần, sai → lỗi cho 422)", () => {
  it("vắng tham số → mặc định", () => {
    expect(parseStorePage({}, OPTS)).toEqual({ page: { limit: 200, offset: 0 }, errors: [] });
  });

  it("lớn hơn trần (kể cả 10⁶, 16 chữ số) → kẹp; trong khoảng → giữ", () => {
    for (const v of ["201", "1000000", "9999999999999999"])
      expect(parseStorePage({ limit: v }, OPTS).page.limit).toBe(200);
    expect(parseStorePage({ limit: "5", offset: "1000" }, OPTS)).toEqual({
      page: { limit: 5, offset: 1000 },
      errors: [],
    });
  });

  it("limit ≤ 0 / không phải số nguyên thập phân / mảng / object / quá 16 chữ số → lỗi", () => {
    for (const v of [
      "0",
      "-1",
      "-0",
      "abc",
      "1.5",
      "1e3",
      " 5",
      "",
      "0x10",
      "99999999999999999",
      ["5"],
      { a: 1 },
    ]) {
      const r = parseStorePage({ limit: v }, OPTS);
      expect({ v, errors: r.errors.map((e) => e.param) }).toEqual({ v, errors: ["limit"] });
      expect(r.page.limit).toBe(200);
    }
  });

  it("offset âm / quá trần / không phải số → lỗi; 0 hợp lệ", () => {
    for (const v of ["-1", "1001", "a", ["1"]])
      expect(parseStorePage({ offset: v }, OPTS).errors.map((e) => e.param)).toEqual(["offset"]);
    expect(parseStorePage({ offset: "0" }, OPTS).errors).toEqual([]);
  });

  it("lỗi cả hai tham số → báo cả hai", () => {
    expect(parseStorePage({ limit: "0", offset: "-1" }, OPTS).errors.map((e) => e.param)).toEqual([
      "limit",
      "offset",
    ]);
  });
});

describe("adminPageQuery (quy ước Admin: vượt khoảng → lỗi, không kẹp)", () => {
  const Q = z.object(adminPageQuery).strict();
  it("mặc định 50/0; 100 hợp lệ; 101, 10⁶, 0, âm, thập phân, offset quá trần → lỗi", () => {
    expect(Q.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(Q.parse({ limit: "100", offset: "100000" })).toEqual({ limit: 100, offset: 100_000 });
    for (const bad of [
      { limit: "101" },
      { limit: "1000000" },
      { limit: "0" },
      { limit: "-1" },
      { limit: "1.5" },
      { limit: "abc" },
      { offset: "100001" },
      { offset: "-1" },
    ])
      expect(Q.safeParse(bad).success).toBe(false);
  });

  it("T-200: rỗng/khoảng trắng/mảng/null không thành 0; chỉ chữ số thập phân (như Store)", () => {
    // Trước đây z.coerce.number(): `?offset=` → 0, `?limit[]=5` → 5, `1e2` → 100, `0x10` → 16.
    for (const v of ["", " ", [], ["5"], null, "1e2", "0x10", "+5", "5.0", "-0"]) {
      expect({ v, ok: Q.safeParse({ offset: v }).success }).toEqual({ v, ok: false });
      expect({ v, ok: Q.safeParse({ limit: v }).success }).toEqual({ v, ok: false });
    }
    expect(Q.parse({ offset: "0" })).toEqual({ limit: 50, offset: 0 });
  });
});
