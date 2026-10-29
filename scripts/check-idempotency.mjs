#!/usr/bin/env node
// Kiểm idempotency của mọi handler ghi trong apps/backend/src/api/**/route.{ts,js,mts,mjs,cts,cjs} (T-187; ARC-INT-001,
// BE-API-008; Q-06/Q-07 của docs/autopilot/PLAN-2.md, D-139) — `pnpm check:idempotency`.
//
// Phân tích bằng TypeScript compiler API (không regex trên văn bản): chú thích không tính, thân từng handler tách riêng.
// Mỗi handler POST/PUT/PATCH/DELETE phải thuộc đúng MỘT trong hai nhóm:
//  1. Nhận `Idempotency-Key` BẮT BUỘC: trong CHÍNH thân handler gọi `idempotencyKeyOf(req)` (workflows/returns/http.ts)
//     hoặc đọc `req.get("Idempotency-Key")` kèm `isValidIdempotencyKey(...)`. Route nhận khoá phải có kịch bản trong
//     `KEYED` của apps/backend/integration-tests/http/idempotency.spec.ts (gửi lại / khác nội dung / song song).
//  2. Nằm trong scripts/idempotency-allowlist.json với `kind` (state | natural-key | no-business-effect), `reason` và ít
//     nhất một test chứng minh gọi SONG SONG: lời gọi `it(`/`test(` mang đúng tên (không `.skip`/`.todo`/`xit`, không
//     nằm trong `describe.skip`), thân test có `Promise.all` và đoạn đường dẫn tĩnh cuối của route (hoặc khớp regex
//     `calls` của mục).
// Fail-closed: route có `export { … }`, `export * from`, `export let|var`, hay export phân rã → lỗi (không phân tích được
// handler thật Medusa sẽ nạp).
// Lỗi: route ghi mới thiếu cả hai; mục allowlist không còn route (hoặc route đã nhận khoá); test được dẫn không có/bị
// skip/không song song. Đối chiếu OpenAPI (docs/design/openapi.yaml) cho route có trong spec: `x-idempotency` = `key`
// hoặc đúng `kind` của allowlist; route nhận khoá khai tham số `IdempotencyKey`, phản hồi 409 = `KeyedConflict`, có 422;
// route không nhận khoá không khai tham số đó.
//
// Thoát 0 = đạt; 1 = có lỗi (in từng dòng); 2 = không đọc được đầu vào.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { parse } from "yaml";

export const HTTP_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];
export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
export const KINDS = ["state", "natural-key", "no-business-effect"];
export const ALLOWLIST_PATH = "scripts/idempotency-allowlist.json";
export const SPEC_PATH = "docs/design/openapi.yaml";
export const KEYED_SPEC_PATH = "apps/backend/integration-tests/http/idempotency.spec.ts";
const API_DIR = "apps/backend/src/api";
const ROUTE_FILE = /^route\.(ts|js|mts|mjs|cts|cjs)$/;
const MIN_REASON = 30;

const scriptKindOf = (fileName) => (/\.[mc]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
const sourceFile = (fileName, source) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
const isExported = (node) =>
  (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  ) ?? false;
const literalText = (node) =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

/** `exports.X = …`, `module.exports = …`, `module.exports.X = …` (kể cả `exports["X"]`). */
function isCommonJsExport(expr) {
  if (!ts.isBinaryExpression(expr) || expr.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  let target = expr.left;
  while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    const base = target.expression;
    if (ts.isIdentifier(base) && (base.text === "exports" || base.text === "module")) return true;
    target = base;
  }
  return false;
}

/** `[id]` → `{id}`; đường dẫn tính từ thư mục api. */
export function routePathOf(apiDir, file) {
  const rel = relative(apiDir, dirname(file)).split(sep).join("/");
  return "/" + rel.replace(/\[([^\]]+)\]/g, "{$1}");
}

/**
 * Handler export của một file route: [{ method, node }] (node = thân handler: hàm hoặc biểu thức khởi tạo) và các vấn
 * đề khiến không phân tích chắc được (fail-closed).
 */
export function analyzeRoute(source, fileName = "route.ts") {
  const sf = sourceFile(fileName, source);
  const handlers = [];
  const problems = [];
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      problems.push(
        `\`${st.getText(sf).split("\n")[0]}\` — export lại/đổi tên không phân tích được; khai handler bằng \`export const|function METHOD\``,
      );
      continue;
    }
    if (ts.isExportAssignment(st)) {
      problems.push(
        `\`${st.isExportEquals ? "export =" : "export default"}\` — Medusa nạp handler theo tên export; khai \`export const|function METHOD\``,
      );
      continue;
    }
    if (ts.isExpressionStatement(st) && isCommonJsExport(st.expression)) {
      problems.push(
        "gán `exports.*`/`module.exports` — không phân tích được; khai `export const|function METHOD`",
      );
      continue;
    }
    if (!isExported(st)) continue;
    if (ts.isImportEqualsDeclaration(st) || ts.isModuleDeclaration(st)) {
      problems.push(
        `\`${st.getText(sf).split("\n")[0]}\` — export import/namespace không phân tích được; khai handler bằng \`export const|function METHOD\``,
      );
      continue;
    }
    if (ts.isFunctionDeclaration(st)) {
      if (st.name && HTTP_METHODS.includes(st.name.text)) handlers.push({ method: st.name.text, node: st });
    } else if (ts.isVariableStatement(st)) {
      if (!(st.declarationList.flags & ts.NodeFlags.Const)) {
        problems.push("`export let|var` — handler có thể bị gán lại lúc chạy; dùng `export const`");
        continue;
      }
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) {
          problems.push("export phân rã (`export const { … } =`) không phân tích được");
          continue;
        }
        if (HTTP_METHODS.includes(d.name.text))
          handlers.push({ method: d.name.text, node: d.initializer ?? d });
      }
    }
  }
  return { handlers, problems };
}

/** "key" = nhận khoá bắt buộc; "unvalidated" = đọc header mà không kiểm; null = không nhận. Chỉ xét trong `node`. */
export function keyModeOfNode(node) {
  let helper = false;
  let read = false;
  let validate = false;
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && callee.text === "idempotencyKeyOf" && n.arguments.length > 0)
        helper = true;
      if (ts.isIdentifier(callee) && callee.text === "isValidIdempotencyKey") validate = true;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["get", "header"].includes(callee.name.text) &&
        /^idempotency-key$/i.test(literalText(n.arguments[0]) ?? "")
      ) {
        read = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  if (helper) return "key";
  if (read) return validate ? "key" : "unvalidated";
  return null;
}

/** Tiện cho test: mode của handler ghi đầu tiên trong một đoạn nguồn. */
export function keyModeOf(source) {
  const { handlers } = analyzeRoute(source);
  const h = handlers.find((x) => WRITE_METHODS.includes(x.method));
  return h ? keyModeOfNode(h.node) : null;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (ROUTE_FILE.test(name)) out.push(p);
  }
  return out;
}

/** Mọi handler ghi trong cây api: { handlers: [{ route, file, mode }], problems: ["file: …"] }. */
export function scanRoutes(root) {
  const apiDir = join(root, API_DIR);
  const handlers = [];
  const problems = [];
  for (const file of walk(apiDir)) {
    const rel = relative(root, file).split(sep).join("/");
    const path = routePathOf(apiDir, file);
    const r = analyzeRoute(readFileSync(file, "utf8"), file);
    for (const p of r.problems) problems.push(`${rel}: ${p}`);
    for (const h of r.handlers) {
      if (!WRITE_METHODS.includes(h.method)) continue;
      handlers.push({ route: `${h.method} ${path}`, file: rel, mode: keyModeOfNode(h.node) });
    }
  }
  const seen = new Map();
  for (const h of handlers) {
    if (seen.has(h.route)) problems.push(`${h.route}: khai ở hai file (${seen.get(h.route)}, ${h.file})`);
    seen.set(h.route, h.file);
  }
  return { handlers: handlers.sort((a, b) => a.route.localeCompare(b.route)), problems };
}

/** Giữ API cũ: chỉ danh sách handler ghi. */
export const writeHandlers = (root) => scanRoutes(root).handlers;

const TEST_FNS = new Set(["it", "test"]);
const SKIPPED_FNS = new Set(["xit", "xtest", "xdescribe"]);
const SKIP_PROPS = new Set(["skip", "todo"]);

/** Lời gọi it/test/describe: { kind: "test"|"describe", skipped } hoặc null. */
function testCallOf(call) {
  const c = call.expression;
  if (ts.isIdentifier(c)) {
    if (TEST_FNS.has(c.text)) return { kind: "test", skipped: false };
    if (c.text === "describe") return { kind: "describe", skipped: false };
    if (SKIPPED_FNS.has(c.text)) return { kind: c.text === "xdescribe" ? "describe" : "test", skipped: true };
  }
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
    const base = c.expression.text;
    if (TEST_FNS.has(base) || base === "describe") {
      return { kind: base === "describe" ? "describe" : "test", skipped: SKIP_PROPS.has(c.name.text) };
    }
  }
  return null;
}

/** Mọi test có tên tĩnh trong một file: [{ name, skipped, body }]. */
export function testsOfSource(source, fileName = "x.spec.ts") {
  const sf = sourceFile(fileName, source);
  const out = [];
  const visit = (n, describeSkipped) => {
    let skippedHere = describeSkipped;
    if (ts.isCallExpression(n)) {
      const t = testCallOf(n);
      if (t?.kind === "describe" && t.skipped) skippedHere = true;
      if (t?.kind === "test") {
        const name = literalText(n.arguments[0]);
        const fn = n.arguments[1];
        if (name !== undefined) out.push({ name, skipped: t.skipped || describeSkipped, fn, sf });
      }
    }
    ts.forEachChild(n, (c) => visit(c, skippedHere));
  };
  visit(sf, false);
  return out;
}

/** Văn bản của string/template literal (phần chèn `${…}` thành ký hiệu giữ chỗ \u0000). */
function literalTextWithHoles(n) {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n))
    return n.head.text + n.templateSpans.map((sp) => "\u0000" + sp.literal.text).join("");
  return undefined;
}

/**
 * Regex khớp ĐỦ đường dẫn của route theo thứ tự trong một literal: đoạn tĩnh giữ nguyên, `{param}` = một đoạn bất kỳ
 * (giá trị hoặc `${…}`), kết thúc ở ranh giới đoạn (`/`, `?`, `#`, `${…}` hoặc hết chuỗi).
 */
export function routeLiteralRegex(route) {
  const path = route.split(" ")[1];
  const body = path
    .split("/")
    .filter(Boolean)
    .map((seg) => (seg.startsWith("{") ? "[^/?#]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`(^|[^A-Za-z0-9_.-])/${body}(?=$|[/?#\u0000])`);
}

/** Tên được gọi của một CallExpression: `f(…)` → "f", `a.b.f(…)` → "f". */
const calleeName = (call) =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : undefined;

/** Nút khai báo hàm/biến tên `name` ở bất kỳ đâu trong file (helper của test). */
function declarationsNamed(sf, name) {
  const out = [];
  const visit = (n) => {
    if (
      (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name) &&
      n.name.text === name
    )
      out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Có literal (string/template) trong `node` chứa đủ đường dẫn route theo thứ tự. */
function hasRouteLiteral(node, re) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    const text = literalTextWithHoles(n);
    if (text !== undefined && re.test(text)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Test chứng minh gọi route song song (phân tích AST — chú thích không tính): có lời gọi `Promise.all(…)` thật, và
 * hoặc thân test có literal chứa đủ đường dẫn route theo thứ tự, hoặc (mục khai `calls` = tên hàm phụ) thân test gọi
 * hàm đó VÀ khai báo hàm đó trong cùng file có literal chứa đủ đường dẫn route.
 */
export function provesParallelCall(test, route, calls) {
  if (!test.fn) return false;
  let promiseAll = false;
  let callsHelper = false;
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (
        ts.isPropertyAccessExpression(c) &&
        ts.isIdentifier(c.expression) &&
        c.expression.text === "Promise" &&
        ["all", "allSettled"].includes(c.name.text)
      )
        promiseAll = true;
      if (calls && calleeName(n) === calls) callsHelper = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(test.fn);
  if (!promiseAll) return false;
  const re = routeLiteralRegex(route);
  if (!calls) return hasRouteLiteral(test.fn, re);
  return callsHelper && declarationsNamed(test.sf, calls).some((d) => hasRouteLiteral(d, re));
}

/** Đoạn đường dẫn tĩnh cuối của route ("POST /a/{id}/approve" → "approve"). */
export const lastStaticSegment = (route) =>
  route
    .split(" ")[1]
    .split("/")
    .filter((s) => s && !s.startsWith("{"))
    .at(-1) ?? "";

/** Kiểm cấu trúc allowlist + test được dẫn; trả { errors, byRoute }. */
export function checkAllowlist(root, list) {
  const errors = [];
  const byRoute = new Map();
  const cache = new Map();
  const testsIn = (file) => {
    if (!cache.has(file)) cache.set(file, testsOfSource(readFileSync(join(root, file), "utf8"), file));
    return cache.get(file);
  };
  if (!Array.isArray(list?.routes)) return { errors: ["allowlist: thiếu mảng `routes`"], byRoute };
  for (const [i, e] of list.routes.entries()) {
    const at = `allowlist[${i}] ${typeof e?.route === "string" ? e.route : "?"}`;
    if (typeof e?.route !== "string" || !/^(POST|PUT|PATCH|DELETE) \/\S+$/.test(e.route)) {
      errors.push(`${at}: \`route\` phải dạng "METHOD /path" với METHOD ∈ ${WRITE_METHODS.join("|")}`);
      continue;
    }
    if (byRoute.has(e.route)) errors.push(`${at}: trùng mục`);
    byRoute.set(e.route, e);
    if (!KINDS.includes(e.kind)) errors.push(`${at}: \`kind\` phải là một trong ${KINDS.join("|")}`);
    if (typeof e.reason !== "string" || e.reason.trim().length < MIN_REASON) {
      errors.push(`${at}: \`reason\` thiếu hoặc quá ngắn (< ${MIN_REASON} ký tự)`);
    }
    if (e.calls !== undefined)
      errors.push(`${at}: \`calls\` khai theo từng mục \`tests[]\`, không ở mức route`);
    const tests = Array.isArray(e.tests) ? e.tests : [];
    if (tests.length === 0) errors.push(`${at}: thiếu \`tests\` (test song song chứng minh)`);
    for (const t of tests) {
      if (typeof t?.file !== "string" || typeof t?.name !== "string" || t.name.length < 10) {
        errors.push(`${at}: mục test phải có \`file\` và \`name\` (≥ 10 ký tự)`);
        continue;
      }
      let calls = null;
      if (t.calls !== undefined) {
        if (typeof t.calls === "string" && /^[A-Za-z_$][\w$]*$/.test(t.calls)) calls = t.calls;
        else {
          errors.push(`${at}: \`tests[].calls\` phải là tên hàm phụ (định danh JS), không phải regex`);
          continue;
        }
      }
      if (!existsSync(join(root, t.file))) {
        errors.push(`${at}: không có file test ${t.file}`);
        continue;
      }
      const found = testsIn(t.file).filter((x) => x.name === t.name);
      if (found.length === 0) {
        errors.push(`${at}: ${t.file} không có lời gọi it(/test( tên "${t.name}"`);
        continue;
      }
      if (found.some((x) => x.skipped)) {
        errors.push(`${at}: test "${t.name}" bị skip/todo — không chứng minh được`);
        continue;
      }
      if (found.some((x) => provesParallelCall(x, e.route, calls))) continue;
      // MỌI test được dẫn phải chứng minh (không để mục dẫn test của route khác làm "bằng chứng" phụ).
      errors.push(
        `${at}: test "${t.name}" không gọi route song song — cần lời gọi \`Promise.all(…)\` thật và literal chứa đủ đường dẫn ${e.route.split(" ")[1]} trong thân test${calls ? `, hoặc gọi \`${calls}(…)\` khai trong cùng file có literal đó` : " (hoặc khai `calls` = tên hàm phụ chứa literal)"}`,
      );
    }
  }
  return { errors, byRoute };
}

/** Khoá (chuỗi) của object `KEYED` trong spec tích hợp — kịch bản gửi lại/khác nội dung/song song mỗi route nhận khoá. */
export function keyedScenariosOf(source, fileName = "idempotency.spec.ts") {
  const sf = sourceFile(fileName, source);
  const keys = new Set();
  const visit = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "KEYED" &&
      n.initializer &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      for (const p of n.initializer.properties) {
        const k = p.name && literalText(p.name);
        if (k) keys.add(k);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return keys;
}

const IDEMPOTENCY_PARAM = "#/components/parameters/IdempotencyKey";
const KEYED_CONFLICT = "#/components/responses/KeyedConflict";

/** Đối chiếu khai báo idempotency trong OpenAPI với mã + allowlist (chỉ route có trong spec). */
export function checkSpec(spec, handlers, byRoute) {
  const errors = [];
  for (const h of handlers) {
    const [method, path] = h.route.split(" ");
    const op = spec?.paths?.[path]?.[method.toLowerCase()];
    if (!op) continue; // route ngoài spec (vd ghi đè route native) — check-openapi lo phần phủ spec
    const expected = h.mode === "key" ? "key" : byRoute.get(h.route)?.kind;
    if (expected && op["x-idempotency"] !== expected) {
      errors.push(
        `openapi ${h.route}: x-idempotency=${String(op["x-idempotency"])} (mã/allowlist: ${expected})`,
      );
    }
    const hasKeyParam = (op.parameters ?? []).some((p) => p?.$ref === IDEMPOTENCY_PARAM);
    if (h.mode === "key") {
      if (!hasKeyParam)
        errors.push(`openapi ${h.route}: route nhận Idempotency-Key nhưng thiếu tham số IdempotencyKey`);
      if (op.responses?.["409"]?.$ref !== KEYED_CONFLICT) {
        errors.push(
          `openapi ${h.route}: phản hồi 409 phải là $ref KeyedConflict (khác nội dung / đang xử lý)`,
        );
      }
      if (!op.responses?.["422"])
        errors.push(`openapi ${h.route}: thiếu phản hồi 422 (thiếu/sai Idempotency-Key)`);
    } else if (hasKeyParam) {
      errors.push(`openapi ${h.route}: khai tham số IdempotencyKey nhưng mã không nhận khoá`);
    }
  }
  return errors;
}

export function checkIdempotency({
  root,
  allowlistPath = ALLOWLIST_PATH,
  specPath = SPEC_PATH,
  keyedSpecPath = KEYED_SPEC_PATH,
}) {
  const { handlers, problems } = scanRoutes(root);
  const list = JSON.parse(readFileSync(join(root, allowlistPath), "utf8"));
  const spec = parse(readFileSync(join(root, specPath), "utf8"));
  const keyedPath = join(root, keyedSpecPath);
  const scenarios = existsSync(keyedPath) ? keyedScenariosOf(readFileSync(keyedPath, "utf8")) : new Set();
  const errors = [...problems];
  const allow = checkAllowlist(root, list);
  errors.push(...allow.errors);
  const { byRoute } = allow;
  const inCode = new Set(handlers.map((h) => h.route));
  for (const h of handlers) {
    if (h.mode === "unvalidated") {
      errors.push(
        `${h.route} (${h.file}): đọc Idempotency-Key nhưng không kiểm bắt buộc (isValidIdempotencyKey)`,
      );
    } else if (h.mode === "key") {
      if (byRoute.has(h.route)) errors.push(`${h.route}: đã nhận Idempotency-Key — bỏ mục allowlist`);
      if (!scenarios.has(h.route)) {
        errors.push(
          `${h.route}: route nhận Idempotency-Key nhưng thiếu kịch bản trong KEYED của ${keyedSpecPath} (gửi lại / khác nội dung / song song)`,
        );
      }
    } else if (!byRoute.has(h.route)) {
      errors.push(
        `${h.route} (${h.file}): route ghi không nhận Idempotency-Key và không có trong allowlist — thêm khoá (Q-06: bắt buộc cho POST tạo) hoặc mục allowlist có lý do + test song song`,
      );
    }
  }
  const keyed = new Set(handlers.filter((h) => h.mode === "key").map((h) => h.route));
  for (const s of scenarios) {
    if (!keyed.has(s))
      errors.push(`KEYED "${s}" (${keyedSpecPath}): không phải route nhận Idempotency-Key trong mã`);
  }
  for (const route of byRoute.keys()) {
    if (!inCode.has(route)) errors.push(`allowlist ${route}: không còn route trong mã — xoá mục`);
  }
  errors.push(...checkSpec(spec, handlers, byRoute));
  return {
    errors,
    total: handlers.length,
    keyed: keyed.size,
    allowlisted: handlers.filter((h) => h.mode === null && byRoute.has(h.route)).length,
    byKind: Object.fromEntries(
      KINDS.map((k) => [
        k,
        handlers.filter((h) => h.mode === null && byRoute.get(h.route)?.kind === k).length,
      ]),
    ),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argRoot = process.argv.indexOf("--root");
  const root =
    argRoot > 0 && process.argv[argRoot + 1]
      ? resolve(process.argv[argRoot + 1])
      : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let result;
  try {
    result = checkIdempotency({ root });
  } catch (e) {
    console.error(
      `check-idempotency: không đọc/parse được đầu vào: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(2);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`✗ ${e}`);
    console.error(`check-idempotency: ${result.errors.length} lỗi`);
    process.exit(1);
  }
  console.log(
    `check-idempotency: OK — ${result.total} handler ghi: ${result.keyed} nhận Idempotency-Key, ${result.allowlisted} trong allowlist (${KINDS.map((k) => `${k} ${result.byKind[k]}`).join(", ")})`,
  );
}
