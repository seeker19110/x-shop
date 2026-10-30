#!/usr/bin/env node
// Chặn thay đổi phá vỡ hợp đồng API (`node scripts/check-api-breaking.mjs [--base <ref>] [--root <dir>]`) — T-194,
// STD-API-008, STD-PROC-003, QA-INT-007.
//
// So docs/design/openapi.yaml giữa base (mặc định `origin/master`, hoặc env BASE_SHA; so với merge-base của base và HEAD,
// đọc bằng `git show`, không checkout) và HEAD (working tree). `$ref` nội bộ (`#/...`) được giải trước khi so; vòng lặp
// $ref được chặn bằng bộ nhớ cặp (cũ, mới) đã so.
//
// Quy tắc PHÁ VỠ (tham khảo bộ luật `oasdiff breaking` — chưa xác minh từng mã luật với bản oasdiff hiện hành; danh sách
// dưới đây là chính sách của dự án, không phải bản sao oasdiff):
//   Cấp path/operation
//     P1  xoá path đã có.
//     P2  xoá operation (phương thức) đã có.
//   Response (mọi mã trạng thái có ở cả hai bản; schema `content` so theo từng media type có ở bản cũ)
//     R1  xoá mã response thành công (2xx).
//     R2  xoá media type của response đã có.
//     R3  xoá / đổi tên property của response (mọi độ sâu: object lồng, items mảng, allOf).
//     R4  đổi kiểu: kiểu mới không nằm trong tập kiểu cũ (vd string→integer, integer→number, thêm `null`).
//     R5  property từng `required` trong response nay tuỳ chọn.
//     R6  thu hẹp enum của response (bỏ giá trị đã có).
//     W1  CẢNH BÁO (in ra, không đỏ — D-145): thêm giá trị enum vào response; client chặt có thể vỡ, oasdiff cũng chỉ cảnh báo.
//   Request (tham số + requestBody)
//     Q1  thêm tham số bắt buộc mới; tham số tuỳ chọn → bắt buộc.
//     Q2  thêm requestBody bắt buộc khi trước không có; requestBody tuỳ chọn → bắt buộc.
//     Q3  thêm property request bắt buộc; property request tuỳ chọn → bắt buộc.
//     Q4  đổi kiểu của tham số/property request theo hướng thu hẹp (kiểu cũ không nằm trong tập kiểu mới).
//     Q5  thu hẹp enum request (bỏ giá trị đã chấp nhận) hoặc thêm enum vào trường trước đó không có.
//     Q6  siết ràng buộc request: tăng minimum/minLength/minItems, giảm maximum/maxLength/maxItems, thêm/đổi pattern.
//     Q7  xoá property request khi schema mới `additionalProperties: false` (client cũ gửi sẽ bị từ chối).
//   Không xét (giới hạn đã biết): oneOf/anyOf (so theo chỉ số khi cùng số nhánh, khác số nhánh bỏ qua), security,
//   đổi `description`/`example`, xoá tham số tuỳ chọn, thêm property/response mới (tương thích ngược).
//
// Allowlist có bằng chứng (D-145): scripts/api-breaking-allowlist.json — mục khớp (rule, method, path, location, name) bị bỏ
// qua; mục không khớp thay đổi nào (base đã chứa) → exit 1 (mục thừa); thiếu reason (≥ 20 ký tự)/evidence (file:dòng) → exit 2.
//
// Ngoại lệ có kiểm soát — chỉ khi ĐỒNG THỜI:
//   (a) env PR_LABELS (mảng JSON tên nhãn như check-fix-pr, hoặc phân tách bằng dấu phẩy/xuống dòng) có nhãn `breaking`; và
//   (b) tiêu đề PR (env PR_TITLE) hoặc commit trong `merge-base..HEAD` (đọc bằng `git log`, cả tiêu đề lẫn thân) có
//       `BREAKING CHANGE:` / `BREAKING-CHANGE:` đầu dòng hoặc tiêu đề dạng `type(scope)!:`.
//   Chọn đọc commit trực tiếp bằng git (không dùng COMMIT_SUBJECTS_FILE như check-specs) vì `BREAKING CHANGE:` nằm ở thân
//   commit mà tệp subject không có. Dữ liệu PR đi qua env, không nội suy vào shell.
//
// Thoát 0 = không phá vỡ (hoặc được phép); 1 = phá vỡ không được phép; 2 = lỗi đầu vào (ref, YAML, git).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

export const OPENAPI_PATH = "docs/design/openapi.yaml";
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** Giải `$ref` nội bộ `#/a/b/c` (có giải escape JSON Pointer `~1`, `~0`). Ref ngoài/không có thật → ném lỗi. */
export function deref(doc, node) {
  let cur = node;
  const seen = new Set();
  while (cur && typeof cur === "object" && typeof cur.$ref === "string") {
    const ref = cur.$ref;
    if (!ref.startsWith("#/")) throw new Error(`$ref ngoài tài liệu chưa hỗ trợ: ${ref}`);
    if (seen.has(ref)) throw new Error(`$ref vòng: ${ref}`);
    seen.add(ref);
    let t = doc;
    for (const raw of ref.slice(2).split("/")) {
      const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (t === null || typeof t !== "object" || !(k in t)) throw new Error(`$ref không tồn tại: ${ref}`);
      t = t[k];
    }
    cur = t;
  }
  return cur;
}

const typesOf = (s) => {
  if (s.type === undefined) return null;
  return new Set(Array.isArray(s.type) ? s.type : [s.type]);
};
const isSubset = (a, b) => [...a].every((x) => b.has(x));

/** Gộp `allOf` thành một schema phẳng (properties/required/type); giữ phần còn lại của schema gốc. */
function flatten(doc, schema) {
  const s = deref(doc, schema) ?? {};
  if (!Array.isArray(s.allOf)) return s;
  const merged = { ...s };
  delete merged.allOf;
  merged.properties = { ...(s.properties ?? {}) };
  merged.required = [...(s.required ?? [])];
  for (const part of s.allOf) {
    const f = flatten(doc, part);
    Object.assign(merged.properties, f.properties ?? {});
    merged.required.push(...(f.required ?? []));
    for (const k of ["type", "enum", "items", "additionalProperties"])
      if (merged[k] === undefined && f[k] !== undefined) merged[k] = f[k];
  }
  return merged;
}

/**
 * So hai schema theo hướng `dir`: "response" (đầu ra) hoặc "request" (đầu vào). Đẩy mô tả phá vỡ vào `out`.
 * `memo` (WeakMap) chặn vòng lặp vô hạn khi schema tự tham chiếu.
 */
export function compareSchema(docOld, docNew, so, sn, dir, where, out, memo = new WeakMap()) {
  const o = flatten(docOld, so);
  const n = flatten(docNew, sn);
  if (typeof o !== "object" || typeof n !== "object") return;
  const seen = memo.get(o) ?? new Set();
  if (seen.has(n)) return;
  seen.add(n);
  memo.set(o, seen);

  const to = typesOf(o);
  const tn = typesOf(n);
  if (to && tn) {
    if (dir === "response" && !isSubset(tn, to))
      out.push(`${where}: đổi kiểu (${[...to]} → ${[...tn]}) [R4]`);
    if (dir === "request" && !isSubset(to, tn))
      out.push(`${where}: thu hẹp kiểu (${[...to]} → ${[...tn]}) [Q4]`);
  }

  if (Array.isArray(o.enum) && Array.isArray(n.enum)) {
    const gone = o.enum.filter((v) => !n.enum.some((w) => w === v));
    if (gone.length > 0)
      out.push(`${where}: thu hẹp enum, bỏ ${JSON.stringify(gone)} [${dir === "response" ? "R6" : "Q5"}]`);
    const added = n.enum.filter((v) => !o.enum.some((w) => w === v));
    if (dir === "response" && added.length > 0)
      out.push(`${where}: thêm giá trị enum response ${JSON.stringify(added)} — client chặt có thể vỡ [W1]`);
  } else if (dir === "request" && Array.isArray(n.enum) && o.enum === undefined) {
    out.push(`${where}: thêm ràng buộc enum ${JSON.stringify(n.enum)} [Q5]`);
  }

  if (dir === "request") {
    for (const k of ["minimum", "minLength", "minItems"])
      if (typeof n[k] === "number" && (o[k] === undefined || n[k] > o[k]))
        out.push(`${where}: siết ${k} (${o[k] ?? "không có"} → ${n[k]}) [Q6]`);
    for (const k of ["maximum", "maxLength", "maxItems"])
      if (typeof n[k] === "number" && (o[k] === undefined || n[k] < o[k]))
        out.push(`${where}: siết ${k} (${o[k] ?? "không có"} → ${n[k]}) [Q6]`);
    if (typeof n.pattern === "string" && n.pattern !== o.pattern) out.push(`${where}: thêm/đổi pattern [Q6]`);
  }

  const po = o.properties ?? {};
  const pn = n.properties ?? {};
  const ro = new Set(o.required ?? []);
  const rn = new Set(n.required ?? []);
  for (const key of Object.keys(po)) {
    if (!(key in pn)) {
      if (dir === "response") out.push(`${where}.${key}: property bị xoá/đổi tên [R3]`);
      else if (n.additionalProperties === false)
        out.push(`${where}.${key}: property request bị xoá, schema mới đóng [Q7]`);
      continue;
    }
    compareSchema(docOld, docNew, po[key], pn[key], dir, `${where}.${key}`, out, memo);
  }
  if (dir === "response") {
    for (const key of ro)
      if (key in pn && !rn.has(key)) out.push(`${where}.${key}: từng bắt buộc, nay tuỳ chọn [R5]`);
  } else {
    for (const key of rn) {
      if (!(key in po)) out.push(`${where}.${key}: thêm property request bắt buộc [Q3]`);
      else if (!ro.has(key)) out.push(`${where}.${key}: property request tuỳ chọn → bắt buộc [Q3]`);
    }
  }

  if (o.items !== undefined && n.items !== undefined && !Array.isArray(o.items))
    compareSchema(docOld, docNew, o.items, n.items, dir, `${where}[]`, out, memo);
  if (
    o.additionalProperties &&
    typeof o.additionalProperties === "object" &&
    n.additionalProperties &&
    typeof n.additionalProperties === "object"
  )
    compareSchema(
      docOld,
      docNew,
      o.additionalProperties,
      n.additionalProperties,
      dir,
      `${where}{*}`,
      out,
      memo,
    );

  for (const k of ["oneOf", "anyOf"])
    if (Array.isArray(o[k]) && Array.isArray(n[k]) && o[k].length === n[k].length)
      o[k].forEach((v, i) =>
        compareSchema(docOld, docNew, v, n[k][i], dir, `${where}<${k}#${i}>`, out, memo),
      );
}

function paramMap(doc, pathItem, op) {
  const m = new Map();
  for (const p of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const r = deref(doc, p);
    m.set(`${r.in}:${r.name}`, r);
  }
  return m;
}

/**
 * Bản ghi có cấu trúc cho từng thay đổi: { rule, method, path, location, name, text }. `location` = "path" | "operation" |
 * "param" | "body" | "response"; `name` = tên tham số, hoặc đường dẫn property trong body/response ("" = chính nó).
 * Rule bắt đầu bằng `W` là cảnh báo (không làm đỏ).
 */
export function diffDetailed(docOld, docNew) {
  const all = [];
  const rec = (method, path, location, base, name) => ({
    push(text) {
      const rule = /\[([A-Z]\d)\]$/.exec(text)?.[1] ?? "?";
      const where = text.slice(0, text.indexOf(": "));
      const suffix = where.startsWith(base) ? where.slice(base.length).replace(/^\./, "") : "";
      const full = location === "param" ? `${name}${suffix === "" ? "" : `.${suffix}`}` : suffix;
      all.push({ rule, method, path, location, name: full, text });
    },
  });
  const pathsOld = docOld.paths ?? {};
  const pathsNew = docNew.paths ?? {};
  for (const [path, itemOldRaw] of Object.entries(pathsOld)) {
    if (!(path in pathsNew)) {
      rec("*", path, "path", path, "").push(`${path}: xoá path [P1]`);
      continue;
    }
    const itemOld = deref(docOld, itemOldRaw);
    const itemNew = deref(docNew, pathsNew[path]);
    for (const method of METHODS) {
      const opOld = itemOld[method];
      if (!opOld) continue;
      const opNew = itemNew[method];
      const M = method.toUpperCase();
      const tag = `${M} ${path}`;
      if (!opNew) {
        rec(M, path, "operation", tag, "").push(`${tag}: xoá operation [P2]`);
        continue;
      }
      // Tham số.
      const pOld = paramMap(docOld, itemOld, opOld);
      const pNew = paramMap(docNew, itemNew, opNew);
      for (const [k, np] of pNew) {
        const op = pOld.get(k);
        const out = rec(M, path, "param", `${tag} param ${k}`, np.name);
        if (!op) {
          if (np.required) out.push(`${tag} param ${k}: thêm tham số bắt buộc [Q1]`);
          continue;
        }
        if (np.required && !op.required) out.push(`${tag} param ${k}: tham số tuỳ chọn → bắt buộc [Q1]`);
        if (op.schema && np.schema)
          compareSchema(docOld, docNew, op.schema, np.schema, "request", `${tag} param ${k}`, out);
      }
      // requestBody.
      const bOld = opOld.requestBody ? deref(docOld, opOld.requestBody) : undefined;
      const bNew = opNew.requestBody ? deref(docNew, opNew.requestBody) : undefined;
      if (bNew) {
        if (bNew.required && !(bOld && bOld.required))
          rec(M, path, "body", `${tag} body`, "").push(
            `${tag} body: requestBody ${bOld ? "tuỳ chọn → bắt buộc" : "bắt buộc mới"} [Q2]`,
          );
        if (bOld)
          for (const [mt, c] of Object.entries(bOld.content ?? {})) {
            const cn = (bNew.content ?? {})[mt];
            const base = `${tag} body(${mt})`;
            if (cn?.schema && c?.schema)
              compareSchema(
                docOld,
                docNew,
                c.schema,
                cn.schema,
                "request",
                base,
                rec(M, path, "body", base, ""),
              );
          }
      }
      // Responses.
      const rOld = opOld.responses ?? {};
      const rNew = opNew.responses ?? {};
      for (const [code, respOldRaw] of Object.entries(rOld)) {
        if (!(code in rNew)) {
          if (/^2/.test(code))
            rec(M, path, "response", `${tag} ${code}`, "").push(
              `${tag} ${code}: xoá response thành công [R1]`,
            );
          continue;
        }
        const respOld = deref(docOld, respOldRaw);
        const respNew = deref(docNew, rNew[code]);
        for (const [mt, c] of Object.entries(respOld.content ?? {})) {
          const cn = (respNew.content ?? {})[mt];
          const base = `${tag} ${code}(${mt})`;
          if (!cn) {
            rec(M, path, "response", base, "").push(`${base}: xoá media type [R2]`);
            continue;
          }
          if (c?.schema && cn.schema)
            compareSchema(
              docOld,
              docNew,
              c.schema,
              cn.schema,
              "response",
              base,
              rec(M, path, "response", base, ""),
            );
        }
      }
    }
  }
  return all;
}

/** Danh sách mô tả PHÁ VỠ (không gồm cảnh báo `W*`) khi chuyển từ `docOld` sang `docNew` (đã parse). */
export function diffSpecs(docOld, docNew) {
  return diffDetailed(docOld, docNew)
    .filter((d) => !d.rule.startsWith("W"))
    .map((d) => d.text);
}

/** Có `BREAKING CHANGE:` đầu dòng (thân/footer) hoặc tiêu đề `type(scope)!:`. Regex không có nhóm lặp mơ hồ. */
export function hasBreakingMarker(text) {
  if (/^BREAKING[ -]CHANGE:/m.test(text)) return true;
  return /^[a-z]+(?:\([^)\r\n]*\))?!:/m.test(text);
}

/** PR_LABELS: mảng JSON tên nhãn (như check-fix-pr, từ `toJSON(...labels.*.name)`) hoặc danh sách phân tách `,`/xuống dòng. */
export function parseLabels(raw) {
  const text = (raw ?? "").trim();
  let names;
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      names = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      names = [];
    }
  } else names = text.split(/[,\r\n]/);
  return names.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Được phép phá vỡ khi có nhãn `breaking` VÀ có dấu hiệu BREAKING trong tiêu đề PR hoặc commit. */
export function isBreakingAllowed({ labels, title, commitMessages }) {
  return parseLabels(labels).includes("breaking") && [title ?? "", ...commitMessages].some(hasBreakingMarker);
}

export const ALLOWLIST_PATH = "scripts/api-breaking-allowlist.json";
const entryKey = (e) => `${e.rule} ${String(e.method).toUpperCase()} ${e.path} ${e.location} ${e.name}`;

/**
 * Đọc allowlist `{ "entries": [{ rule, method, path, location, name, reason, evidence }] }`. Không có tệp = rỗng.
 * Mục thiếu trường / `reason` < 20 ký tự / `evidence` không dạng file:dòng → lỗi (exit 2). `evidence` = `file:dòng` của
 * code server đã ép giới hạn đó TRƯỚC PR (kiểm lại bằng lệnh đọc file ở base); `location` = param|body|response|path|operation.
 */
export function loadAllowlist(root) {
  let raw;
  try {
    raw = readFileSync(join(root, ALLOWLIST_PATH), "utf8");
  } catch {
    return { entries: [] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { entries: [], error: `${ALLOWLIST_PATH} không phải JSON: ${e.message}` };
  }
  const entries = data?.entries;
  if (!Array.isArray(entries)) return { entries: [], error: `${ALLOWLIST_PATH}: thiếu mảng "entries"` };
  for (const [i, e] of entries.entries()) {
    for (const f of ["rule", "method", "path", "location", "name"])
      if (typeof e?.[f] !== "string")
        return { entries: [], error: `${ALLOWLIST_PATH}[${i}]: thiếu trường "${f}"` };
    if (typeof e.reason !== "string" || e.reason.trim().length < 20)
      return { entries: [], error: `${ALLOWLIST_PATH}[${i}]: "reason" phải ≥ 20 ký tự` };
    if (typeof e.evidence !== "string" || !/\S+:\d+/.test(e.evidence))
      return { entries: [], error: `${ALLOWLIST_PATH}[${i}]: "evidence" phải dạng file:dòng` };
  }
  return { entries };
}

const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

export function run({ root, base, env }) {
  let mergeBase;
  try {
    mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  } catch {
    try {
      mergeBase = git(root, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
    } catch (e) {
      return {
        code: 2,
        lines: [
          `check-api-breaking: không tìm thấy base ref "${base}": ${String(e.stderr ?? e.message).trim()}`,
        ],
      };
    }
  }
  let oldText;
  try {
    oldText = git(root, ["show", `${mergeBase}:${OPENAPI_PATH}`]);
  } catch {
    return { code: 0, lines: [`check-api-breaking: base không có ${OPENAPI_PATH} — bỏ qua.`] };
  }
  let newText;
  try {
    newText = readFileSync(join(root, OPENAPI_PATH), "utf8");
  } catch (e) {
    return { code: 2, lines: [`check-api-breaking: không đọc được ${OPENAPI_PATH}: ${e.message}`] };
  }
  let detailed;
  try {
    detailed = diffDetailed(parse(oldText), parse(newText));
  } catch (e) {
    return { code: 2, lines: [`check-api-breaking: lỗi phân tích: ${e.message}`] };
  }
  const warnings = detailed.filter((d) => d.rule.startsWith("W"));
  let found = detailed.filter((d) => !d.rule.startsWith("W"));
  const lines = warnings.map((w) => `check-api-breaking: CẢNH BÁO ${w.text}`);

  // Allowlist có bằng chứng (D-145): bỏ qua thay đổi khớp mục; mục không khớp gì → thừa → đỏ.
  const loaded = loadAllowlist(root);
  if (loaded.error) return { code: 2, lines: [...lines, `check-api-breaking: ${loaded.error}`] };
  const used = new Set();
  found = found.filter((d) => {
    const key = entryKey(d);
    if (!loaded.entries.some((e) => entryKey(e) === key)) return true;
    used.add(key);
    return false;
  });
  const stale = loaded.entries.filter((e) => !used.has(entryKey(e)));
  if (stale.length > 0) {
    lines.push(
      `check-api-breaking: ${stale.length} mục thừa trong ${ALLOWLIST_PATH} (base đã chứa thay đổi hoặc không còn khớp) — xoá mục:`,
      ...stale.map((e) => `  - ${entryKey(e)}`),
    );
  }
  const staleCode = stale.length > 0 ? 1 : 0;
  const breaks = found.map((d) => d.text);
  if (breaks.length === 0) {
    lines.push("check-api-breaking: không có thay đổi phá vỡ hợp đồng (ngoài allowlist).");
    return { code: staleCode, lines };
  }

  let commitMessages = [];
  try {
    commitMessages = git(root, ["log", "--format=%B%x00", `${mergeBase}..HEAD`])
      .split("\0")
      .filter(Boolean);
  } catch {
    /* không đọc được lịch sử → coi như không có dấu hiệu */
  }
  lines.push(
    `check-api-breaking: ${breaks.length} thay đổi phá vỡ hợp đồng so với ${base}:`,
    ...breaks.map((b) => `  - ${b}`),
  );
  if (isBreakingAllowed({ labels: env.PR_LABELS, title: env.PR_TITLE, commitMessages })) {
    lines.push("Được phép: nhãn `breaking` + dấu hiệu BREAKING CHANGE/`!:` trong tiêu đề hoặc commit.");
    return { code: staleCode, lines };
  }
  lines.push(
    "Không được phép. Muốn phá vỡ có chủ đích: gắn nhãn PR `breaking` VÀ ghi `BREAKING CHANGE: <mô tả>` trong thân commit (hoặc tiêu đề `type!:`); nếu không, giữ tương thích ngược (thêm field/endpoint mới, không xoá/đổi).",
  );
  return { code: 1, lines };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = opt("--root") ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const base = opt("--base") ?? process.env.BASE_SHA ?? "origin/master";
  const { code, lines } = run({ root, base, env: process.env });
  for (const l of lines) (code === 0 ? console.log : console.error)(l);
  process.exit(code);
}
