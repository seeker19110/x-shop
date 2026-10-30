// @vitest-environment node
// Contract test (QA-INT-007, T-194): mọi fixture phản hồi backend thật của storefront phải khớp schema response tương ứng
// trong docs/design/openapi.yaml. Repo chưa có ajv trực tiếp (chỉ là phụ thuộc bắc cầu của spectral — không import được từ
// đây) và không thêm phụ thuộc mới, nên dùng validator tối thiểu cho đúng tập từ khoá JSON Schema mà openapi.yaml dùng thật;
// từ khoá lạ → ném lỗi (không bỏ qua im lặng), nên thêm từ khoá mới vào openapi buộc phải mở rộng validator này.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = Record<string, unknown>;

const LIB = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = join(LIB, "../../../../docs/design/openapi.yaml");
const doc = parse(readFileSync(SPEC_PATH, "utf8")) as Record<string, unknown>;

function resolve(node: unknown): Schema {
  let cur = node as Schema;
  const seen = new Set<string>();
  while (typeof cur.$ref === "string") {
    const ref = cur.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) throw new Error(`$ref không hỗ trợ/vòng: ${ref}`);
    seen.add(ref);
    let t: unknown = doc;
    for (const part of ref.slice(2).split("/"))
      t = (t as Record<string, unknown>)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (t === undefined) throw new Error(`$ref không tồn tại: ${ref}`);
    cur = t as Schema;
  }
  return cur;
}

const IGNORED = new Set([
  "description",
  "example",
  "examples",
  "default",
  "title",
  "format",
  "deprecated",
  "readOnly",
  "writeOnly",
  "nullable",
]);
const HANDLED = new Set([
  "type", "enum", "const", "required", "properties", "additionalProperties", "items", "allOf", "oneOf", "anyOf", "not",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "minItems", "maxItems",
]); // prettier-ignore

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v; // string | boolean | object
}
const typeOk = (want: string, v: Json) =>
  typeOf(v) === want || (want === "number" && typeOf(v) === "integer");
const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Trả danh sách lỗi (rỗng = hợp lệ). */
export function validate(schemaNode: unknown, v: Json, at = "$"): string[] {
  const s = resolve(schemaNode);
  for (const k of Object.keys(s)) {
    if (!HANDLED.has(k) && !IGNORED.has(k) && !k.startsWith("x-"))
      throw new Error(`validator chưa hỗ trợ từ khoá "${k}" tại ${at}`);
  }
  const errs: string[] = [];
  if (s.type !== undefined) {
    const want = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    if (!want.some((t) => typeOk(t, v))) return [`${at}: kiểu ${typeOf(v)} không thuộc [${want}]`];
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEq(e, v)))
    errs.push(`${at}: ${JSON.stringify(v)} ngoài enum ${JSON.stringify(s.enum)}`);
  if ("const" in s && !deepEq(s.const, v)) errs.push(`${at}: khác const ${JSON.stringify(s.const)}`);
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) errs.push(`${at}: ${v} < minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && v > s.maximum) errs.push(`${at}: ${v} > maximum ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum)
      errs.push(`${at}: ${v} <= exclusiveMinimum ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum)
      errs.push(`${at}: ${v} >= exclusiveMaximum ${s.exclusiveMaximum}`);
  }
  if (typeof v === "string") {
    const len = [...v].length;
    if (typeof s.minLength === "number" && len < s.minLength)
      errs.push(`${at}: dài ${len} < minLength ${s.minLength}`);
    if (typeof s.maxLength === "number" && len > s.maxLength)
      errs.push(`${at}: dài ${len} > maxLength ${s.maxLength}`);
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v))
      errs.push(`${at}: không khớp pattern ${s.pattern}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems)
      errs.push(`${at}: ${v.length} phần tử < minItems ${s.minItems}`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems)
      errs.push(`${at}: ${v.length} phần tử > maxItems ${s.maxItems}`);
    if (s.items !== undefined) v.forEach((item, i) => errs.push(...validate(s.items, item, `${at}[${i}]`)));
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const r of (s.required ?? []) as string[])
      if (!(r in v)) errs.push(`${at}: thiếu field bắt buộc "${r}"`);
    for (const [k, val] of Object.entries(v)) {
      if (k in props) errs.push(...validate(props[k], val, `${at}.${k}`));
      else if (s.additionalProperties === false)
        errs.push(`${at}: field thừa "${k}" (additionalProperties: false)`);
      else if (typeof s.additionalProperties === "object" && s.additionalProperties !== null)
        errs.push(...validate(s.additionalProperties, val, `${at}.${k}`));
    }
  }
  for (const part of (s.allOf ?? []) as unknown[]) errs.push(...validate(part, v, at));
  if (Array.isArray(s.oneOf)) {
    const ok = s.oneOf.filter((p) => validate(p, v, at).length === 0).length;
    if (ok !== 1) errs.push(`${at}: oneOf khớp ${ok} nhánh (cần đúng 1)`);
  }
  if (Array.isArray(s.anyOf) && !s.anyOf.some((p) => validate(p, v, at).length === 0))
    errs.push(`${at}: không khớp nhánh anyOf nào`);
  if (s.not !== undefined && validate(s.not, v, at).length === 0) errs.push(`${at}: khớp schema "not"`);
  return errs;
}

function responseSchema(path: string, method: string, status: string): unknown {
  const op = (((doc.paths as Record<string, Record<string, Record<string, unknown>>>)[path] ?? {})[method] ??
    {}) as Record<string, unknown>;
  const resp = resolve((op.responses as Record<string, unknown> | undefined)?.[status] ?? {}) as {
    content?: Record<string, { schema?: unknown }>;
  };
  const schema = resp.content?.["application/json"]?.schema;
  if (schema === undefined)
    throw new Error(`openapi không có schema ${method.toUpperCase()} ${path} ${status}`);
  return schema;
}

const BACKEND = "catalog/__fixtures__/backend";
const CHECKOUT = "checkout/__fixtures__";
/** fixture (đường dẫn so với src/lib) → thao tác OpenAPI mà phản hồi phải khớp. */
const MAP: Record<string, [path: string, method: string, status: string]> = {
  [`${BACKEND}/list.json`]: ["/store/x/products", "get", "200"],
  [`${BACKEND}/product.json`]: ["/store/x/products/{handle}", "get", "200"],
  [`${BACKEND}/search.json`]: ["/store/x/search", "get", "200"],
  [`${BACKEND}/search-empty.json`]: ["/store/x/search", "get", "200"],
  [`${BACKEND}/categories.json`]: ["/store/x/categories", "get", "200"],
  [`${CHECKOUT}/quote.json`]: ["/store/x/checkout/quote", "post", "200"],
  [`${CHECKOUT}/submit-cod.json`]: ["/store/x/checkout/submit", "post", "200"],
  [`${CHECKOUT}/submit-vnpay.json`]: ["/store/x/checkout/submit", "post", "200"],
  [`${CHECKOUT}/attempt-ready.json`]: ["/store/x/checkout/attempts/{id}", "get", "200"],
};
/** Fixture không thuộc API `/store/x` (giỏ hàng là API lõi Medusa, ngoài openapi.yaml) — phải liệt kê tường minh. */
const EXEMPT = new Set(["cart/__fixtures__/cart.json"]);

function fixturesOnDisk(dir = LIB): string[] {
  const found: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...fixturesOnDisk(p));
    else if (e.name.endsWith(".json") && p.includes("__fixtures__"))
      found.push(relative(LIB, p).split("\\").join("/"));
  }
  return found.sort();
}
const load = (rel: string): Json => JSON.parse(readFileSync(join(LIB, rel), "utf8")) as Json;

describe("hợp đồng fixture backend ↔ openapi.yaml (QA-INT-007)", () => {
  it("mọi fixture JSON đều được ánh xạ tới một schema hoặc nằm trong danh sách miễn có lý do", () => {
    const unmapped = fixturesOnDisk().filter((f) => !(f in MAP) && !EXEMPT.has(f));
    expect(unmapped).toEqual([]);
    for (const f of [...Object.keys(MAP), ...EXEMPT]) expect(fixturesOnDisk()).toContain(f);
  });

  for (const [file, [path, method, status]] of Object.entries(MAP)) {
    it(`${file} khớp ${method.toUpperCase()} ${path} ${status}`, () => {
      expect(validate(responseSchema(path, method, status), load(file))).toEqual([]);
    });
  }

  describe("validator (ca biên)", () => {
    const S = {
      type: "object",
      required: ["a"],
      properties: { a: { type: "integer", minimum: 0 }, b: { type: ["string", "null"], maxLength: 2 } },
      additionalProperties: false,
    };
    it("chấp nhận hợp lệ; null cho kiểu cho phép null; 0 không bị coi là thiếu", () => {
      expect(validate(S, { a: 0, b: null })).toEqual([]);
      expect(validate(S, { a: 1 })).toEqual([]);
    });
    it("bắt thiếu field, sai kiểu, số thực thay số nguyên, ngoài miền, field thừa, chuỗi Unicode quá dài", () => {
      expect(validate(S, {})).toHaveLength(1);
      expect(validate(S, { a: "1" })).toHaveLength(1);
      expect(validate(S, { a: 1.5 })).toHaveLength(1);
      expect(validate(S, { a: -1 })).toHaveLength(1);
      expect(validate(S, { a: 1, c: 1 })).toHaveLength(1);
      expect(validate(S, { a: 1, b: "ệệệ" })).toHaveLength(1);
      expect(validate(S, { a: 1, b: "ệệ" })).toEqual([]);
    });
    it("enum, mảng rỗng, oneOf đúng một nhánh, từ khoá lạ → ném lỗi", () => {
      expect(validate({ type: "string", enum: ["x"] }, "y")).toHaveLength(1);
      expect(validate({ type: "array", items: { type: "string" } }, [])).toEqual([]);
      expect(validate({ type: "array", minItems: 1 }, [])).toHaveLength(1);
      expect(validate({ oneOf: [{ type: "string" }, { type: "integer" }] }, 1)).toEqual([]);
      expect(validate({ oneOf: [{ type: "number" }, { type: "integer" }] }, 1)).toHaveLength(1);
      expect(() => validate({ type: "string", dependentSchemas: {} }, "x")).toThrow(/chưa hỗ trợ/);
    });
    it("responseSchema báo lỗi rõ khi openapi thiếu schema", () => {
      expect(() => responseSchema("/khong/co", "get", "200")).toThrow(/openapi không có schema/);
    });
  });
});
