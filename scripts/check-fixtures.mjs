#!/usr/bin/env node
// Quét fixture/seed/test tìm dữ liệu cá nhân thật (QA-DATA-002): `node scripts/check-fixtures.mjs [thư-mục-gốc]`.
//
// Phạm vi quét = file dữ liệu thử của dự án (xem `isFixtureFile`): file test/spec, thư mục `__tests__`, `fixtures`, `seeds`,
// `integration-tests`, `e2e`, `scripts/ops/drill`, `scripts/load`, và file tên `seed*`/`fixtures*`/`dataset*`. Không quét docs/.
// Ba luật (mỗi vi phạm in `đường-dẫn:dòng`):
//  1. Email: miền phải thuộc tên dành riêng RFC 2606/6761 — example.com|net|org (kèm miền con), TLD `test`, `example`,
//     `invalid`, `localhost` — hoặc địa chỉ ẩn danh `users.noreply.github.com`. Khuyến nghị dùng `example.test`.
//     Thông tin đăng nhập trong URL (`scheme://user:pass@host`) không phải email nên bị bỏ qua.
//  2. Số điện thoại Việt Nam (10 số bắt đầu 0, hoặc +84/84 + 9 số; cho phép dấu cách, chấm, gạch): chỉ được là số mẫu
//     ghi trong `docs/compliance/test-data-policy.md` (mọi chuỗi 10 số trong dấu backtick). Thiếu file chính sách = lỗi.
//  3. Số định danh công dân 12 số (CCCD) dạng 0PP… với PP là mã tỉnh 001–096: không được xuất hiện.
// Thoát 0 = đạt; 1 = có vi phạm; 2 = không đọc được đầu vào.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const POLICY_PATH = "docs/compliance/test-data-policy.md";
export const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
export const RESERVED_TLDS = ["test", "example", "invalid", "localhost"];
export const ANONYMOUS_DOMAINS = ["users.noreply.github.com"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".medusa",
  ".turbo",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
  ".xtemplates",
  ".claude",
  ".autopilot",
  "docs",
]);
const SCAN_EXT = /\.(?:[cm]?[jt]sx?|json|csv|sql|ya?ml|txt|html)$/i;
// Chính file quét và test của nó chứa ví dụ xấu có chủ đích.
const SELF_FILES = new Set(["scripts/check-fixtures.mjs", "scripts/check-fixtures.test.mjs"]);
const MAX_BYTES = 1_000_000;

const EMAIL_RE = /(?:[A-Za-z0-9._%+*-]+|(?<=\}))@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w])(?:\+84|84|0)(?:[\s.-]?[2-9])(?:[\s.-]?\d){8}(?![\w])/g;
const CCCD_RE = /(?<![\w.])0(?:0[1-9]|[1-8]\d|9[0-6])\d{9}(?![\w])/g;
const FILE_EXT_RE = /\.(?:csv|json|txt|xlsx?|pdf|png|jpe?g|webp)$/i;

/** Đường dẫn (dạng `/`) có phải file dữ liệu thử cần quét không. */
export function isFixtureFile(rel) {
  const p = rel.split(sep).join("/");
  if (SELF_FILES.has(p) || !SCAN_EXT.test(p)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p)) return true;
  if (/(?:^|\/)(?:__tests__|__fixtures__|fixtures?|seeds?|integration-tests|e2e|drill|load)\//.test(p))
    return true;
  return /^(?:seed|fixtures?|dataset)(?:[-_.].*)?\.[a-z]+$/i.test(basename(p));
}

/** Miền email có thuộc nhóm dành riêng/ẩn danh không. */
export function isAllowedDomain(domain) {
  const d = domain.toLowerCase();
  if (ANONYMOUS_DOMAINS.includes(d)) return true;
  if (RESERVED_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`))) return true;
  return RESERVED_TLDS.includes(d.slice(d.lastIndexOf(".") + 1));
}

/** Chuẩn hoá về dạng 10 số `0XXXXXXXXX`. */
export function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("84") ? `0${digits.slice(2)}` : digits;
}

/** Số mẫu cho phép: mọi chuỗi 10 số bắt đầu 0 nằm trong dấu backtick của file chính sách. */
export function parseSamplePhones(policyText) {
  const out = new Set();
  for (const m of policyText.matchAll(/`(0\d{9})`/g)) out.add(m[1]);
  return out;
}

/** Email nằm trong URL (`scheme://user[:pass]@host`) là thông tin đăng nhập, không phải email. */
function isUrlUserinfo(line, index) {
  const before = line.slice(0, index);
  return /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*$/i.test(before);
}

/** Vi phạm trong một đoạn văn bản: [{line, rule, value, message}]. */
export function scanText(text, samplePhones) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const no = i + 1;
    for (const m of line.matchAll(EMAIL_RE)) {
      if (isUrlUserinfo(line, m.index)) continue;
      // `ten@example.test.csv` là tên file (email + đuôi file), không phải miền .csv.
      const domain = m[0].slice(m[0].lastIndexOf("@") + 1).replace(FILE_EXT_RE, "");
      if (!isAllowedDomain(domain))
        findings.push({
          line: no,
          rule: "email",
          value: m[0],
          message: `email miền không dành riêng (${domain}); dùng example.test`,
        });
    }
    for (const m of line.matchAll(PHONE_RE)) {
      const n = normalizePhone(m[0]);
      if (n.length === 10 && !samplePhones.has(n))
        findings.push({
          line: no,
          rule: "phone",
          value: m[0],
          message: `số điện thoại không phải số mẫu trong ${POLICY_PATH}`,
        });
    }
    for (const m of line.matchAll(CCCD_RE))
      findings.push({
        line: no,
        rule: "cccd",
        value: m[0],
        message: "chuỗi 12 số giống số định danh công dân (0 + mã tỉnh 001–096)",
      });
  });
  return findings;
}

/** Liệt kê file cần quét dưới `root` (đường dẫn tương đối, dạng `/`). */
export function listFixtureFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile()) {
        const rel = relative(root, full).split(sep).join("/");
        if (isFixtureFile(rel) && statSync(full).size <= MAX_BYTES) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Quét cả cây; trả {files, findings:[{file,line,rule,value,message}]}. Ném lỗi nếu không đọc được. */
export function scanRepo(root) {
  const samplePhones = parseSamplePhones(readFileSync(join(root, POLICY_PATH), "utf8"));
  const files = listFixtureFiles(root);
  const findings = [];
  for (const file of files)
    for (const f of scanText(readFileSync(join(root, file), "utf8"), samplePhones))
      findings.push({ file, ...f });
  return { files, findings };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(process.argv[2] ?? join(here, ".."));
  let result;
  try {
    result = scanRepo(root);
  } catch (e) {
    console.error(`check-fixtures: không đọc được đầu vào: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (result.findings.length > 0) {
    for (const f of result.findings)
      console.error(`LỖI: ${f.file}:${f.line} [${f.rule}] "${f.value}" — ${f.message}`);
    console.error(`check-fixtures: ${result.findings.length} vi phạm trong ${result.files.length} file`);
    process.exit(1);
  }
  console.log(`check-fixtures: đạt — ${result.files.length} file fixture/seed/test đã quét, 0 PII thật`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
