import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { csvCell, parseCsv, toCsv, validateImport } from "./csv.js";
import { checkPublishReadiness, type PublishCandidate } from "./publish.js";

const good: PublishCandidate = {
  title: "Áo sơ mi lụa",
  kind: "apparel",
  description: "Áo sơ mi lụa tơ tằm, form suông, mặc thoáng mát mùa hè.",
  sizeChartId: "sc_ao",
  images: [
    { url: "a.jpg", alt: "Mặt trước áo màu đen", color: "den" },
    { url: "b.jpg", alt: "Mặt sau áo màu đen", color: "den" },
    { url: "c.jpg", alt: "Chi tiết vải", color: "trang" },
  ],
  variants: [
    { sku: "SM-DEN-M", color: "den", size: "m", price: 700_000 },
    { sku: "SM-TRANG-S", color: "trang", size: "s", price: 300_000 },
  ],
  imageExceptionBy: null,
};
const issues = (p: Partial<PublishCandidate>) => checkPublishReadiness({ ...good, ...p }).map((i) => i.issue);

describe("checkPublishReadiness — ADM03, S-207", () => {
  it("đủ dữ liệu → không vấn đề", () => {
    expect(checkPublishReadiness(good)).toEqual([]);
  });
  it("ảnh < 3 với quần áo bị chặn trừ khi có người chịu trách nhiệm", () => {
    expect(issues({ images: good.images.slice(0, 2) })).toContain("IMAGES_TOO_FEW");
    expect(issues({ images: good.images.slice(0, 2), imageExceptionBy: "user_1" })).not.toContain(
      "IMAGES_TOO_FEW",
    );
    expect(issues({ kind: "accessory", images: good.images.slice(0, 1), sizeChartId: null })).not.toContain(
      "IMAGES_TOO_FEW",
    );
  });
  it("liệt kê mọi lỗi", () => {
    const r = issues({
      title: " ",
      description: null,
      sizeChartId: null,
      images: [{ url: "x", alt: "", color: null }],
      variants: [
        { sku: "", color: "den", size: "m", price: null },
        { sku: "A", color: null, size: "m", price: 0 },
        { sku: "A", color: null, size: "m", price: 1.5 },
      ],
    });
    expect(r).toEqual(
      expect.arrayContaining([
        "TITLE_MISSING",
        "DESCRIPTION_MISSING",
        "SKU_MISSING",
        "SKU_DUPLICATE",
        "OPTION_MISSING",
        "VARIANT_DUPLICATE",
        "PRICE_MISSING",
        "PRICE_INVALID",
        "IMAGES_TOO_FEW",
        "IMAGE_ALT_MISSING",
        "COLOR_WITHOUT_IMAGE",
        "SIZE_CHART_MISSING",
      ]),
    );
    expect(issues({ variants: [] })).toContain("NO_VARIANTS");
  });
});

describe("CSV RFC 4180", () => {
  it("ngoặc kép, dấu phẩy và xuống dòng trong ô, BOM, CRLF", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","dòng 1\ndòng 2"\r\n"có ""ngoặc"""\n')).toEqual([
      ["a", "b"],
      ["x, y", "dòng 1\ndòng 2"],
      ['có "ngoặc"'],
    ]);
    expect(parseCsv("")).toEqual([]);
    expect(() => parseCsv('"mở')).toThrow(/chưa đóng/);
    expect(() => parseCsv("a\nb\nc\n", 1)).toThrow(/vượt/);
  });
  it("export chống công thức + round-trip", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 4 }), { maxLength: 5 }),
        (rows) => {
          const safe = rows.map((r) => r.map((c) => c.replace(/^[=+\-@\t\r]/, "x")));
          return (
            JSON.stringify(parseCsv(toCsv(safe))) ===
            JSON.stringify(safe.filter((r) => !(r.length === 1 && r[0] === "")))
          );
        },
      ),
    );
  });
});

describe("validateImport — S-206", () => {
  const header = "handle,title,kind,category,material,description,sku,color,size,price,stock";
  it("dòng hợp lệ được chuẩn hóa; lỗi nêu dòng + cột; không ghi gì", () => {
    const csv = [
      header,
      "Áo Sơ Mi,Áo sơ mi lụa,apparel,Áo,Lụa,Mô tả,sm-den-m,Đen,M,700.000,5",
      "ao-so-mi,Áo sơ mi lụa,apparel,ao,,,,trang,s,300000,",
      "ao-2,=HYPERLINK(1),apparel,ao,,,X-1,den,,abc,-1",
      "tui,Túi,accessory,phu-kien,,,SM-DEN-M,,,100000,",
    ].join("\n");
    const { rows, errors } = validateImport(csv);
    expect(rows).toEqual([
      {
        line: 2,
        handle: "ao-so-mi",
        title: "Áo sơ mi lụa",
        kind: "apparel",
        category: "ao",
        material: "lua",
        description: "Mô tả",
        sku: "SM-DEN-M",
        color: "den",
        size: "m",
        price: 700_000,
        stock: 5,
      },
    ]);
    expect(errors).toEqual(
      expect.arrayContaining([
        { line: 3, column: "sku", message: expect.any(String) },
        { line: 4, column: "title", message: expect.stringContaining("=") },
        { line: 4, column: "price", message: expect.any(String) },
        { line: 4, column: "stock", message: expect.any(String) },
        { line: 4, column: "color,size", message: expect.any(String) },
        { line: 5, column: "sku", message: "Trùng với dòng 2" },
      ]),
    );
  });
  it("thiếu cột, kind sai, category rỗng, CSV hỏng", () => {
    expect(validateImport("handle,title\nx,y").errors[0]).toMatchObject({ line: 1, message: "Thiếu cột" });
    const r = validateImport(`${header}\n,T,shirt,,,,A1,den,m,1,`);
    expect(r.errors.map((e) => e.column)).toEqual(expect.arrayContaining(["handle", "kind", "category"]));
    expect(validateImport('"x').errors[0]?.line).toBe(0);
    const long = validateImport(`${header}\nh,${"t".repeat(300)},accessory,c,,,A2,,,1,`);
    expect(long.errors[0]).toMatchObject({ column: "title" });
  });
});
