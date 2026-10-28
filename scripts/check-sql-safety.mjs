#!/usr/bin/env node
// Quét SQL dựng bằng nối chuỗi (`node scripts/check-sql-safety.mjs`). BASE-SEC-007 / SEC-WEB-001.
//
// Hai loại phát hiện trong mã nguồn không-test của apps/*/src và packages/*/src (TS/JS):
//  1. Lời gọi "sink" SQL (`.raw(`, `.whereRaw(`/`havingRaw`/`orderByRaw`/`groupByRaw`/`joinRaw`/`selectRaw`, `.execute(`, `.query(`)
//     mà ĐỐI SỐ ĐẦU không phải chuỗi/literal tĩnh: có `${…}`, có nối `+`, hay là biến/biểu thức gọi hàm.
//  2. Literal (template hoặc chuỗi nối `+`) mở đầu bằng động từ SQL (select/insert into/update/delete from/with/…) mà có `${…}`
//     hoặc đang nối `+` với biểu thức — dù chưa đưa thẳng vào sink.
// Nội suy `${…}` (T-179): MỖI biểu thức nội suy trong sink/template SQL phải là hằng định danh được khai trong mục allowlist
// (`idents`: liệt kê nguyên văn từng biểu thức) — không phải biến tham số/đầu vào; biểu thức là tên hằng trần (HOA_SNAKE) còn
// phải được khai `const`/`import` trong chính tệp. Mọi giá trị đi qua binding (`?`/`:name`), không nội suy.
// GIỚI HẠN: `idents` so theo CHỮ biểu thức, không theo nguồn gốc dữ liệu — người duyệt allowlist chịu trách nhiệm xác nhận
// mỗi biểu thức là hằng/mảnh SQL do mã dựng (không từ input); script không chứng minh được điều đó. Biến trần ở sink được truy
// tới khai báo `const|let|var` gần nhất trong tệp (heuristic, không phân tích phạm vi/luồng dữ liệu).
// Mọi phát hiện phải có dòng trong scripts/sql-safety-allowlist.json: { file, match, reason } — `match` là chuỗi con của
// đối số/literal đã gộp khoảng trắng, `reason` giải thích vì sao an toàn (định danh/hằng từ mã, KHÔNG từ input; giá trị đi
// qua tham số `?`/`$n`); `kind` (tuỳ chọn) khoá loại phát hiện, bắt buộc nên dùng cho đối số trần như `sql`. Dòng allowlist không khớp phát hiện nào → lỗi (không để allowlist mục nát). Test không bị quét.
//
// Thoát 0 = đạt; 1 = có phát hiện chưa duyệt / allowlist sai; 2 = không đọc được đầu vào.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SINK_NAMES =
  "raw|whereRaw|andWhereRaw|orWhereRaw|havingRaw|orHavingRaw|orderByRaw|groupByRaw|joinRaw|fromRaw|selectRaw|execute|query";
// `.raw(`, `?.raw(`, `.raw?.(`, `x["raw"](` đều là sink.
const SINK = new RegExp(
  `(?:\\??\\.\\s*(${SINK_NAMES})|\\[\\s*(?:'(${SINK_NAMES})'|"(${SINK_NAMES})")\\s*\\])\\s*(?:\\?\\.)?\\s*(?:<[^>()]*>)?\\(`,
  "g",
);
// Bỏ chú thích/ngoặc đầu (`-- …\nSELECT`, `/* */ SELECT`, `(SELECT`) trước khi so động từ SQL.
const LEADING_NOISE = /^(?:\s+|\(|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/;
const SQL_VERB = /^(select|insert\s+into|update|delete\s+from|with|alter|drop|create|truncate|merge)\b/i;
const startsLikeSql = (text) => SQL_VERB.test(text.replace(LEADING_NOISE, ""));
const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_FILE =
  /(^|\/)(__tests__|integration-tests|node_modules|dist|\.next|\.medusa|migrations)\/|\.(test|spec)\.[a-z]+$|\.d\.ts$/;
const MIN_REASON = 15;

/** Phân tách mã: mask[i] = 1 nếu ký tự i là mã (không nằm trong chuỗi/chú thích/regex); literals: chuỗi & template. */
export function tokenize(src) {
  const mask = new Uint8Array(src.length);
  const literals = [];
  const n = src.length;
  let lastSig = "";

  function skipRegex(i) {
    let inClass = false;
    i++;
    while (i < n && src[i] !== "\n") {
      const c = src[i];
      if (c === "\\") i += 2;
      else {
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) return i + 1;
        i++;
      }
    }
    return i;
  }

  function parseTemplate(i) {
    const start = i;
    i++;
    let interp = false;
    while (i < n) {
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "$" && src[i + 1] === "{") {
        interp = true;
        i = parseCode(i + 2, true);
      } else if (c === "`") {
        i++;
        break;
      } else i++;
    }
    literals.push({ start, end: i, kind: "tpl", interp, text: src.slice(start, i) });
    return i;
  }

  function parseCode(i, untilBrace) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === "/" && d === "/") {
        while (i < n && src[i] !== "\n") i++;
      } else if (c === "/" && d === "*") {
        const e = src.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      } else if (c === "'" || c === '"') {
        const start = i;
        i++;
        while (i < n && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        i++;
        literals.push({ start, end: i, kind: "str", interp: false, text: src.slice(start, i) });
        lastSig = '"';
      } else if (c === "`") {
        i = parseTemplate(i);
        lastSig = '"';
      } else if (c === "/" && (lastSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(lastSig))) {
        i = skipRegex(i);
        lastSig = '"';
      } else {
        if (c === "{") depth++;
        else if (c === "}") {
          if (untilBrace && depth === 0) return i + 1;
          depth--;
        }
        mask[i] = 1;
        if (!/\s/.test(c)) lastSig = c;
        i++;
      }
    }
    return i;
  }

  parseCode(0, false);
  return { mask, literals };
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** Lấy đối số đầu của lời gọi mở ngoặc ở `open` (vị trí `(`): đến dấu `,`/`)` ở mức ngoài cùng. */
function firstArg(src, mask, open) {
  let depth = 0;
  let i = open + 1;
  for (; i < src.length; i++) {
    if (!mask[i]) continue;
    const c = src[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
  }
  return src.slice(open + 1, i);
}

const STATIC_STR = /^(['"])(?:(?!\1)[^\\\n]|\\.)*\1$/;
const STATIC_TPL = /^`(?:[^`\\$]|\\.|\$(?!\{))*`$/;

/** `true` nếu biểu thức chỉ gồm literal tĩnh nối bằng `+` (không có thành phần động). */
export function isStaticSql(expr) {
  const t = expr.trim();
  if (!t) return true; // gọi không đối số
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      cur += c;
      if (c === "\\") cur += t[++i] ?? "";
      else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") {
      q = c;
      cur += c;
    } else if (c === "+") {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.every((p) => {
    const s = p
      .trim()
      .replace(/^\(|\)$/g, "")
      .trim();
    return STATIC_STR.test(s) || STATIC_TPL.test(s);
  });
}

/** Cắt biểu thức theo `+` ở mức ngoài cùng (ngoài chuỗi, ngoài ngoặc). */
function splitConcat(t) {
  const parts = [];
  let cur = "";
  let q = null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      cur += c;
      if (c === "\\") cur += t[++i] ?? "";
      else if (c === q) q = null;
    } else if (c === "'" || c === '"' || c === "`") {
      q = c;
      cur += c;
    } else if (c === "+" && depth === 0 && t[i + 1] !== "+") {
      parts.push(cur);
      cur = "";
    } else {
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth--;
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/** Vị trí ngay sau template literal bắt đầu ở `i` (`s[i] === "`"`); gom biểu thức `${…}` mức ngoài cùng vào `out`. */
function skipTemplate(s, i, out) {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === "`") return i + 1;
    else if (c === "$" && s[i + 1] === "{") {
      const start = i + 2;
      let j = start;
      let depth = 0;
      while (j < s.length) {
        const d = s[j];
        if (d === "'" || d === '"') {
          j++;
          while (j < s.length && s[j] !== d) j += s[j] === "\\" ? 2 : 1;
          j++;
        } else if (d === "`") j = skipTemplate(s, j, null);
        else if (d === "{") {
          depth++;
          j++;
        } else if (d === "}") {
          if (depth === 0) break;
          depth--;
          j++;
        } else j++;
      }
      out?.push(squash(s.slice(start, j)));
      i = j + 1;
    } else i++;
  }
  return i;
}

/** Biểu thức `${…}` mức ngoài cùng của mọi template literal mức ngoài cùng trong `text`. */
export function interpolationExprs(text) {
  const out = [];
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === "`") i = skipTemplate(text, i, out) - 1;
  }
  return out;
}

const BARE_CONST = /^[A-Z][A-Z0-9_]*$/;

/** Tên hằng trần có được khai `const`/`import` trong tệp không (không phải tham số/biến cục bộ cùng tên). */
function isDeclaredConst(src, name) {
  const decl = new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\b`, "m");
  const imp = new RegExp(`^\\s*import\\b[^;]*\\b${name}\\b[^;]*\\bfrom\\b`, "m");
  return decl.test(src) || imp.test(src);
}

/** Biểu thức phải khai trong `idents` của một chuỗi SQL: nối `+` được tách; template → các `${…}`; phần khác → chính nó. */
function sqlExprs(expr) {
  const out = [];
  for (const part of splitConcat(expr)) {
    const t = part.trim();
    if (!t || STATIC_STR.test(t) || STATIC_TPL.test(t)) continue;
    if (t.startsWith("`") && t.endsWith("`") && interpolationExprs(t).length)
      out.push(...interpolationExprs(t));
    else out.push(squash(t));
  }
  return out;
}

const BARE_IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Biểu thức của đối số sink. Biến trần (`whereRaw(sql)`): truy tới khai báo `const|let|var sql =` gần nhất phía trên trong cùng
 * tệp và kiểm khởi tạo như sink trực tiếp; không thấy khai báo (tham số hàm…) hay không phải chuỗi tĩnh → chính tên biến.
 */
function argExprs(src, mask, open, arg) {
  const name = arg.trim();
  if (!BARE_IDENT.test(name)) return sqlExprs(arg);
  const decl = [
    ...src
      .slice(0, open)
      .matchAll(
        new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=(?!=)`, "g"),
      ),
  ].pop();
  if (!decl) return [name];
  const start = decl.index + decl[0].length;
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (!mask[i]) continue;
    const c = src[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) break;
    if (depth < 0) break;
  }
  const init = src.slice(start, i);
  return isStaticSql(init) ? [] : sqlExprs(init);
}

/** Phát hiện trong một tệp: [{ line, kind, sink?, text }]. */
export function scanSource(src) {
  const { mask, literals } = tokenize(src);
  const out = [];
  const seen = new Set();
  const add = (idx, kind, sink, text, exprs = []) => {
    const key = `${idx}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const undeclared = exprs.filter((e) => BARE_CONST.test(e) && !isDeclaredConst(src, e));
    out.push({ line: lineOf(src, idx), kind, sink, text: squash(text), exprs, undeclared });
  };

  const sinkRanges = [];
  for (const m of src.matchAll(SINK)) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1;
    const arg = firstArg(src, mask, open);
    if (isStaticSql(arg)) continue;
    sinkRanges.push([open, open + 1 + arg.length]);
    const kind = arg.includes("${") ? "interpolation" : /[+]/.test(arg) ? "concat" : "dynamic";
    add(open, kind, m[1] ?? m[2] ?? m[3], arg, argExprs(src, mask, open, arg));
  }

  for (const lit of literals) {
    // literal nằm trong đối số của sink đã báo → không báo lần hai
    if (sinkRanges.some(([a, b]) => lit.start >= a && lit.end <= b)) continue;
    if (!startsLikeSql(lit.text.slice(1))) continue;
    if (lit.kind === "tpl" && lit.interp) {
      add(lit.start, "sql-template", undefined, lit.text, interpolationExprs(lit.text));
      continue;
    }
    // chuỗi thường nối `+` với biểu thức: nhìn token liền trước/sau ở mức mã
    const before = src.slice(0, lit.start).trimEnd();
    const after = src.slice(lit.end).trimStart();
    if (before.endsWith("+") || (after.startsWith("+") && !after.startsWith("++"))) {
      add(lit.start, "sql-concat", undefined, lit.text);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Đối chiếu phát hiện với allowlist. Trả { unapproved, errors, used }. */
export function applyAllowlist(findingsByFile, allowlist) {
  const errors = [];
  const used = new Set();
  const unapproved = [];
  const usedIdents = allowlist.map(() => new Set());
  allowlist.forEach((a, idx) => {
    if (
      a &&
      a.idents !== undefined &&
      !(Array.isArray(a.idents) && a.idents.every((x) => typeof x === "string" && x.trim()))
    )
      errors.push(`allowlist[${idx}] (${a.file}): idents phải là mảng chuỗi không rỗng`);
    if (!a || typeof a.file !== "string" || typeof a.match !== "string" || !a.match.trim())
      errors.push(`allowlist[${idx}]: thiếu file/match`);
    else if (typeof a.reason !== "string" || a.reason.trim().length < MIN_REASON)
      errors.push(`allowlist[${idx}] (${a.file}): thiếu lý do (≥ ${MIN_REASON} ký tự)`);
  });
  for (const [file, findings] of Object.entries(findingsByFile)) {
    for (const f of findings) {
      const idx = allowlist.findIndex(
        (a) =>
          a &&
          a.file === file &&
          typeof a.match === "string" &&
          a.match &&
          (a.kind === undefined || a.kind === f.kind) &&
          (a.kind === "dynamic" ? f.text === a.match : f.text.includes(a.match)),
      );
      if (idx < 0) {
        unapproved.push({ file, ...f });
        continue;
      }
      used.add(idx);
      const idents = Array.isArray(allowlist[idx].idents) ? allowlist[idx].idents : [];
      for (const e of f.exprs ?? []) if (idents.includes(e)) usedIdents[idx].add(e);
      const missing = (f.exprs ?? []).filter((e) => !idents.includes(e));
      if (missing.length)
        unapproved.push({
          file,
          ...f,
          text: `nội suy chưa khai trong idents của allowlist: ${missing.map((e) => "${" + e + "}").join(", ")} — ${f.text}`,
        });
      else if (f.undeclared?.length)
        unapproved.push({
          file,
          ...f,
          text: `hằng ${f.undeclared.join(", ")} không được khai const/import trong tệp — ${f.text}`,
        });
    }
  }
  allowlist.forEach((a, idx) => {
    if (a && used.has(idx) && Array.isArray(a.idents))
      for (const e of a.idents)
        if (!usedIdents[idx].has(e))
          errors.push(`allowlist[${idx}] (${a.file}): ident "${e}" không dùng trong phát hiện nào — xoá`);
    if (a && !used.has(idx) && typeof a.match === "string" && a.match)
      errors.push(`allowlist[${idx}] (${a.file}): "${a.match}" không khớp phát hiện nào — xoá dòng mục nát`);
  });
  return { unapproved, errors };
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function listSources(root) {
  const files = [];
  for (const group of ["apps", "packages"]) {
    let names;
    try {
      names = readdirSync(join(root, group), { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const d of names) {
      const src = join(root, group, d.name, "src");
      try {
        files.push(...walk(src));
      } catch {
        // gói không có src/
      }
    }
  }
  return files
    .map((f) => relative(root, f).split(sep).join("/"))
    .filter((f) => SOURCE_FILE.test(f) && !SKIP_FILE.test(f))
    .sort();
}

export function main(root) {
  let allowlist;
  const findingsByFile = {};
  let files;
  try {
    allowlist = JSON.parse(readFileSync(join(root, "scripts/sql-safety-allowlist.json"), "utf8"));
    if (!Array.isArray(allowlist)) throw new Error("allowlist phải là mảng");
    files = listSources(root);
    for (const f of files) {
      const found = scanSource(readFileSync(join(root, f), "utf8"));
      if (found.length) findingsByFile[f] = found;
    }
  } catch (e) {
    console.error(`check-sql-safety: không đọc được đầu vào: ${e.message}`);
    return 2;
  }
  const { unapproved, errors } = applyAllowlist(findingsByFile, allowlist);
  for (const u of unapproved)
    console.error(
      `check-sql-safety: ${u.file}:${u.line} [${u.kind}${u.sink ? ` ${u.sink}` : ""}] ${u.text.slice(0, 160)}`,
    );
  for (const e of errors) console.error(`check-sql-safety: ${e}`);
  if (unapproved.length || errors.length) {
    console.error(
      "check-sql-safety: dùng tham số hoá (`?`/bindings) cho giá trị; định danh động phải là hằng từ mã và được ghi vào scripts/sql-safety-allowlist.json kèm lý do.",
    );
    return 1;
  }
  const approved = Object.values(findingsByFile).reduce((s, a) => s + a.length, 0);
  console.log(
    `check-sql-safety: ${files.length} tệp, ${approved} chỗ động đã duyệt trong allowlist, 0 chưa duyệt`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(join(dirname(fileURLToPath(import.meta.url)), "..")));
}
