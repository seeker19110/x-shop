#!/usr/bin/env node
// Kiểm hợp đồng OpenAPI của route tùy biến (`pnpm check:openapi`).
//
// Kiểm:
//  1. docs/design/openapi.yaml parse được (thư viện `yaml`, ghim chính xác 2.9.1 ở package.json gốc — cần bộ parse YAML
//     đầy đủ; Node không có sẵn và tự viết parser dễ sai), khai `openapi: 3.1.x`.
//  2. Cấu trúc tối thiểu: operationId duy nhất, có responses, tham số đường dẫn khai đủ, mọi `$ref` nội bộ trỏ tới thứ có
//     thật, mọi security scheme được dùng đã định nghĩa.
//  3. Khớp hai chiều với mã: mỗi `route.ts` dưới apps/backend/src/api/{store/x,admin/x,x} (phương thức = export
//     GET/POST/PUT/PATCH/DELETE) có đúng path + phương thức trong spec, và ngược lại.
//  4. Mỗi route admin khai `x-permission` trùng map quyền apps/backend/src/api/admin/x/permissions.ts.
//
// Thoát 0 = đạt; 1 = có lỗi (in từng dòng); 2 = không đọc được đầu vào.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
const API_ROOTS = ["store/x", "admin/x", "x"];

/** `[id]` → `{id}`; chỉ nhận thư mục chứa route.ts. */
export function routePathOf(apiDir, file) {
  const rel = relative(apiDir, dirname(file)).split(sep).join("/");
  return "/" + rel.replace(/\[([^\]]+)\]/g, "{$1}");
}

export function methodsOfSource(source) {
  const found = new Set();
  for (const m of source.matchAll(
    /export\s+(?:async\s+function|function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g,
  )) {
    found.add(m[1].toLowerCase());
  }
  return [...found].sort();
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

/** Tập "METHOD path" của mọi route tùy biến trong mã. */
export function routesInCode(apiDir) {
  const set = new Set();
  for (const root of API_ROOTS) {
    const dir = join(apiDir, root);
    let files;
    try {
      files = walk(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      const path = routePathOf(apiDir, file);
      for (const method of methodsOfSource(readFileSync(file, "utf8"))) set.add(`${method} ${path}`);
    }
  }
  return set;
}

export function routesInSpec(spec) {
  const set = new Set();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) if (item?.[method]) set.add(`${method} ${path}`);
  }
  return set;
}

/** Map quyền admin từ permissions.ts: "method path" → permission. */
export function permissionsInCode(source) {
  const map = new Map();
  const re = /method:\s*"(GET|POST|PUT|PATCH|DELETE)",\s*path:\s*"([^"]+)",\s*permission:\s*"([^"]+)"/g;
  for (const m of source.matchAll(re)) {
    map.set(`${m[1].toLowerCase()} ${m[2].replace(/:([A-Za-z_]+)/g, "{$1}")}`, m[3]);
  }
  return map;
}

function resolveRef(spec, ref) {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), spec);
}

function collectRefs(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

/** Kiểm cấu trúc spec đã parse; trả danh sách lỗi (rỗng = đạt). */
export function checkSpecStructure(spec) {
  const errors = [];
  if (!spec || typeof spec !== "object") return ["spec không phải object"];
  if (typeof spec.openapi !== "string" || !/^3\.1\.\d+$/.test(spec.openapi)) {
    errors.push(`openapi phải là 3.1.x (đang: ${String(spec.openapi)})`);
  }
  if (!spec.info?.title || !spec.info?.version) errors.push("thiếu info.title/info.version");
  if (!spec.paths || Object.keys(spec.paths).length === 0) errors.push("paths rỗng");

  for (const ref of new Set(collectRefs(spec))) {
    if (resolveRef(spec, ref) === undefined) errors.push(`$ref không tồn tại: ${ref}`);
  }

  const schemes = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
  const useSecurity = (reqs, where) => {
    for (const req of reqs ?? []) {
      for (const name of Object.keys(req))
        if (!schemes.has(name)) errors.push(`${where}: security scheme chưa định nghĩa: ${name}`);
    }
  };
  useSecurity(spec.security, "security gốc");

  const operationIds = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const templ = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const shared = (item.parameters ?? []).map((p) => (p.$ref ? resolveRef(spec, p.$ref) : p));
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const where = `${method.toUpperCase()} ${path}`;
      if (!op.operationId) errors.push(`${where}: thiếu operationId`);
      else if (operationIds.has(op.operationId)) {
        errors.push(`${where}: operationId trùng với ${operationIds.get(op.operationId)}`);
      } else operationIds.set(op.operationId, where);
      if (!op.responses || Object.keys(op.responses).length === 0) errors.push(`${where}: thiếu responses`);
      for (const code of Object.keys(op.responses ?? {})) {
        if (!/^[1-5][0-9]{2}$/.test(code)) errors.push(`${where}: mã phản hồi lạ: ${code}`);
      }
      const params = [
        ...shared,
        ...(op.parameters ?? []).map((p) => (p.$ref ? resolveRef(spec, p.$ref) : p)),
      ];
      for (const name of templ) {
        const p = params.find((x) => x?.in === "path" && x.name === name);
        if (!p) errors.push(`${where}: chưa khai tham số đường dẫn {${name}}`);
        else if (p.required !== true)
          errors.push(`${where}: tham số đường dẫn {${name}} phải required: true`);
      }
      for (const p of params) {
        if (p?.in === "path" && !templ.includes(p.name))
          errors.push(`${where}: tham số path thừa: ${p.name}`);
      }
      useSecurity(op.security, where);
    }
  }
  return errors;
}

/** "get /x" → "GET /x" (chỉ viết hoa phương thức, giữ nguyên đường dẫn). */
const fmt = (key) => {
  const [method, ...rest] = key.split(" ");
  return `${method.toUpperCase()} ${rest.join(" ")}`;
};

/** So hai tập; trả lỗi cho phần chỉ có ở một phía. */
export function diffRoutes(code, spec) {
  const errors = [];
  for (const r of [...code].sort())
    if (!spec.has(r)) errors.push(`route có trong mã nhưng thiếu trong openapi: ${fmt(r)}`);
  for (const r of [...spec].sort())
    if (!code.has(r)) errors.push(`openapi có nhưng không có route trong mã: ${fmt(r)}`);
  return errors;
}

export function checkPermissions(spec, perms) {
  const errors = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    if (!path.startsWith("/admin/x/")) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const key = `${method} ${path}`;
      const expected = perms.get(key);
      if (expected === undefined) errors.push(`${fmt(key)}: không có trong permissions.ts`);
      else if (op["x-permission"] !== expected) {
        errors.push(
          `${fmt(key)}: x-permission=${String(op["x-permission"])} khác permissions.ts (${expected})`,
        );
      }
    }
  }
  for (const key of perms.keys()) {
    const [method, path] = key.split(" ");
    if (!spec.paths?.[path]?.[method]) errors.push(`permissions.ts có ${fmt(key)} nhưng openapi thiếu`);
  }
  return errors;
}

export function checkOpenapi({ root, specPath = "docs/design/openapi.yaml" }) {
  const apiDir = join(root, "apps/backend/src/api");
  const spec = parse(readFileSync(join(root, specPath), "utf8"));
  const errors = [...checkSpecStructure(spec)];
  errors.push(...diffRoutes(routesInCode(apiDir), routesInSpec(spec)));
  let perms = null;
  try {
    perms = permissionsInCode(readFileSync(join(apiDir, "admin/x/permissions.ts"), "utf8"));
  } catch {
    errors.push("không đọc được apps/backend/src/api/admin/x/permissions.ts");
  }
  if (perms) errors.push(...checkPermissions(spec, perms));
  return { errors, operations: routesInSpec(spec).size };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let result;
  try {
    result = checkOpenapi({ root });
  } catch (e) {
    console.error(
      `check-openapi: không đọc/parse được đầu vào: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(2);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`✗ ${e}`);
    console.error(`check-openapi: ${result.errors.length} lỗi`);
    process.exit(1);
  }
  console.log(`check-openapi: OK — ${result.operations} thao tác khớp route trong mã`);
}
