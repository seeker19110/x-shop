#!/usr/bin/env node
// Đối chiếu route chạm dữ liệu cá nhân (OpenAPI) với test authz có tag (`pnpm check:authz`).
// QA-INT-006, STD-SEC-004 (OWASP API Security Top 10 2023: API1 BOLA, API5 BFLA).
//
// Tag đặt TRONG chuỗi tên test/describe của apps/backend/integration-tests/**/*.spec.ts, dạng
//   `[api1-bola <selector>, <selector>…]`  hoặc  `[api5-bfla <selector>, …]`
// selector = `admin:*` (mọi thao tác admin) | `order:*` (mọi thao tác đòi token đơn) | `<method> <path>` đúng như OpenAPI.
// Tag chỉ nằm trong chuỗi (không tính chú thích) và selector trỏ route không có thật → lỗi (chống tag "mồ côi").
//
// Route bắt buộc có test:
//  - api5-bfla (BFLA): mọi thao tác admin (security adminSession/adminBearer);
//  - api1-bola (BOLA): mọi thao tác đòi token đơn (orderAccess) + route công khai chạm giỏ/đơn của khách
//    (`/store/x/checkout/*`, `/store/x/orders/*`) — quyền với tài nguyên kiểm trong route, nên phải có test chéo A↔B.
// Thoát 0 = đạt; 1 = thiếu/sai tag (in từng dòng); 2 = không đọc được đầu vào.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
export const TAGS = ["api1-bola", "api5-bfla"];
const CLASS_SELECTORS = new Set(["admin:*", "order:*"]);

/** Phân loại thao tác theo security của OpenAPI. */
export function classifyOperations(spec) {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const schemes = new Set((op.security ?? spec.security ?? []).flatMap((s) => Object.keys(s)));
      const admin = schemes.has("adminSession") || schemes.has("adminBearer");
      const order = schemes.has("orderAccess");
      const personalPublic =
        !admin && !order && (path.startsWith("/store/x/checkout/") || path.startsWith("/store/x/orders/"));
      ops.push({ key: `${method} ${path}`, admin, order, personalPublic });
    }
  }
  return ops;
}

/** Route bắt buộc theo từng tag. */
export function requiredRoutes(ops) {
  return {
    "api5-bfla": ops.filter((o) => o.admin).map((o) => o.key),
    "api1-bola": ops.filter((o) => o.order || o.personalPublic).map((o) => o.key),
  };
}

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const TAG_BRACKET = new RegExp(`\\[(${TAGS.join("|")}) ([^\\]]+)\\]`, "g");

/** Mọi tag `[tag selector,…]` nằm trong chuỗi của một file test → [{ tag, selector }]. */
export function parseTags(source) {
  const out = [];
  for (const lit of source.match(STRING_LITERAL) ?? []) {
    for (const m of lit.matchAll(TAG_BRACKET)) {
      for (const selector of m[2].split(",").map((s) => s.trim().toLowerCase())) {
        if (selector !== "") out.push({ tag: m[1], selector });
      }
    }
  }
  return out;
}

/** Kiểm: mọi route bắt buộc có test tag tương ứng; selector phải hợp lệ. Trả danh sách lỗi (rỗng = đạt). */
export function checkAuthzCoverage(spec, tagged) {
  const ops = classifyOperations(spec);
  const byKey = new Map(ops.map((o) => [o.key, o]));
  const errors = [];
  const covered = Object.fromEntries(TAGS.map((t) => [t, new Set()]));
  for (const { tag, selector, file } of tagged) {
    const where = file === undefined ? "" : ` (${file})`;
    if (CLASS_SELECTORS.has(selector)) {
      const pick = selector === "admin:*" ? (o) => o.admin : (o) => o.order;
      for (const o of ops.filter(pick)) covered[tag].add(o.key);
    } else if (byKey.has(selector)) {
      covered[tag].add(selector);
    } else {
      errors.push(`tag ${tag} trỏ selector không hợp lệ/không có trong OpenAPI: "${selector}"${where}`);
    }
  }
  const required = requiredRoutes(ops);
  for (const tag of TAGS) {
    if (required[tag].length === 0)
      errors.push(`OpenAPI không có route nào cần tag ${tag} (đầu vào bất thường)`);
    for (const key of required[tag]) {
      if (!covered[tag].has(key)) errors.push(`thiếu test ${tag} cho ${key}`);
    }
  }
  return errors;
}

function walkSpecs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkSpecs(p, out);
    else if (name.endsWith(".spec.ts")) out.push(p);
  }
  return out;
}

export function checkAuthzTests({
  root,
  specPath = "docs/design/openapi.yaml",
  testsDir = "apps/backend/integration-tests",
}) {
  const spec = parse(readFileSync(join(root, specPath), "utf8"));
  const tagged = [];
  for (const file of walkSpecs(join(root, testsDir)).sort()) {
    const rel = file.slice(root.length + 1);
    for (const t of parseTags(readFileSync(file, "utf8"))) tagged.push({ ...t, file: rel });
  }
  const errors = checkAuthzCoverage(spec, tagged);
  return { errors, required: requiredRoutes(classifyOperations(spec)), tagged: tagged.length };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let result;
  try {
    result = checkAuthzTests({ root });
  } catch (e) {
    console.error(`check-authz-tests: không đọc được đầu vào: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`✗ ${e}`);
    console.error(`check-authz-tests: ${result.errors.length} lỗi`);
    process.exit(1);
  }
  console.log(
    `check-authz-tests: OK — BFLA ${result.required["api5-bfla"].length} route admin, BOLA ${result.required["api1-bola"].length} route đơn/giỏ đều có test tag (${result.tagged} tag)`,
  );
}
