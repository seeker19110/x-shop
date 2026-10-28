// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapProduct } from "../catalog/backend-map";
import type { ProductDetail } from "../catalog/types";
import { buildCartView, issueFor, type RawCart } from "./view";

const read = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const BASE = "http://backend.test:9000";

/** Phản hồi THẬT của Medusa `GET /store/carts/:id?fields=…` (2 dòng: Đen/M ×2, Trắng/S ×1) + chi tiết sản phẩm thật. */
const rawCart = (read("./__fixtures__/cart.json") as { cart: RawCart }).cart;
const product = mapProduct(read("../catalog/__fixtures__/backend/product.json"), BASE) as ProductDetail;
const DEN_M = "variant_01M5QJKMDEVMP3WQ1YAD27G46V";
const DEN_S_OOS = "variant_01M5QJKMDFXC6WWG2AQVS2V2ME";

const lookup = (p: ProductDetail | null | undefined) => new Map([["ao-so-mi-lua", p]]);

describe("buildCartView (giỏ thật của Medusa)", () => {
  const view = buildCartView(rawCart, lookup(product), BASE);

  it("không mang id giỏ (bearer) sang dữ liệu cho Client Component", () => {
    expect(view).not.toHaveProperty("id");
    expect(JSON.stringify(view)).not.toContain(rawCart.id);
  });

  it("tạm tính và tổng số lượng lấy từ server; tiền nguyên", () => {
    expect(view.subtotal).toBe(rawCart.item_subtotal);
    expect(view.subtotal).toBe(1700000);
    expect(view.itemCount).toBe(3);
    expect(view.lines.map((l) => l.lineTotal)).toEqual([1400000, 300000]);
    expect(view.blocked).toBe(false);
    expect(view.lines.every((l) => l.issue === null)).toBe(true);
  });

  it("dòng có nhãn biến thể từ catalog, ảnh tuyệt đối, bộ chọn màu/size hiện tại", () => {
    const l = view.lines[0]!;
    expect(l.variantLabel).toBe("Đen / M");
    expect(l.thumbnail?.url).toBe(`${BASE}/static/demo/den.svg?view=front`);
    expect(l.choices?.color).toBe("den");
    expect(l.choices?.size).toBe("m");
    expect(l.handle).toBe("ao-so-mi-lua");
  });

  it("giỏ null/đã hoàn tất → rỗng, không chặn", () => {
    expect(buildCartView(null, lookup(product), BASE)).toMatchObject({ lines: [], blocked: false });
    expect(
      buildCartView({ ...rawCart, completed_at: "2026-10-24T00:00:00Z" }, lookup(product), BASE).lines,
    ).toEqual([]);
  });

  it("CHK01: lỗi MỘT dòng (sản phẩm bị ẩn) không làm mất dòng khác, chặn thanh toán", () => {
    const v = buildCartView(rawCart, lookup(null), BASE);
    expect(v.lines).toHaveLength(2);
    expect(v.lines.every((l) => l.issue?.code === "UNAVAILABLE")).toBe(true);
    expect(v.blocked).toBe(true);
    expect(v.subtotal).toBe(1700000);
  });

  it("không kiểm được catalog (undefined) → không bịa lỗi, không chặn (backend kiểm lại lúc đặt)", () => {
    const v = buildCartView(rawCart, lookup(undefined), BASE);
    expect(v.blocked).toBe(false);
    expect(v.lines[0]!.choices).toBeNull();
    expect(v.lines[0]!.variantLabel).toBe("Đen / M"); // rơi về variant_title của Medusa
  });

  it("dữ liệu số hỏng (âm, NaN, thiếu) → 0 thay vì ném lỗi", () => {
    const broken: RawCart = {
      id: "cart_X",
      items: [{ id: "li_1", quantity: -3, unit_price: "abc", total: null, product_title: "A" }],
    };
    const v = buildCartView(broken, new Map(), BASE);
    expect(v.lines[0]).toMatchObject({ quantity: 0, unitPrice: 0, lineTotal: 0, title: "A" });
    expect(v.subtotal).toBe(0);
  });
});

describe("issueFor (CHK01: ẩn → hết hàng → giá đổi)", () => {
  it("biến thể hết hàng", () => {
    expect(issueFor(DEN_S_OOS, 650000, product)?.code).toBe("OUT_OF_STOCK");
  });
  it("biến thể không còn trong sản phẩm", () => {
    expect(issueFor("variant_gone", 1, product)?.code).toBe("VARIANT_GONE");
  });
  it("giá đã đổi: nêu cả giá cũ và mới", () => {
    const i = issueFor(DEN_M, 650000, product);
    expect(i?.code).toBe("PRICE_CHANGED");
    expect(i?.message).toContain("650.000");
    expect(i?.message).toContain("700.000");
  });
  it("ưu tiên: hết hàng thắng giá đổi; ẩn thắng tất cả", () => {
    expect(issueFor(DEN_S_OOS, 1, product)?.code).toBe("OUT_OF_STOCK");
    expect(issueFor(DEN_M, 1, null)?.code).toBe("UNAVAILABLE");
  });
  it("bình thường → null", () => {
    expect(issueFor(DEN_M, 700000, product)).toBeNull();
  });
});
