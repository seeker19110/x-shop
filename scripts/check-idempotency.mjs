#!/usr/bin/env node
// Kiểm idempotency của mọi handler ghi trong apps/backend/src/api/**/route.ts (T-187; ARC-INT-001, BE-API-008; Q-06/Q-07
// của docs/autopilot/PLAN-2.md) — `pnpm check:idempotency`.
//
// Mỗi handler POST/PUT/PATCH/DELETE phải thuộc đúng MỘT trong hai nhóm:
//  1. Nhận `Idempotency-Key` BẮT BUỘC: gọi `idempotencyKeyOf(req)` (workflows/returns/http.ts) hoặc đọc
//     `req.get("Idempotency-Key")` kèm `isValidIdempotencyKey(...)` trong chính handler.
//  2. Nằm trong scripts/idempotency-allowlist.json với `kind` (state | natural-key | no-business-effect), `reason` và ít
//     nhất một test chứng minh gọi SONG SONG (`tests[].file` có thật, chứa đúng `tests[].name`; tên có "song song"/"đồng
//     thời"/"∥"/"×N").
// Lỗi: route ghi mới thiếu cả hai; mục allowlist không còn route (hoặc route đã nhận key); test được dẫn không có.
// Đối chiếu OpenAPI (docs/design/openapi.yaml) cho route có trong spec: `x-idempotency` = `key` hoặc đúng `kind` của
// allowlist; route nhận key khai tham số `IdempotencyKey`, phản hồi 409 = `KeyedConflict`, có 422; route không nhận key
// không khai tham số đó.
//
// Thoát 0 = đạt; 1 = có lỗi (in từng dòng); 2 = không đọc được đầu vào.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

export const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
export const KINDS = ["state", "natural-key", "no-business-effect"];
export const ALLOWLIST_PATH = "scripts/idempotency-allowlist.json";
export const SPEC_PATH = "docs/design/openapi.yaml";
const API_DIR = "apps/backend/src/api";
const MIN_REASON = 30;
/** Tên test phải nói rõ là ca song song. */
export const PARALLEL_NAME = /song song|đồng thời|∥|‖|×\s*\d/i;

const EXPORT_RE =
  /export\s+(?:async\s+function|function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
const KEY_HELPER_RE = /\bidempotencyKeyOf\s*\(\s*req\b/;
const KEY_READ_RE = /\.get\(\s*["'`]Idempotency-Key["'`]\s*\)/i;
const KEY_VALIDATE_RE = /\bisValidIdempotencyKey\s*\(/;

/** `[id]` → `{id}`; đường dẫn tính từ thư mục api. */
export function routePathOf(apiDir, file) {
  const rel = relative(apiDir, dirname(file)).split(sep).join("/");
  return "/" + rel.replace(/\[([^\]]+)\]/g, "{$1}");
}

/**
 * Các handler export trong một route.ts kèm đoạn mã của nó (từ export tới export kế). File chỉ có MỘT handler ghi thì
 * đoạn của handler ghi là cả file (hàm phụ khai trước export vẫn được tính).
 */
export function handlersOfSource(source) {
  const marks = [...source.matchAll(EXPORT_RE)].map((m) => ({ method: m[1], index: m.index }));
  const writes = marks.filter((m) => WRITE_METHODS.includes(m.method));
  return marks
    .map((m, i) => ({
      method: m.method,
      body: writes.length === 1 ? source : source.slice(m.index, marks[i + 1]?.index ?? source.length),
    }))
    .filter((h) => WRITE_METHODS.includes(h.method));
}

/** "key" = nhận khoá bắt buộc; "unvalidated" = đọc header mà không kiểm; null = không nhận. */
export function keyModeOf(body) {
  if (KEY_HELPER_RE.test(body)) return "key";
  if (KEY_READ_RE.test(body)) return KEY_VALIDATE_RE.test(body) ? "key" : "unvalidated";
  return null;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

/** Mọi handler ghi trong cây api: [{ route: "POST /path", file, mode }]. */
export function writeHandlers(root) {
  const apiDir = join(root, API_DIR);
  const out = [];
  for (const file of walk(apiDir)) {
    const path = routePathOf(apiDir, file);
    for (const h of handlersOfSource(readFileSync(file, "utf8"))) {
      out.push({
        route: `${h.method} ${path}`,
        file: relative(root, file).split(sep).join("/"),
        mode: keyModeOf(h.body),
      });
    }
  }
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

/** Kiểm cấu trúc allowlist + test được dẫn; trả { errors, byRoute }. */
export function checkAllowlist(root, list) {
  const errors = [];
  const byRoute = new Map();
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
    const tests = Array.isArray(e.tests) ? e.tests : [];
    if (tests.length === 0) errors.push(`${at}: thiếu \`tests\` (test song song chứng minh)`);
    let parallel = false;
    for (const t of tests) {
      if (typeof t?.file !== "string" || typeof t?.name !== "string" || t.name.length < 10) {
        errors.push(`${at}: mục test phải có \`file\` và \`name\` (≥ 10 ký tự)`);
        continue;
      }
      const p = join(root, t.file);
      if (!existsSync(p)) {
        errors.push(`${at}: không có file test ${t.file}`);
        continue;
      }
      if (!readFileSync(p, "utf8").includes(t.name)) {
        errors.push(`${at}: ${t.file} không có test "${t.name}"`);
        continue;
      }
      if (PARALLEL_NAME.test(t.name)) parallel = true;
    }
    if (tests.length > 0 && !parallel) {
      errors.push(`${at}: không test nào là ca song song (tên cần "song song"/"đồng thời"/"∥"/"×N")`);
    }
  }
  return { errors, byRoute };
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

export function checkIdempotency({ root, allowlistPath = ALLOWLIST_PATH, specPath = SPEC_PATH }) {
  const handlers = writeHandlers(root);
  const list = JSON.parse(readFileSync(join(root, allowlistPath), "utf8"));
  const spec = parse(readFileSync(join(root, specPath), "utf8"));
  const { errors, byRoute } = checkAllowlist(root, list);
  const inCode = new Set(handlers.map((h) => h.route));
  for (const h of handlers) {
    if (h.mode === "unvalidated") {
      errors.push(
        `${h.route} (${h.file}): đọc Idempotency-Key nhưng không kiểm bắt buộc (isValidIdempotencyKey)`,
      );
    } else if (h.mode === "key" && byRoute.has(h.route)) {
      errors.push(`${h.route}: đã nhận Idempotency-Key — bỏ mục allowlist`);
    } else if (h.mode === null && !byRoute.has(h.route)) {
      errors.push(
        `${h.route} (${h.file}): route ghi không nhận Idempotency-Key và không có trong allowlist — thêm khoá (Q-06: bắt buộc cho POST tạo) hoặc mục allowlist có lý do + test song song`,
      );
    }
  }
  for (const route of byRoute.keys()) {
    if (!inCode.has(route)) errors.push(`allowlist ${route}: không còn route trong mã — xoá mục`);
  }
  errors.push(...checkSpec(spec, handlers, byRoute));
  return {
    errors,
    total: handlers.length,
    keyed: handlers.filter((h) => h.mode === "key").length,
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
