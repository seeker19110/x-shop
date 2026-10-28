// @vitest-environment node
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { resetEnvCacheForTests } from "../env";
import { ENDPOINT_ALLOWLIST, type AccessKind } from "./endpoint-allowlist";

/**
 * T-176 — BE-AUTH-009, PRF-WEB-004 cho storefront.
 *  1. Kiểm liệt kê (tĩnh, AST TypeScript): mọi export của file "use server" và mọi phương thức của `app/**\/route.ts`
 *     phải có mục trong `endpoint-allowlist.ts` (kiểu quyền + lý do + file bằng chứng) và ngược lại.
 *  2. IDOR (chạy thật với backend giả có quyền sở hữu): id giỏ/đơn/attempt/dòng giỏ không khớp cookie của phiên → bị từ
 *     chối, KHÔNG ghi, kết quả giống hệt "không tồn tại"; id client chèn vào bị bỏ qua.
 */

/* ============================================================== mock Next (cookie theo phiên) */

type Jar = Map<string, { value: string; options?: Record<string, unknown> }>;
const state = vi.hoisted(() => ({
  jar: (): Jar => new Map(),
  cookieReads: 0,
}));
vi.mock("next/headers", () => ({
  cookies: async () => {
    state.cookieReads++;
    const jar = state.jar();
    return {
      get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)!.value } : undefined),
      set: (n: string, value: string, options?: Record<string, unknown>) =>
        void jar.set(n, { value, options }),
      delete: (n: string) => void jar.delete(n),
    };
  },
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

import {
  addToCart,
  changeLineVariant,
  forgetCart,
  refreshCartLine,
  removeCartLine,
  updateLineQuantity,
  type AddToCartInput,
} from "../cart/actions";
import { resetCartServiceCacheForTests } from "../cart/service";
import { finishCheckout, pollCheckout, quoteCheckout, submitCheckout } from "../checkout/actions";
import type { SubmitInput } from "../checkout/types";
import {
  cancelOrderAction,
  lookupOrderAction,
  recheckOrderAction,
  redeemLinkAction,
} from "../orders/actions";
import { fetchOrder } from "../orders/service";
import { GET as cartCountGET } from "../../app/api/cart/count/route";
import { GET as paymentReturnGET } from "../../app/(shop)/thanh-toan/ket-qua/route";
import { GET as wardsGET } from "../../app/api/address/wards/route";
import { GET as catalogCountGET } from "../../app/api/catalog/count/route";
import { GET as suggestGET } from "../../app/api/catalog/suggest/route";

interface Session {
  name: string;
  jar: Jar;
}
const als = new AsyncLocalStorage<Session>();
let defaultSession: Session = { name: "default", jar: new Map() };
state.jar = () => als.getStore()?.jar ?? defaultSession.jar;

const session = (name: string, cookies: Record<string, string> = {}): Session => ({
  name,
  jar: new Map(Object.entries(cookies).map(([k, v]) => [k, { value: v }])),
});
const as = <T>(s: Session, fn: () => Promise<T>): Promise<T> => als.run(s, fn);

/* ============================================================== 1. kiểm liệt kê tĩnh */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ROUTE_FILE = /^route\.(ts|tsx|js|jsx|mjs)$/;
const ACCESS_KINDS: readonly AccessKind[] = ["cart_cookie", "order_cookie", "link_token", "hmac", "public"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "__fixtures__") walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.(test|spec)\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const relOf = (abs: string) => relative(SRC, abs).split(sep).join("/");

function parse(file: string, src: string): ts.SourceFile {
  const kind = /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind);
}

/** Directive prologue (chuỗi đứng đầu khối/file) có "use server" không. */
function hasUseServer(statements: ts.NodeArray<ts.Statement>): boolean {
  for (const st of statements) {
    if (!ts.isExpressionStatement(st) || !ts.isStringLiteral(st.expression)) return false;
    if (st.expression.text === "use server") return true;
  }
  return false;
}

const hasMod = (n: ts.Node, k: ts.SyntaxKind) =>
  ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === k);

/** Tên các export có giá trị lúc chạy (bỏ type/interface); `*` = re-export không liệt kê được. */
function runtimeExports(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    const exported = hasMod(st, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasMod(st, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) {
      if (exported) out.push(isDefault ? "default" : (st.name?.text ?? "default"));
    } else if (ts.isEnumDeclaration(st)) {
      if (exported && !hasMod(st, ts.SyntaxKind.DeclareKeyword)) out.push(st.name.text);
    } else if (ts.isVariableStatement(st)) {
      if (!exported) continue;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.push(d.name.text);
        else out.push(`<destructure:${d.name.getText(sf)}>`);
      }
    } else if (ts.isExportAssignment(st)) {
      out.push("default");
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      if (!st.exportClause) out.push("*");
      else if (ts.isNamespaceExport(st.exportClause)) out.push(st.exportClause.name.text);
      else for (const el of st.exportClause.elements) if (!el.isTypeOnly) out.push(el.name.text);
    }
  }
  return out;
}

/** Mọi hàm/khối có "use server" riêng bên trong (Server Action inline) — số dòng. */
function inlineUseServer(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && "body" in n && n.body && ts.isBlock(n.body as ts.Node)) {
      if (hasUseServer((n.body as ts.Block).statements)) {
        lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  return lines;
}

interface Inventory {
  endpoints: Map<string, { file: string; kind: "action" | "route" }>;
  inline: string[];
  unenumerable: string[];
}

function inventory(): Inventory {
  const endpoints: Inventory["endpoints"] = new Map();
  const inline: string[] = [];
  const unenumerable: string[] = [];
  for (const abs of walk(SRC)) {
    const rel = relOf(abs);
    const src = readFileSync(abs, "utf8");
    const isRoute = rel.startsWith("app/") && ROUTE_FILE.test(rel.split("/").pop()!);
    if (!isRoute && !src.includes("use server")) continue;
    const sf = parse(abs, src);
    for (const line of inlineUseServer(sf)) inline.push(`${rel}:${line}`);
    if (hasUseServer(sf.statements)) {
      for (const name of runtimeExports(sf)) {
        if (name === "*" || name.startsWith("<")) unenumerable.push(`${rel}#${name}`);
        else endpoints.set(`${rel}#${name}`, { file: rel, kind: "action" });
      }
    }
    if (isRoute) {
      for (const name of runtimeExports(sf)) {
        if (name === "*" || name.startsWith("<")) unenumerable.push(`${rel}#${name}`);
        else if (HTTP_METHODS.has(name)) endpoints.set(`${rel}#${name}`, { file: rel, kind: "route" });
      }
    }
  }
  return { endpoints, inline, unenumerable };
}

/** `app/(shop)/thanh-toan/ket-qua/route.ts` → `/thanh-toan/ket-qua` (bỏ route group). */
function urlPathOf(rel: string): string {
  const segs = rel
    .split("/")
    .slice(1, -1)
    .filter((s) => !/^\(.*\)$/.test(s));
  return `/${segs.join("/")}`;
}

/** Bỏ chú thích để kiểm định danh trong mã (không trong comment). */
function codeOnly(abs: string): string {
  const src = readFileSync(abs, "utf8");
  let out = "";
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, src);
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    if (t === ts.SyntaxKind.SingleLineCommentTrivia || t === ts.SyntaxKind.MultiLineCommentTrivia) continue;
    out += scanner.getTokenText();
  }
  return out;
}

/** Các file đạt tới qua import tương đối (đồ thị phụ thuộc trong src). */
function importGraph(rootAbs: string): Set<string> {
  const seen = new Set<string>();
  const stack = [rootAbs];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.[^"']*)["']/g)) {
      const base = resolve(dirname(file), m[1]!);
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const p = base + ext;
        if (existsSync(p) && statSync(p).isFile()) {
          stack.push(p);
          break;
        }
      }
    }
  }
  return seen;
}

describe("kiểm liệt kê Server Action + route handler (BE-AUTH-009, PRF-WEB-004)", () => {
  const inv = inventory();
  const declared = Object.keys(ENDPOINT_ALLOWLIST);

  it("bộ quét thấy endpoint thật (không rỗng: ≥ 10 action, ≥ 5 route)", () => {
    const kinds = [...inv.endpoints.values()].map((e) => e.kind);
    expect(kinds.filter((k) => k === "action").length).toBeGreaterThanOrEqual(10);
    expect(kinds.filter((k) => k === "route").length).toBeGreaterThanOrEqual(5);
  });

  it("mọi Server Action / phương thức route đều có mục trong allowlist", () => {
    const missing = [...inv.endpoints.keys()].filter((k) => !(k in ENDPOINT_ALLOWLIST));
    expect(missing, "endpoint chưa khai quyền ở lib/security/endpoint-allowlist.ts").toEqual([]);
  });

  it("mục allowlist không còn trong mã → đỏ (không để danh mục mục nát)", () => {
    const stale = declared.filter((k) => !inv.endpoints.has(k));
    expect(stale, "mục allowlist không còn endpoint tương ứng").toEqual([]);
  });

  it("không có Server Action inline hay export không liệt kê được (`export *`, destructure)", () => {
    expect(inv.inline, 'đặt Server Action trong file lib/**/actions.ts có "use server" ở đầu').toEqual([]);
    expect(inv.unenumerable).toEqual([]);
  });

  it("mỗi mục: kiểu quyền hợp lệ, lý do đủ dài, file bằng chứng tồn tại và nhắc tới endpoint", () => {
    for (const [key, e] of Object.entries(ENDPOINT_ALLOWLIST)) {
      const [file, name] = key.split("#") as [string, string];
      expect(e.access.length, key).toBeGreaterThan(0);
      for (const a of e.access) expect(ACCESS_KINDS, key).toContain(a);
      expect(e.reason.trim().length, key).toBeGreaterThanOrEqual(20);
      const proofAbs = join(SRC, e.proof);
      expect(existsSync(proofAbs), `${key}: thiếu ${e.proof}`).toBe(true);
      const proof = readFileSync(proofAbs, "utf8");
      const needle =
        HTTP_METHODS.has(name) && ROUTE_FILE.test(file.split("/").pop()!) ? urlPathOf(file) : name;
      expect(proof.includes(needle), `${key}: ${e.proof} không nhắc "${needle}"`).toBe(true);
    }
  });

  it("id sở hữu không nhận từ client: action/route không có định danh cart_id/order_id/user_id/customer_id", () => {
    const OWNER_ID = /\b(cart_?id|order_?id|user_?id|customer_?id)\b/i;
    const files = new Set([...inv.endpoints.values()].map((e) => e.file));
    const offenders = [...files].filter((f) => OWNER_ID.test(codeOnly(join(SRC, f))));
    expect(offenders).toEqual([]);
  });

  it("route công khai không đọc cookie (kể cả qua module nó import)", () => {
    const COOKIE_IMPORT = /import\s*\{[^}]*\bcookies\b[^}]*\}\s*from\s*["']next\/headers["']/;
    for (const [key, e] of Object.entries(ENDPOINT_ALLOWLIST)) {
      const file = key.split("#")[0]!;
      if (!(e.access.length === 1 && e.access[0] === "public") || !file.startsWith("app/")) continue;
      const reached = [...importGraph(join(SRC, file))].filter((f) =>
        COOKIE_IMPORT.test(readFileSync(f, "utf8")),
      );
      expect(reached.map(relOf), key).toEqual([]);
    }
  });
});

describe("bộ quét tự kiểm (endpoint mới không khai sẽ bị bắt)", () => {
  const exportsOf = (src: string) => runtimeExports(parse("x.ts", src));

  it("liệt kê đủ kiểu export, bỏ type/interface", () => {
    const src = [
      "/** chú thích */",
      '"use server";',
      "export async function a() {}",
      "export const b = async () => {};",
      "const c = async () => {};",
      "export { c as d };",
      "export type T = { x: 1 };",
      "export interface I { y: 2 }",
      "export type { I as J };",
      "export default async function () {}",
    ].join("\n");
    expect(hasUseServer(parse("x.ts", src).statements)).toBe(true);
    expect(exportsOf(src)).toEqual(["a", "b", "d", "default"]);
    expect(exportsOf('export * from "./x";')).toEqual(["*"]);
    expect(exportsOf("export const { e, f } = g;")).toEqual(["<destructure:{ e, f }>"]);
  });

  it('"use server" chỉ tính khi là directive (đầu file/khối), không tính chuỗi thường', () => {
    expect(hasUseServer(parse("x.ts", '"use client";\nexport const a = 1;').statements)).toBe(false);
    expect(
      hasUseServer(parse("x.ts", 'const s = "use server";\nexport async function a() {}').statements),
    ).toBe(false);
    expect(hasUseServer(parse("x.ts", '"use strict";\n"use server";\n').statements)).toBe(true);
  });

  it("phát hiện Server Action inline trong component", () => {
    const src = [
      "export default function Page() {",
      "  async function act(form: FormData) {",
      '    "use server";',
      "  }",
      "  const act2 = async () => {",
      "    'use server';",
      "  };",
      "  return null;",
      "}",
    ].join("\n");
    expect(inlineUseServer(parse("x.tsx", src))).toEqual([2, 5]);
  });

  it("đường URL của route bỏ route group", () => {
    expect(urlPathOf("app/(shop)/thanh-toan/ket-qua/route.ts")).toBe("/thanh-toan/ket-qua");
    expect(urlPathOf("app/api/cart/count/route.ts")).toBe("/api/cart/count");
    expect(urlPathOf("app/route.ts")).toBe("/");
  });
});

/* ============================================================== 2. IDOR với backend giả có quyền sở hữu */

const PRODUCT = JSON.parse(
  readFileSync(join(SRC, "lib/catalog/__fixtures__/backend/product.json"), "utf8"),
) as { handle: string; variants: { variant_id: string; price: number; in_stock: boolean }[] };
const QUOTE = JSON.parse(readFileSync(join(SRC, "lib/checkout/__fixtures__/quote.json"), "utf8")) as {
  quote: Record<string, unknown>;
};
const V_DEN_M = "variant_01M5QJKMDEVMP3WQ1YAD27G46V";
const V_TRANG_S = "variant_01M5QJKMDFGJN5FE8H4A05MMAE";

const CART_A = "cart_AAAAAAAAAAAA000001";
const CART_B = "cart_BBBBBBBBBBBB000002";
const LINE_A = "cali_A000000000001";
const LINE_B = "cali_B000000000002";
const ATT_A = "chk_AAAAAAAAAAAA0001";
const ATT_B = "chk_BBBBBBBBBBBB0002";
const REF_A = "XS-AAAA11";
const REF_B = "XS-BBBB22";
const TOKEN_A = "dG9rZW5BQUFBQQ.aaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "dG9rZW5CQkJCQg.bbbbbbbbbbbbbbbbbbbbbbbb";
const LOOKUP_MESSAGE = "Nếu thông tin đúng, chúng tôi đã gửi liên kết xem đơn.";

interface Call {
  session: string;
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

/** Backend giả: giỏ/đơn/attempt có chủ; sai chủ → 404 như không tồn tại (đúng hợp đồng backend, BE-AUTH-010). */
class OwnedBackend {
  calls: Call[] = [];
  seq = 0;
  carts = new Map<string, { id: string; items: { id: string; variant_id: string; quantity: number }[] }>();
  attempts = new Map<string, { cart: string; ref: string; token: string }>();
  orderTokens = new Map<string, string>(); // token → mã đơn
  orders = new Map<string, { state: string }>();
  links = new Map<string, { status: number; ref?: string; token?: string }>();
  delayMs = 0;

  constructor() {
    this.carts.set(CART_A, { id: CART_A, items: [{ id: LINE_A, variant_id: V_DEN_M, quantity: 1 }] });
    this.carts.set(CART_B, { id: CART_B, items: [{ id: LINE_B, variant_id: V_DEN_M, quantity: 5 }] });
    this.attempts.set(ATT_A, { cart: CART_A, ref: REF_A, token: TOKEN_A });
    this.attempts.set(ATT_B, { cart: CART_B, ref: REF_B, token: TOKEN_B });
    this.orderTokens.set(TOKEN_A, REF_A);
    this.orderTokens.set(TOKEN_B, REF_B);
    this.orders.set(REF_A, { state: "placed" });
    this.orders.set(REF_B, { state: "placed" });
    this.links.set("link-ok-A", { status: 200, ref: REF_A, token: TOKEN_A });
    this.links.set("link-evil-ref", { status: 200, ref: "../admin", token: TOKEN_A });
    this.links.set("link-used", { status: 410 });
    this.links.set("link-forged", { status: 404 });
    this.links.set("link-401", { status: 401 });
    this.links.set("link-500", { status: 500 });
  }

  orderBody(ref: string) {
    return {
      display_ref: ref,
      state: this.orders.get(ref)!.state,
      payment_method: "cod",
      payment_state: "cod",
      shipment_state: "unfulfilled",
      created_at: "2026-10-24T10:00:00.000Z",
      hold_expires_at: null,
      cod_confirm_by: null,
      cancel_reason: null,
      timeline: [],
      lines: [],
      totals: { subtotal: 100000, discount_total: 0, shipping_total: 0, total: 100000, paid: 0 },
      address: { province_name: "Hà Nội", ward_name: "Ba Đình", line: `Nhà của chủ ${ref}` },
      contact: { name: `Chủ ${ref}`, phone: "0912***678" },
      actions: { can_cancel: true, can_recheck: false },
    };
  }

  cartView(id: string) {
    const c = this.carts.get(id)!;
    const items = c.items.map((i) => ({
      ...i,
      title: "Áo sơ mi lụa",
      product_title: "Áo sơ mi lụa",
      product_handle: PRODUCT.handle,
      variant_title: "x",
      thumbnail: null,
      unit_price: 700000,
      total: 700000 * i.quantity,
    }));
    return { id, currency_code: "vnd", completed_at: null, items, subtotal: 0, total: 0 };
  }

  mutations(): Call[] {
    return this.calls.filter((c) => c.method !== "GET");
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      init?.body != null && init.body !== ""
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    this.calls.push({
      session: als.getStore()?.name ?? "default",
      method,
      path: url.pathname,
      search: url.search,
      body,
      headers,
    });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, Math.random() * this.delayMs));
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    const notFound = (detail: string) => json({ code: "NOT_FOUND", detail }, 404);
    const p = url.pathname;

    if (p === "/store/regions") return json({ regions: [{ id: "reg_VN", currency_code: "vnd" }] });
    if (p === `/store/x/products/${PRODUCT.handle}`) return json(PRODUCT);

    /* giỏ (Medusa native) */
    if (p === "/store/carts" && method === "POST") {
      const id = `cart_NEW${String(++this.seq).padStart(12, "0")}`;
      this.carts.set(id, { id, items: [] });
      return json({ cart: this.cartView(id) });
    }
    const cm = /^\/store\/carts\/([^/]+)(?:\/line-items(?:\/([^/]+))?)?$/.exec(p);
    if (cm) {
      const cart = this.carts.get(cm[1]!);
      if (!cart) return json({ type: "not_found", message: "Cart not found" }, 404);
      if (!p.includes("/line-items")) return json({ cart: this.cartView(cart.id) });
      if (method === "POST" && cm[2] === undefined) {
        const ex = cart.items.find((i) => i.variant_id === body!.variant_id);
        if (ex) ex.quantity += Number(body!.quantity);
        else
          cart.items.push({
            id: `cali_N${++this.seq}`,
            variant_id: String(body!.variant_id),
            quantity: Number(body!.quantity),
          });
        return json({ cart: this.cartView(cart.id) });
      }
      const line = cart.items.find((i) => i.id === cm[2]);
      if (!line) return json({ type: "not_found", message: "line not found" }, 404);
      if (method === "POST") line.quantity = Number(body!.quantity);
      else cart.items = cart.items.filter((i) => i.id !== line.id);
      return json({ cart: this.cartView(cart.id) });
    }

    /* checkout */
    if (p === "/store/x/checkout/quote") {
      if (!this.carts.has(String(body?.cart_id))) return notFound("Không tìm thấy giỏ hàng");
      return json({ quote: { ...QUOTE.quote, cart_id: body!.cart_id } });
    }
    if (p === "/store/x/checkout/submit") {
      if (!this.carts.has(String(body?.cart_id))) return notFound("Không tìm thấy giỏ hàng");
      return json({ checkout_attempt_id: "chk_NEW0000000000001" }, 202);
    }
    const am = /^\/store\/x\/checkout\/attempts\/([^/]+)$/.exec(p);
    if (am) {
      const a = this.attempts.get(am[1]!);
      if (!a || a.cart !== url.searchParams.get("cart_id")) return notFound("Không tìm thấy lần đặt hàng");
      return json({
        checkout_attempt_id: am[1],
        state: "ready",
        cart_id: a.cart,
        order: {
          id: `order_${a.ref}`,
          display_ref: a.ref,
          state: "placed",
          total: 100000,
          payment_method: "cod",
        },
        payment_url: null,
        error: null,
        order_access: a.token,
        order_access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    /* đơn */
    if (p === "/store/x/orders/lookup") {
      // Backend giả cố tình kèm dữ liệu đơn: storefront KHÔNG được chuyển nó tới client.
      return json(
        { message: LOOKUP_MESSAGE, display_ref: body?.display_ref, contact: { phone: "0912345678" } },
        202,
      );
    }
    if (p === "/store/x/orders/session") {
      const l = this.links.get(String(body?.token));
      if (!l) return notFound("Liên kết không hợp lệ");
      if (l.status !== 200) return json({ code: "LINK_INVALID", detail: `lỗi ${l.status}` }, l.status);
      return json({
        display_ref: l.ref,
        order_access: l.token,
        order_access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    const om = /^\/store\/x\/orders\/([^/]+)(\/recheck|\/cancel)?$/.exec(p);
    if (om) {
      const ref = decodeURIComponent(om[1]!);
      const owner = this.orderTokens.get(headers["x-order-access"] ?? "");
      if (owner !== ref || !this.orders.has(ref)) return notFound("Không tìm thấy đơn hàng");
      if (om[2] === "/cancel") {
        this.orders.get(ref)!.state = "cancelled";
        return json({ ...this.orderBody(ref), cancel: { refund_requested: false } });
      }
      return json(this.orderBody(ref));
    }
    return json({ message: "no route" }, 404);
  };
}

let be: OwnedBackend;
const saved = { ...process.env };

function useBackend() {
  beforeEach(() => {
    be = new OwnedBackend();
    defaultSession = session("default");
    state.cookieReads = 0;
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
}

const alice = () => session("alice", { xs_cart: CART_A, [`xs_order_${REF_A}`]: TOKEN_A });
const ADDRESS = { provinceCode: "01", wardCode: "00004", line: "12 Điện Biên Phủ" };
const SUBMIT: SubmitInput = {
  idempotencyKey: "idem_0123456789abcdef",
  quoteId: "cqt_01M5QKNFYMJ615YBYS4TWEGSS0",
  cartVersion: 1,
  paymentMethod: "cod",
  contact: { name: "An", phone: "0912345678", email: "" },
  address: ADDRESS,
  discountCode: null,
};

describe("IDOR giỏ: addToCart, updateLineQuantity, removeCartLine, changeLineVariant, refreshCartLine, forgetCart", () => {
  useBackend();

  const lineActions = {
    updateLineQuantity: (line: string) => updateLineQuantity(line, 3),
    removeCartLine: (line: string) => removeCartLine(line),
    changeLineVariant: (line: string) => changeLineVariant(line, V_TRANG_S),
    refreshCartLine: (line: string) => refreshCartLine(line),
  };

  for (const [name, act] of Object.entries(lineActions)) {
    it(`${name}: dòng của giỏ người khác → NOT_FOUND giống dòng không tồn tại, không ghi`, async () => {
      const foreign = await as(alice(), () => act(LINE_B));
      const missing = await as(alice(), () => act("cali_KHONGCO00000"));
      expect(foreign).toEqual({ ok: false, code: "NOT_FOUND", message: expect.any(String) });
      expect(foreign).toEqual(missing);
      expect(be.mutations()).toEqual([]);
      expect(be.carts.get(CART_B)!.items).toEqual([{ id: LINE_B, variant_id: V_DEN_M, quantity: 5 }]);
    });

    it(`${name}: không cookie / cookie giỏ sai hình dạng → NOT_FOUND, không gọi giỏ ở backend`, async () => {
      for (const s of [session("anon"), session("bad", { xs_cart: `${CART_B}/../x` })]) {
        expect(await as(s, () => act(LINE_B))).toMatchObject({ ok: false, code: "NOT_FOUND" });
      }
      expect(be.calls.filter((c) => c.path.startsWith("/store/carts"))).toEqual([]);
    });
  }

  it("được phép (đối chứng): chủ giỏ sửa dòng của mình → ghi đúng giỏ của cookie", async () => {
    expect(await as(alice(), () => updateLineQuantity(LINE_A, 3))).toMatchObject({ ok: true, count: 3 });
    expect(be.mutations().map((c) => c.path)).toEqual([`/store/carts/${CART_A}/line-items/${LINE_A}`]);
  });

  it("addToCart: cart_id/cartId client chèn vào bị bỏ qua — ghi vào giỏ của cookie (hoặc giỏ mới), không bao giờ giỏ B", async () => {
    const input = {
      handle: PRODUCT.handle,
      variantId: V_TRANG_S,
      quantity: 1,
      cart_id: CART_B,
      cartId: CART_B,
    } as unknown as AddToCartInput;
    expect(await as(alice(), () => addToCart(input))).toMatchObject({ ok: true });
    const anon = session("anon");
    expect(await as(anon, () => addToCart(input))).toMatchObject({ ok: true, count: 1 });
    const newCart = anon.jar.get("xs_cart")!.value;
    expect(newCart).not.toBe(CART_B);
    expect(be.calls.some((c) => c.path.includes(CART_B))).toBe(false);
    expect(be.mutations().map((c) => `${c.session} ${c.path}`)).toEqual([
      `alice /store/carts/${CART_A}/line-items`,
      "anon /store/carts",
      `anon /store/carts/${newCart}/line-items`,
    ]);
    expect(be.carts.get(CART_B)!.items).toHaveLength(1);
  });

  it("forgetCart: chỉ xoá cookie của phiên gọi, không gọi backend, giỏ vẫn còn ở server", async () => {
    const a = alice();
    await as(a, () => forgetCart());
    expect(a.jar.has("xs_cart")).toBe(false);
    expect(be.calls).toEqual([]);
    expect(be.carts.has(CART_A)).toBe(true);
  });

  it("đồng thời: hai phiên thao tác xen kẽ — mỗi lần ghi chỉ chạm giỏ trong cookie của chính phiên đó", async () => {
    be.delayMs = 3;
    const bob = session("bob", { xs_cart: CART_B });
    const a = alice();
    const results = await Promise.all([
      as(a, () => updateLineQuantity(LINE_A, 2)),
      as(bob, () => updateLineQuantity(LINE_B, 4)),
      as(bob, () => updateLineQuantity(LINE_A, 9)), // dòng của alice
      as(a, () => removeCartLine(LINE_B)), // dòng của bob
      as(a, () => addToCart({ handle: PRODUCT.handle, variantId: V_TRANG_S, quantity: 1 })),
      as(bob, () => addToCart({ handle: PRODUCT.handle, variantId: V_TRANG_S, quantity: 2 })),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true, false, false, true, true]);
    const owner: Record<string, string> = { [CART_A]: "alice", [CART_B]: "bob" };
    for (const c of be.mutations()) {
      const cart = /^\/store\/carts\/([^/]+)/.exec(c.path)![1]!;
      expect(`${c.session} → ${cart}`).toBe(`${owner[cart]} → ${cart}`);
    }
    expect(be.carts.get(CART_A)!.items.map((i) => [i.variant_id, i.quantity])).toEqual([
      [V_DEN_M, 2],
      [V_TRANG_S, 1],
    ]);
    expect(be.carts.get(CART_B)!.items.map((i) => [i.variant_id, i.quantity])).toEqual([
      [V_DEN_M, 4],
      [V_TRANG_S, 2],
    ]);
  });
});

describe("IDOR checkout: quoteCheckout, submitCheckout, pollCheckout, finishCheckout", () => {
  useBackend();

  it("quoteCheckout/submitCheckout: cart_id gửi backend luôn là của cookie; id client chèn vào bị bỏ qua", async () => {
    const quoteInput = {
      paymentMethod: "cod",
      address: ADDRESS,
      discountCode: null,
      cart_id: CART_B,
      cartId: CART_B,
    };
    const q = await as(alice(), () => quoteCheckout(quoteInput as Parameters<typeof quoteCheckout>[0]));
    expect(q.ok).toBe(true);
    const s = await as(alice(), () =>
      submitCheckout({ ...SUBMIT, cart_id: CART_B } as unknown as SubmitInput),
    );
    expect(s).toEqual({ kind: "pending", attemptId: "chk_NEW0000000000001" });
    expect(be.calls.map((c) => c.body?.cart_id)).toEqual([CART_A, CART_A]);
    expect(JSON.stringify(be.calls)).not.toContain(CART_B);
  });

  it("không cookie giỏ → từ chối, không gọi backend", async () => {
    const anon = session("anon");
    expect(
      await as(anon, () => quoteCheckout({ paymentMethod: "cod", address: ADDRESS, discountCode: null })),
    ).toMatchObject({ ok: false, code: "CART_EMPTY" });
    expect(await as(anon, () => submitCheckout(SUBMIT))).toMatchObject({ kind: "error", code: "NOT_FOUND" });
    expect(await as(anon, () => pollCheckout(ATT_B))).toMatchObject({ kind: "failed", code: "NOT_FOUND" });
    expect(be.calls).toEqual([]);
  });

  it("pollCheckout: attempt của giỏ khác → giống attempt không tồn tại, không lộ mã đơn, không cấp cookie đơn", async () => {
    const a = alice();
    a.jar.delete(`xs_order_${REF_A}`);
    const foreign = await as(a, () => pollCheckout(ATT_B));
    const missing = await as(a, () => pollCheckout("chk_KHONGCO000000001"));
    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({ kind: "failed", code: "NOT_FOUND" });
    expect(JSON.stringify(foreign)).not.toContain(REF_B);
    expect([...a.jar.keys()]).toEqual(["xs_cart"]);
    expect(be.calls.every((c) => c.search === `?cart_id=${CART_A}`)).toBe(true);
  });

  it("được phép (đối chứng): attempt của giỏ mình → placed + cookie phiên đơn HttpOnly", async () => {
    const a = session("alice", { xs_cart: CART_A });
    expect(await as(a, () => pollCheckout(ATT_A))).toMatchObject({ kind: "placed", ref: REF_A });
    expect(a.jar.get(`xs_order_${REF_A}`)).toMatchObject({ value: TOKEN_A, options: { httpOnly: true } });
  });

  it("finishCheckout: chỉ xoá cookie giỏ của phiên gọi, không gọi backend", async () => {
    const a = alice();
    await as(a, () => finishCheckout());
    expect(a.jar.has("xs_cart")).toBe(false);
    expect(a.jar.has(`xs_order_${REF_A}`)).toBe(true);
    expect(be.calls).toEqual([]);
  });
});

describe("IDOR đơn: recheckOrderAction, cancelOrderAction, lookupOrderAction, redeemLinkAction", () => {
  useBackend();

  it("đơn không có cookie phiên đơn → not_found, không gọi backend (recheck, cancel, xem)", async () => {
    const a = alice();
    expect(await as(a, () => recheckOrderAction(REF_B))).toEqual({ kind: "not_found" });
    expect(await as(a, () => cancelOrderAction(REF_B))).toEqual({ kind: "not_found" });
    expect(await as(a, () => fetchOrder(REF_B))).toEqual({ kind: "not_found" });
    expect(be.calls).toEqual([]);
    expect(be.orders.get(REF_B)!.state).toBe("placed");
  });

  it("cookie giả (token của đơn A gắn vào tên đơn B) → giống đơn không tồn tại, không huỷ được B", async () => {
    const forged = session("mallory", { [`xs_order_${REF_B}`]: TOKEN_A, "xs_order_XS-ZZZZ99": TOKEN_A });
    const foreignCancel = await as(forged, () => cancelOrderAction(REF_B));
    const missingCancel = await as(forged, () => cancelOrderAction("XS-ZZZZ99"));
    const foreignRecheck = await as(forged, () => recheckOrderAction(REF_B));
    expect(foreignCancel).toEqual({ kind: "not_found" });
    expect(foreignCancel).toEqual(missingCancel);
    expect(foreignRecheck).toEqual({ kind: "not_found" });
    expect(be.orders.get(REF_B)!.state).toBe("placed");
  });

  it("mã đơn rác/không phải chuỗi → not_found, không gọi backend", async () => {
    const a = alice();
    for (const ref of [
      "",
      "xs-aaaa11",
      `${REF_A}/../cancel`,
      "XS-AAAA11?x=1",
      null,
      { ref: REF_A },
      [REF_A, REF_B],
    ]) {
      expect(await as(a, () => recheckOrderAction(ref as string))).toEqual({ kind: "not_found" });
      expect(await as(a, () => cancelOrderAction(ref as string))).toEqual({ kind: "not_found" });
    }
    expect(be.calls).toEqual([]);
  });

  it("được phép (đối chứng): chủ đơn huỷ đơn của mình qua header x-order-access (token không lên URL)", async () => {
    const r = await as(alice(), () => cancelOrderAction(REF_A));
    expect(r).toMatchObject({ kind: "ok", refundRequested: false });
    expect(be.orders.get(REF_A)!.state).toBe("cancelled");
    expect(be.calls[0]!.headers["x-order-access"]).toBe(TOKEN_A);
    expect(be.calls[0]!.path + be.calls[0]!.search).not.toContain(TOKEN_A);
  });

  it("đồng thời: chủ đơn và người lạ cùng huỷ một đơn — chỉ yêu cầu của chủ tới backend", async () => {
    be.delayMs = 3;
    const [owner, stranger] = await Promise.all([
      as(alice(), () => cancelOrderAction(REF_A)),
      as(session("bob", { xs_cart: CART_B }), () => cancelOrderAction(REF_A)),
    ]);
    expect(owner.kind).toBe("ok");
    expect(stranger).toEqual({ kind: "not_found" });
    expect(be.calls.map((c) => c.session)).toEqual(["alice"]);
  });

  it("lookupOrderAction: chỉ trả trạng thái + thông điệp chung, không chuyển dữ liệu đơn từ backend tới client", async () => {
    const form = (ma: string, sdt: string) => {
      const f = new FormData();
      f.set("ma", ma);
      f.set("sdt", sdt);
      return f;
    };
    const known = await lookupOrderAction({ status: "idle" }, form(REF_A, "0912345678"));
    const unknown = await lookupOrderAction({ status: "idle" }, form("XS-ZZZZ99", "0900000000"));
    expect(known).toEqual({ status: "sent", message: LOOKUP_MESSAGE });
    expect(unknown).toEqual(known);
    expect(be.calls.map((c) => c.body)).toEqual([
      { display_ref: REF_A, phone: "0912345678" },
      { display_ref: "XS-ZZZZ99", phone: "0900000000" },
    ]);
  });

  it("redeemLinkAction: mọi kiểu thất bại → cùng trang lỗi, không ghi cookie; mã đơn lạ từ backend không vào cookie/URL", async () => {
    const redeem = async (token: string) => {
      const s = session("guest");
      const f = new FormData();
      f.set("token", token);
      const err = await as(s, () => redeemLinkAction(f)).catch((e: Error) => e.message);
      return { redirect: err, cookies: [...s.jar.keys()] };
    };
    const fail = { redirect: "REDIRECT /tra-cuu-don?loi=lien-ket", cookies: [] };
    for (const t of ["link-used", "link-forged", "link-401", "link-500", "link-khong-co", "link-evil-ref"]) {
      expect(await redeem(t), t).toEqual(fail);
    }
    const before = be.calls.length;
    expect(await redeem("x".repeat(513))).toEqual(fail);
    expect(await redeem("")).toEqual(fail);
    expect(be.calls.length).toBe(before);
    expect(await redeem("link-ok-A")).toEqual({
      redirect: `REDIRECT /don-hang/${REF_A}`,
      cookies: [`xs_order_${REF_A}`, "xs_order_last"],
    });
  });
});

describe("IDOR route: /api/cart/count, /thanh-toan/ket-qua", () => {
  useBackend();

  it("/api/cart/count: đếm giỏ của cookie, bỏ qua ?cart_id=; không cookie/cookie rác → 0, không gọi backend; private no-store", async () => {
    const res = await as(alice(), () => cartCountGET());
    expect(await res.json()).toEqual({ count: 1 });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    for (const s of [session("anon"), session("bad", { xs_cart: "cart_B;Path=/" })]) {
      expect(await (await as(s, () => cartCountGET())).json()).toEqual({ count: 0 });
    }
    expect(be.calls.map((c) => c.path)).toEqual([`/store/carts/${CART_A}`]);
  });

  const ret = (s: Session, qs: string) =>
    as(s, () => paymentReturnGET(new Request(`https://shop.test/thanh-toan/ket-qua${qs}`)));

  it("/thanh-toan/ket-qua: attempt của giỏ khác → trang tra cứu, không cấp cookie đơn, không gọi đơn ở backend", async () => {
    const s = session("alice", { xs_cart: CART_A });
    const res = await ret(s, `?attempt=${ATT_B}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://shop.test/tra-cuu-don?tu=thanh-toan");
    expect([...s.jar.keys()]).toEqual(["xs_cart"]);
    expect(be.calls.some((c) => c.path.startsWith("/store/x/orders"))).toBe(false);
  });

  it("/thanh-toan/ket-qua: xs_order_last / vnp_OrderInfo trỏ đơn người khác → chỉ điền sẵn mã, không mở đơn", async () => {
    const s = session("mallory", { xs_order_last: REF_B });
    const res = await ret(
      s,
      `?vnp_OrderInfo=${encodeURIComponent(`Thanh toan don ${REF_B}`)}&vnp_ResponseCode=00`,
    );
    expect(res.headers.get("location")).toBe(`https://shop.test/tra-cuu-don?tu=thanh-toan&ma=${REF_B}`);
    expect(be.calls).toEqual([]);
    expect([...s.jar.keys()]).toEqual(["xs_order_last"]);
  });

  it("được phép (đối chứng): attempt của giỏ mình → recheck đơn mình rồi /don-hang/:ref", async () => {
    const s = session("alice", { xs_cart: CART_A });
    const res = await ret(s, `?attempt=${ATT_A}`);
    expect(res.headers.get("location")).toBe(`https://shop.test/don-hang/${REF_A}`);
    expect(be.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /store/x/checkout/attempts/${ATT_A}`,
      `POST /store/x/orders/${REF_A}/recheck`,
    ]);
  });
});

describe("route công khai có chủ đích: /api/address/wards, /api/catalog/count, /api/catalog/suggest", () => {
  beforeEach(() => {
    delete process.env.XS_DATA_SOURCE;
    delete process.env.MEDUSA_BACKEND_URL;
    resetEnvCacheForTests();
    state.cookieReads = 0;
  });
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCacheForTests();
  });

  const snapshot = async (res: Response) => ({
    status: res.status,
    body: await res.text(),
    cache: res.headers.get("cache-control"),
    setCookie: res.headers.get("set-cookie"),
  });

  it("phản hồi không phụ thuộc cookie phiên và không đọc cookie", async () => {
    const calls = {
      "/api/address/wards": () => wardsGET(new Request("https://shop.test/api/address/wards?province=01")),
      "/api/catalog/count": () => catalogCountGET(new Request("https://shop.test/api/catalog/count")),
      "/api/catalog/suggest": () => suggestGET(new Request("https://shop.test/api/catalog/suggest?q=ao")),
    };
    for (const [path, call] of Object.entries(calls)) {
      const withCookies = await snapshot(await as(alice(), call));
      const anonymous = await snapshot(await as(session("anon"), call));
      expect(withCookies, path).toEqual(anonymous);
      expect(withCookies.setCookie, path).toBeNull();
      expect(withCookies.cache ?? "", path).not.toContain("private");
    }
    expect(state.cookieReads).toBe(0);
  });
});
