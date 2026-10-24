// @vitest-environment node
import { FIXTURE_PRODUCTS } from "../../lib/catalog/fixtures";
import type { ProductDetail } from "../../lib/catalog/types";
import {
  colorInStock,
  ctaFor,
  findVariant,
  galleryFor,
  initialSelection,
  modelFor,
  priceFor,
  selectColor,
  sizeOptionsFor,
  variantQuery,
} from "./selection";

const product = (handle: string): ProductDetail => FIXTURE_PRODUCTS.find((p) => p.handle === handle)!;
const SML = product("ao-so-mi-lua"); // chỉ đen-S + trắng-M (AT02)
const KKM = product("ao-khoac-kaki-mong"); // đen-M 700.000, trắng-S 300.000 (AT31)
const OXF = product("ao-so-mi-oxford"); // xanh navy-L hết hàng
const QTD = product("quan-tay-ong-dung"); // hết hàng toàn bộ
const TCT = product("ao-thun-cotton-co-tron"); // giảm giá
const POL = product("ao-polo-pique"); // giá khác nhau theo size

describe("initialSelection — ?color=&size= mở đúng biến thể (product)", () => {
  it("màu + size hợp lệ → đúng biến thể; không phân biệt hoa/thường; mảng lấy phần tử đầu", () => {
    expect(initialSelection(SML, { color: "trang", size: "m" })).toEqual({ color: "trang", size: "m" });
    expect(initialSelection(SML, { color: "TRANG", size: "M" })).toEqual({ color: "trang", size: "m" });
    expect(initialSelection(SML, { color: ["trang", "den"], size: ["m"] })).toEqual({
      color: "trang",
      size: "m",
    });
  });

  it("không có tham số → màu đầu tiên CÒN HÀNG, chưa chọn size (không đoán size)", () => {
    expect(initialSelection(SML)).toEqual({ color: "den", size: null });
    expect(initialSelection(QTD)).toEqual({ color: "den", size: null }); // hết sạch → màu đầu
  });

  it("màu lạ → màu mặc định; tổ hợp không tồn tại (trắng-S) → bỏ size, giữ màu", () => {
    expect(initialSelection(SML, { color: "tim", size: "m" })).toEqual({ color: "den", size: null });
    expect(initialSelection(SML, { color: "trang", size: "s" })).toEqual({ color: "trang", size: null });
    expect(initialSelection(SML, { color: "", size: "" })).toEqual({ color: "den", size: null });
  });

  it("biến thể hết hàng vẫn mở đúng (để CTA báo 'Hết hàng')", () => {
    expect(initialSelection(OXF, { color: "xanh-navy", size: "l" })).toEqual({
      color: "xanh-navy",
      size: "l",
    });
  });

  it("đầu vào độc hại không ném lỗi", () => {
    expect(() => initialSelection(SML, { color: "<script>", size: "../../" })).not.toThrow();
    expect(initialSelection(SML, { size: "m" })).toEqual({ color: "den", size: null });
  });
});

describe("selectColor — AT02/S-501 đổi màu mà size không tồn tại (product)", () => {
  it("đen-S → trắng (chỉ có M): bỏ size, thông báo đúng câu, KHÔNG tự chọn M", () => {
    const r = selectColor(SML, { color: "den", size: "s" }, "trang");
    expect(r.selection).toEqual({ color: "trang", size: null });
    expect(r.notice).toBe("Màu Trắng không có size S — vui lòng chọn lại size");
    expect(ctaFor(SML, r.selection).label).toBe("Chọn size");
  });

  it("size có và còn hàng ở màu mới → giữ nguyên, không thông báo", () => {
    expect(selectColor(OXF, { color: "den", size: "m" }, "trang")).toEqual({
      selection: { color: "trang", size: "m" },
      notice: null,
    });
  });

  it("size có nhưng hết hàng ở màu mới → bỏ size với thông báo 'hết hàng'", () => {
    const r = selectColor(OXF, { color: "trang", size: "l" }, "xanh-navy");
    expect(r.selection).toEqual({ color: "xanh-navy", size: null });
    expect(r.notice).toBe("Size L đã hết hàng ở màu Xanh navy — vui lòng chọn lại size");
  });

  it("chưa chọn size → đổi màu không thông báo", () => {
    expect(selectColor(SML, { color: "den", size: null }, "trang")).toEqual({
      selection: { color: "trang", size: null },
      notice: null,
    });
  });
});

describe("sizeOptionsFor / findVariant / colorInStock (product)", () => {
  it("nút size theo màu: chỉ size có SKU còn hàng là available", () => {
    expect(sizeOptionsFor(SML, "den").map((s) => [s.label, s.available])).toEqual([
      ["S", true],
      ["M", false],
    ]);
    expect(sizeOptionsFor(SML, "trang").map((s) => [s.label, s.available])).toEqual([
      ["S", false],
      ["M", true],
    ]);
    expect(sizeOptionsFor(OXF, "xanh-navy").find((s) => s.value === "l")?.available).toBe(false);
  });

  it("findVariant null khi thiếu màu/size hoặc tổ hợp không có", () => {
    expect(findVariant(SML, { color: "den", size: null })).toBeNull();
    expect(findVariant(SML, { color: "den", size: "m" })).toBeNull();
    expect(findVariant(SML, { color: "den", size: "s" })?.sku).toBe("SML-DEN-S");
  });

  it("colorInStock", () => {
    expect(colorInStock(QTD, "den")).toBe(false);
    expect(colorInStock(OXF, "xanh-navy")).toBe(true);
  });
});

describe("priceFor — giá theo SKU đang chọn (product)", () => {
  it("chọn đủ → giá của đúng SKU (AT31: đen-M 700.000, trắng-S 300.000)", () => {
    expect(priceFor(KKM, { color: "den", size: "m" })).toEqual({
      current: 700000,
      max: null,
      original: null,
    });
    expect(priceFor(KKM, { color: "trang", size: "s" })).toEqual({
      current: 300000,
      max: null,
      original: null,
    });
  });

  it("chưa chọn gì → khoảng giá toàn sản phẩm; chọn màu → khoảng của màu đó", () => {
    expect(priceFor(KKM, { color: null, size: null })).toEqual({
      current: 300000,
      max: 700000,
      original: null,
    });
    expect(priceFor(KKM, { color: "den", size: null })).toEqual({
      current: 700000,
      max: null,
      original: null,
    });
    expect(priceFor(POL, { color: "den", size: null })).toEqual({
      current: 350000,
      max: 380000,
      original: null,
    });
  });

  it("chọn size chưa chọn màu → khoảng giá theo size", () => {
    expect(priceFor(POL, { color: null, size: "l" })).toEqual({ current: 380000, max: null, original: null });
  });

  it("giá gốc (compare_at) đi theo SKU; không có SKU khớp thì dùng toàn bộ biến thể", () => {
    expect(priceFor(TCT, { color: "den", size: "m" })).toEqual({
      current: 290000,
      max: null,
      original: 390000,
    });
    expect(priceFor(SML, { color: "den", size: "m" }).current).toBe(700000);
  });
});

describe("ctaFor — CTA phản ánh đúng tình trạng (product)", () => {
  it("chưa có màu → 'Chọn màu'", () => {
    expect(ctaFor(SML, { color: null, size: null })).toMatchObject({
      kind: "choose-color",
      label: "Chọn màu",
    });
  });

  it("có màu chưa có size → 'Chọn size' (bấm được)", () => {
    expect(ctaFor(SML, { color: "den", size: null })).toMatchObject({
      kind: "choose-size",
      label: "Chọn size",
      disabled: false,
    });
  });

  it("đủ SKU còn hàng → 'Thêm vào giỏ' kèm variant", () => {
    const c = ctaFor(SML, { color: "den", size: "s" });
    expect(c).toMatchObject({ kind: "add", label: "Thêm vào giỏ", disabled: false });
    expect(c.variant?.variant_id).toBe("variant_sml_den_s");
  });

  it("SKU hết hàng → 'Hết hàng' (khóa); cả màu hết hàng mà chưa chọn size cũng 'Hết hàng'", () => {
    expect(ctaFor(OXF, { color: "xanh-navy", size: "l" })).toMatchObject({
      kind: "sold-out",
      label: "Hết hàng",
      disabled: true,
    });
    expect(ctaFor(QTD, { color: "den", size: null })).toMatchObject({ kind: "sold-out", disabled: true });
    expect(ctaFor(QTD, { color: "den", size: "m" })).toMatchObject({ kind: "sold-out", disabled: true });
  });

  it("tổ hợp không tồn tại (state lệch) → quay về 'Chọn size', không cho thêm", () => {
    expect(ctaFor(SML, { color: "trang", size: "s" }).kind).toBe("choose-size");
  });
});

describe("galleryFor / modelFor / variantQuery (product)", () => {
  it("ảnh theo màu: chỉ ảnh của màu đang chọn (+ ảnh dùng chung)", () => {
    const den = galleryFor(SML, "den");
    expect(den.length).toBe(3);
    expect(den.every((i) => i.color === "den")).toBe(true);
    expect(galleryFor(SML, "trang").every((i) => i.color === "trang")).toBe(true);
  });

  it("màu không có ảnh riêng → hiện toàn bộ ảnh (không gallery rỗng); ảnh dùng chung đi theo mọi màu", () => {
    expect(galleryFor(SML, "khong-co")).toHaveLength(SML.images.length);
    const shared = { ...SML, images: [{ ...SML.images[0]!, color: null }, ...SML.images] };
    expect(galleryFor(shared, "trang")[0]!.color).toBeNull();
  });

  it("số đo người mẫu gắn với bộ ảnh của màu; màu khác không có → null (không bịa)", () => {
    expect(modelFor(SML, "den")).toMatchObject({ height_cm: 168, wearing_size: "S" });
    expect(modelFor(SML, "trang")).toBeNull();
  });

  it("variantQuery chỉ gồm phần đã chọn", () => {
    expect(variantQuery({ color: "den", size: "m" })).toBe("color=den&size=m");
    expect(variantQuery({ color: "den", size: null })).toBe("color=den");
    expect(variantQuery({ color: null, size: null })).toBe("");
  });
});
