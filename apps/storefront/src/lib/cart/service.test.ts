// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resetEnvCacheForTests } from "../env";

interface CookieRec {
  value: string;
  options?: Record<string, unknown>;
}
const jar = vi.hoisted(() => new Map<string, { value: string; options?: Record<string, unknown> }>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)!.value } : undefined),
    set: (n: string, value: string, options?: Record<string, unknown>) => void jar.set(n, { value, options }),
    delete: (n: string) => void jar.delete(n),
  }),
}));

import {
  addItem,
  changeVariant,
  fetchRawCart,
  loadCartCount,
  loadCartView,
  refreshLinePrice,
  removeLine,
  resetCartServiceCacheForTests,
  setQuantity,
} from "./service";
import { isNonEmpty } from "../presence";

interface FxVariant {
  variant_id: string;
  price: number;
  in_stock: boolean;
}
interface FxProduct {
  handle: string;
  variants: FxVariant[];
}
const read = (rel: string): FxProduct =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const PRODUCT = read("../catalog/__fixtures__/backend/product.json");
const V = {
  denM: "variant_01M5QJKMDEVMP3WQ1YAD27G46V", // 700.000, còn hàng
  trangS: "variant_01M5QJKMDFGJN5FE8H4A05MMAE", // 300.000, còn hàng
  denS: "variant_01M5QJKMDFXC6WWG2AQVS2V2ME", // hết hàng
  trangM: "variant_01M5QJKMDGGR5YCAQCSY05FX0D", // 350.000
};

interface Line {
  id: string;
  variant_id: string;
  quantity: number;
  unit_price: number;
}

/** Backend giả có trạng thái: đủ /store/regions, /store/carts*, line-items, /store/x/products/:handle. */
class FakeBackend {
  carts = new Map<string, { id: string; completed_at: string | null; items: Line[] }>();
  log: string[] = [];
  product: FxProduct = structuredClone(PRODUCT);
  productStatus = 200;
  catalogDown = false;
  cartDown = false;
  seq = 0;

  price(variantId: string): number {
    return this.product.variants.find((v: FxVariant) => v.variant_id === variantId)?.price ?? 0;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body != null && init.body !== "" ? JSON.parse(String(init.body)) : undefined;
    this.log.push(`${method} ${url.pathname}`);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    const p = url.pathname;
    if (p === "/store/regions") return json({ regions: [{ id: "reg_VN", currency_code: "vnd" }] });
    if (p === `/store/x/products/${PRODUCT.handle}`) {
      if (this.catalogDown) return new Response("boom", { status: 503 });
      return this.productStatus === 200
        ? json(this.product)
        : json({ code: "NOT_FOUND" }, this.productStatus);
    }
    if (this.cartDown && p.startsWith("/store/carts")) return new Response("boom", { status: 503 });
    if (p === "/store/carts" && method === "POST") {
      const id = `cart_FAKE${String(++this.seq).padStart(10, "0")}`;
      this.carts.set(id, { id, completed_at: null, items: [] });
      return json({ cart: this.view(id) });
    }
    const m = /^\/store\/carts\/([^/]+)(?:\/line-items(?:\/([^/]+))?)?$/.exec(p);
    if (!m) return json({ message: "no route" }, 404);
    const cart = this.carts.get(m[1]!);
    if (!cart) return json({ type: "not_found", message: "Cart not found" }, 404);
    const isLine = p.includes("/line-items");
    if (!isLine) return json({ cart: this.view(cart.id) });
    if (method === "POST" && !isNonEmpty(m[2])) {
      const v = this.product.variants.find((x: FxVariant) => x.variant_id === body.variant_id);
      if (!v || !v.in_stock) {
        return json(
          {
            code: "insufficient_inventory",
            type: "not_allowed",
            message: "Some variant does not have the required inventory",
          },
          400,
        );
      }
      const ex = cart.items.find((i) => i.variant_id === body.variant_id);
      if (ex) ex.quantity += body.quantity;
      else
        cart.items.push({
          id: `cali_${++this.seq}`,
          variant_id: body.variant_id,
          quantity: body.quantity,
          unit_price: v.price,
        });
      return json({ cart: this.view(cart.id) });
    }
    const line = cart.items.find((i) => i.id === m[2]);
    if (!line) return json({ type: "not_found", message: "line not found" }, 404);
    if (method === "POST") {
      line.quantity = body.quantity;
      return json({ cart: this.view(cart.id) });
    }
    cart.items = cart.items.filter((i) => i.id !== line.id);
    return json({ id: line.id, deleted: true, parent: this.view(cart.id) });
  };

  view(id: string) {
    const c = this.carts.get(id)!;
    const items = c.items.map((i) => ({
      id: i.id,
      title: "Áo sơ mi lụa",
      product_title: "Áo sơ mi lụa",
      thumbnail: "/static/demo/den.svg?view=front",
      quantity: i.quantity,
      variant_id: i.variant_id,
      product_handle: PRODUCT.handle,
      variant_title: "x",
      unit_price: i.unit_price,
      total: i.unit_price * i.quantity,
    }));
    const sum = items.reduce((s, i) => s + i.total, 0);
    return {
      id,
      currency_code: "vnd",
      completed_at: c.completed_at,
      item_subtotal: sum,
      subtotal: sum,
      total: sum,
      items,
    };
  }

  seed(items: { variant: string; qty: number; price?: number }[]): string {
    const id = `cart_SEED${String(++this.seq).padStart(10, "0")}`;
    this.carts.set(id, {
      id,
      completed_at: null,
      items: items.map((i) => ({
        id: `cali_${++this.seq}`,
        variant_id: i.variant,
        quantity: i.qty,
        unit_price: i.price ?? this.price(i.variant),
      })),
    });
    jar.set("xs_cart", { value: id });
    return id;
  }

  mutations(): string[] {
    return this.log.filter((l) => l.startsWith("POST /store/carts/") || l.startsWith("DELETE"));
  }
}

let be: FakeBackend;
const saved = { ...process.env };

beforeEach(() => {
  jar.clear();
  be = new FakeBackend();
  vi.stubGlobal("fetch", be.fetch);
  process.env.XS_DATA_SOURCE = "backend";
  process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
  process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = "pk_test";
  resetEnvCacheForTests();
  resetCartServiceCacheForTests();
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
  resetEnvCacheForTests();
});

const cookie = (): CookieRec | undefined => jar.get("xs_cart");

describe("addItem (PDP → giỏ)", () => {
  it("giỏ mới: tạo qua Store API, ghi cookie HttpOnly/SameSite=Lax, thêm dòng, trả số lượng + câu 'Đã thêm …'", async () => {
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 });
    expect(r).toEqual({ ok: true, count: 1, message: "Đã thêm Áo sơ mi lụa (Đen, M) vào giỏ." });
    expect(cookie()?.value).toMatch(/^cart_FAKE/);
    expect(cookie()?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(cookie()?.options?.secure).toBe(false); // không phải production
    expect(be.log).toContain("POST /store/carts");
  });

  it("Secure bật ở production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://shop.test");
    resetEnvCacheForTests();
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 });
    expect(r.ok).toBe(true);
    expect(cookie()?.options?.secure).toBe(true);
    vi.unstubAllEnvs();
  });

  it("thêm lần hai cùng biến thể dùng lại giỏ cũ (không tạo giỏ mới), số lượng cộng dồn", async () => {
    await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 });
    const first = cookie()!.value;
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 2 });
    expect(r).toMatchObject({ ok: true, count: 3 });
    expect(cookie()!.value).toBe(first);
    expect(be.log.filter((l) => l === "POST /store/carts")).toHaveLength(1);
  });

  it("cookie trỏ giỏ không còn tồn tại → tạo giỏ mới thay vì lỗi", async () => {
    jar.set("xs_cart", { value: "cart_GONE000000000" });
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.trangS, quantity: 1 });
    expect(r.ok).toBe(true);
    expect(cookie()!.value).toMatch(/^cart_FAKE/);
  });

  it("cookie sai hình dạng bị bỏ qua, không bao giờ đi tới backend", async () => {
    jar.set("xs_cart", { value: "../../admin" });
    await addItem({ handle: "ao-so-mi-lua", variantId: V.trangS, quantity: 1 });
    expect(be.log.some((l) => l.includes("admin"))).toBe(false);
  });

  it.each([
    ["variantId rỗng", { handle: "ao-so-mi-lua", variantId: "", quantity: 1 }],
    ["số lượng 0", { handle: "ao-so-mi-lua", variantId: V.denM, quantity: 0 }],
    ["số lượng 11", { handle: "ao-so-mi-lua", variantId: V.denM, quantity: 11 }],
    ["số lượng thập phân", { handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1.5 }],
    ["handle có '/'", { handle: "a/b", variantId: V.denM, quantity: 1 }],
    ["thiếu hẳn", undefined as never],
  ])("đầu vào sai (%s) → INVALID_INPUT, không gọi mạng", async (_n, input) => {
    const r = await addItem(input);
    expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(be.log).toEqual([]);
  });

  it("biến thể hết hàng bị chặn Ở SERVER trước khi ghi giỏ", async () => {
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.denS, quantity: 1 });
    expect(r).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    expect(be.mutations()).toEqual([]);
    expect(cookie()).toBeUndefined();
  });

  it("biến thể không thuộc sản phẩm → INVALID_INPUT; sản phẩm đã ẩn (404) → NOT_FOUND", async () => {
    expect(await addItem({ handle: "ao-so-mi-lua", variantId: "variant_other", quantity: 1 })).toMatchObject({
      ok: false,
      code: "INVALID_INPUT",
    });
    be.productStatus = 404;
    expect(await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 })).toMatchObject({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(be.mutations()).toEqual([]);
  });

  it("catalog hoặc giỏ lỗi 5xx → UNAVAILABLE (không lộ chi tiết)", async () => {
    be.catalogDown = true;
    expect(await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 })).toMatchObject({
      ok: false,
      code: "UNAVAILABLE",
    });
    be.catalogDown = false;
    be.cartDown = true;
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 });
    expect(r).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });

  it("giới hạn 99/dòng (cộng dồn) và 50 dòng", async () => {
    be.seed([{ variant: V.denM, qty: 95 }]);
    expect(await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 5 })).toMatchObject({
      ok: false,
      code: "LIMIT",
    });
    expect(await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 4 })).toMatchObject({
      ok: true,
    });
    const full = be.seed(
      Array.from({ length: 50 }, (_, i) => ({
        variant: i === 0 ? V.denM : `variant_x${i}`,
        qty: 1,
        price: 1,
      })),
    );
    expect(be.carts.get(full)!.items).toHaveLength(50);
    expect(await addItem({ handle: "ao-so-mi-lua", variantId: V.trangS, quantity: 1 })).toMatchObject({
      ok: false,
      code: "LIMIT",
    });
  });

  it("backend từ chối vì tồn kho (400 insufficient_inventory) → OUT_OF_STOCK dễ hiểu", async () => {
    const orig = be.fetch;
    vi.stubGlobal("fetch", async (i: string, init?: RequestInit) => {
      if (init?.method === "POST" && String(i).endsWith("/line-items")) {
        return new Response(
          JSON.stringify({
            code: "insufficient_inventory",
            message: "Some variant does not have the required inventory",
          }),
          { status: 400 },
        );
      }
      return orig(i, init);
    });
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 });
    expect(r).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
  });

  it("backend tắt (XS_DATA_SOURCE=fixtures) → CART_DISABLED rõ ràng, không gọi mạng", async () => {
    process.env.XS_DATA_SOURCE = "fixtures";
    resetEnvCacheForTests();
    const r = await addItem({ handle: "ao-so-mi-lua", variantId: V.denM, quantity: 1 });
    expect(r).toMatchObject({ ok: false, code: "CART_DISABLED" });
    expect(be.log).toEqual([]);
  });
});

describe("sửa dòng giỏ", () => {
  it("setQuantity: đổi số lượng; ngoài 1..99 hoặc không nguyên → INVALID_INPUT", async () => {
    be.seed([{ variant: V.denM, qty: 1 }]);
    const lineId = [...be.carts.values()][0]!.items[0]!.id;
    expect(await setQuantity(lineId, 4)).toMatchObject({ ok: true, count: 4 });
    for (const q of [0, -1, 100, 2.5, Number.NaN]) {
      expect(await setQuantity(lineId, q)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
  });

  it("dòng không thuộc giỏ của phiên (id của giỏ khác) → NOT_FOUND, không gọi DELETE/POST", async () => {
    const other = be.seed([{ variant: V.trangS, qty: 1 }]);
    const otherLine = be.carts.get(other)!.items[0]!.id;
    be.seed([{ variant: V.denM, qty: 1 }]); // phiên hiện tại trỏ giỏ này
    be.log = [];
    expect(await removeLine(otherLine)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await setQuantity(otherLine, 2)).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(be.mutations()).toEqual([]);
  });

  it("không có cookie giỏ → NOT_FOUND; lineId rác → INVALID_INPUT", async () => {
    expect(await removeLine("cali_1")).toMatchObject({ ok: false, code: "NOT_FOUND" });
    expect(await removeLine("a b/../c")).toMatchObject({ ok: false, code: "INVALID_INPUT" });
  });

  it("removeLine: xóa được cả dòng của sản phẩm đã ẩn (CHK01: lỗi không chặn xóa)", async () => {
    be.seed([
      { variant: V.denM, qty: 1 },
      { variant: V.trangS, qty: 1 },
    ]);
    be.productStatus = 404;
    const cart = [...be.carts.values()][0]!;
    const r = await removeLine(cart.items[0]!.id);
    expect(r).toMatchObject({ ok: true, count: 1 });
    expect(cart.items).toHaveLength(1);
  });

  it("changeVariant: thêm biến thể mới với số lượng cũ rồi gỡ dòng cũ", async () => {
    be.seed([{ variant: V.denM, qty: 2 }]);
    const cart = [...be.carts.values()][0]!;
    const r = await changeVariant(cart.items[0]!.id, V.trangM);
    expect(r).toMatchObject({ ok: true, count: 2 });
    expect(cart.items.map((i) => [i.variant_id, i.quantity])).toEqual([[V.trangM, 2]]);
    const mut = be.mutations();
    expect(mut[0]).toMatch(/POST .*line-items$/);
    expect(mut[1]).toMatch(/^DELETE/);
  });

  it("changeVariant sang biến thể hết hàng: dòng cũ còn nguyên, không có DELETE", async () => {
    be.seed([{ variant: V.denM, qty: 2 }]);
    const cart = [...be.carts.values()][0]!;
    const r = await changeVariant(cart.items[0]!.id, V.denS);
    expect(r).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    expect(cart.items.map((i) => i.variant_id)).toEqual([V.denM]);
    expect(be.log.some((l) => l.startsWith("DELETE"))).toBe(false);
  });

  it("changeVariant sang biến thể đã có dòng khác: gộp số lượng, vượt 99 → LIMIT", async () => {
    be.seed([
      { variant: V.denM, qty: 60 },
      { variant: V.trangM, qty: 50 },
    ]);
    const cart = [...be.carts.values()][0]!;
    expect(await changeVariant(cart.items[0]!.id, V.trangM)).toMatchObject({ ok: false, code: "LIMIT" });
    expect(cart.items).toHaveLength(2);
  });

  it("changeVariant cùng biến thể: không làm gì", async () => {
    be.seed([{ variant: V.denM, qty: 1 }]);
    const cart = [...be.carts.values()][0]!;
    be.log = [];
    expect(await changeVariant(cart.items[0]!.id, V.denM)).toMatchObject({ ok: true });
    expect(be.mutations()).toEqual([]);
  });

  it("refreshLinePrice: cập nhật về giá hiện hành, giữ số lượng", async () => {
    be.seed([{ variant: V.denM, qty: 3, price: 650000 }]);
    const cart = [...be.carts.values()][0]!;
    expect(await refreshLinePrice(cart.items[0]!.id)).toMatchObject({ ok: true, count: 3 });
    expect(cart.items[0]).toMatchObject({ variant_id: V.denM, quantity: 3, unit_price: 700000 });
  });

  it("refreshLinePrice khi biến thể đã hết hàng: không gỡ dòng", async () => {
    be.seed([{ variant: V.denS, qty: 1, price: 1 }]);
    const cart = [...be.carts.values()][0]!;
    expect(await refreshLinePrice(cart.items[0]!.id)).toMatchObject({ ok: false, code: "OUT_OF_STOCK" });
    expect(cart.items).toHaveLength(1);
  });
});

describe("đọc giỏ", () => {
  it("không cookie / backend tắt → giỏ rỗng, không gọi mạng", async () => {
    expect((await loadCartView()).lines).toEqual([]);
    expect(await loadCartCount()).toBe(0);
    expect(be.log).toEqual([]);
  });

  it("CHK01: giá đổi + hết hàng ở 2 dòng, dòng thứ 3 bình thường vẫn còn; chặn thanh toán; tổng từ server", async () => {
    be.seed([
      { variant: V.denM, qty: 1, price: 650000 }, // giá đổi
      { variant: V.denS, qty: 1, price: 650000 }, // hết hàng
      { variant: V.trangS, qty: 2 },
    ]);
    const v = await loadCartView();
    expect(v.lines.map((l) => l.issue?.code ?? null)).toEqual(["PRICE_CHANGED", "OUT_OF_STOCK", null]);
    expect(v.blocked).toBe(true);
    expect(v.subtotal).toBe(650000 + 650000 + 600000);
    expect(v.itemCount).toBe(4);
  });

  it("catalog lỗi khi đọc giỏ: vẫn hiện giỏ, không bịa lỗi dòng", async () => {
    be.seed([{ variant: V.denM, qty: 1 }]);
    be.catalogDown = true;
    const v = await loadCartView();
    expect(v.lines).toHaveLength(1);
    expect(v.blocked).toBe(false);
  });

  it("badge: nuốt lỗi mạng → 0; giỏ đã hoàn tất → rỗng", async () => {
    const id = be.seed([{ variant: V.denM, qty: 2 }]);
    expect(await loadCartCount()).toBe(2);
    be.cartDown = true;
    expect(await loadCartCount()).toBe(0);
    be.cartDown = false;
    be.carts.get(id)!.completed_at = "2026-10-24T00:00:00Z";
    expect(await fetchRawCart(id)).toBeNull();
  });
});

describe("không lưu giỏ/PII ở localStorage (S-504)", () => {
  it("mã nguồn giỏ/checkout không dùng localStorage", () => {
    const dirs = ["../cart", "../../components/cart", "../checkout", "../../components/checkout"];
    for (const d of dirs) {
      const dir = fileURLToPath(new URL(`${d}/`, import.meta.url));
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => /\.(ts|tsx)$/.test(x) && !/\.test\./.test(x))) {
        expect(readFileSync(`${dir}/${f}`, "utf8"), `${d}/${f}`).not.toMatch(/localStorage\s*[.[]/);
      }
    }
  });
});
