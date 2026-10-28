#!/usr/bin/env node
// Lint metadata + tiêu chí của docs/specs/SPEC-*.md (`node scripts/check-specs.mjs`) — T-212, WF-SDD-001/002, Q-14.
//
// Quy tắc:
//  1. Mỗi SPEC-*.md có trạng thái: dòng bảng `| Trạng thái | … |` hoặc frontmatter `status:`.
//  2. Trạng thái bắt đầu bằng "Approved" (không phân biệt hoa/thường) thì bắt buộc `approved_by` (không rỗng) và
//     `approved_at` (ngày ISO `YYYY-MM-DD`, ngày có thật, không ở tương lai quá 1 ngày).
//     Trạng thái khác (Draft…) không cần hai trường này nhưng không được dùng làm căn cứ code (xem pr-policy).
//  3. Mục "Tiêu chí chấp nhận" có ≥ 1 ID `### S-NNN` (Q-14: S-NNN là ID tiêu chí, `AT-NN` của đặc tả gốc là bí danh ghi
//     trong ngoặc ở tiêu đề), không trùng ID, và ≥ 1 ca lỗi (mã 4xx/5xx hoặc từ "lỗi/từ chối/không hợp lệ/sai/hết hàng").
//  4. Chế độ `--pr` (pr-policy): PR có commit/tiêu đề `feat` phải link ≥ 1 `docs/specs/SPEC-*.md` (hoặc `SPEC-<tên>`) trong
//     thân PR, file đó tồn tại và Approved, và thân PR có mục "## Map tiêu chí → test" có nội dung. Dữ liệu PR đọc từ biến
//     môi trường PR_BODY, PR_TITLE và tệp COMMIT_SUBJECTS_FILE (mỗi dòng một subject) — không nội suy vào shell.
//
// Thoát 0 = đạt; 1 = vi phạm; 2 = không đọc được thư mục spec.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
export const SPECS_DIR = "docs/specs";

/** Bỏ định dạng markdown nhẹ khỏi giá trị ô bảng. */
const clean = (s) => s.replace(/[`*]/g, "").trim();

/** Lấy metadata từ frontmatter `---` hoặc bảng `| Trường | Giá trị |`. Khoá hạ chữ thường. */
export function parseMeta(text) {
  const meta = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (m) meta[m[1].toLowerCase()] = clean(m[2]);
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|?\s*$/.exec(line);
    if (!m) continue;
    const key = clean(m[1]).toLowerCase();
    if (key === "trạng thái" || key === "status") meta.status ??= clean(m[2]);
    else if (key === "approved_by" || key === "approved_at") meta[key] ??= clean(m[2]);
  }
  return meta;
}

/** Ngày ISO có thật (loại 2026-02-31). */
export function isIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export const isApproved = (status) => /^approved\b/i.test(status ?? "");

/** Tách mục "Tiêu chí chấp nhận" (từ heading chứa cụm đó tới heading cùng cấp kế tiếp). */
export function criteriaSection(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s+.*Tiêu chí chấp nhận/i.test(l));
  if (start < 0) return null;
  const level = /^(#+)/.exec(lines[start])[1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** Danh sách tiêu chí `### S-NNN …` kèm bí danh AT trong phần còn lại của tiêu đề. */
export function parseCriteria(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{2,4}\s+(S-\d{3})\b(.*)$/.exec(line);
    if (!m) continue;
    const aliases = [...m[2].matchAll(/\bAT-?(\d{1,2})\b/g)].map((a) => `AT${a[1].padStart(2, "0")}`);
    out.push({ id: m[1], aliases: [...new Set(aliases)], title: m[2].trim() });
  }
  return out;
}

const ERROR_CASE = /\b[45]\d{2}\b|lỗi|từ chối|không hợp lệ|\bsai\b|hết hàng|quá hạn|vượt/i;

export function checkSpec(name, text, today = new Date()) {
  const errors = [];
  const meta = parseMeta(text);
  if (!meta.status) {
    errors.push(`${name}: thiếu trạng thái (dòng bảng "| Trạng thái |" hoặc frontmatter "status:")`);
  } else if (isApproved(meta.status)) {
    if (!meta.approved_by) errors.push(`${name}: trạng thái Approved nhưng thiếu approved_by`);
    if (!meta.approved_at) errors.push(`${name}: trạng thái Approved nhưng thiếu approved_at`);
    else if (!isIsoDate(meta.approved_at))
      errors.push(`${name}: approved_at "${meta.approved_at}" không phải ngày ISO YYYY-MM-DD`);
    else if (Date.parse(meta.approved_at) > today.getTime() + 86_400_000) {
      errors.push(`${name}: approved_at ${meta.approved_at} ở tương lai`);
    }
  }
  const section = criteriaSection(text);
  if (section === null) {
    errors.push(`${name}: thiếu mục "Tiêu chí chấp nhận"`);
  } else {
    const ids = parseCriteria(section).map((c) => c.id);
    if (ids.length === 0) errors.push(`${name}: mục "Tiêu chí chấp nhận" không có ID "### S-NNN"`);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    for (const id of new Set(dup)) errors.push(`${name}: trùng ID tiêu chí ${id}`);
    if (ids.length > 0 && !ERROR_CASE.test(section))
      errors.push(`${name}: tiêu chí không có ca lỗi nào (mã 4xx/5xx hoặc "lỗi/từ chối…")`);
  }
  return errors;
}

export function listSpecs(dir = join(root, SPECS_DIR)) {
  return readdirSync(dir)
    .filter((f) => /^SPEC-.+\.md$/.test(f))
    .sort();
}

export function run(dir = join(root, SPECS_DIR), today = new Date()) {
  if (!existsSync(dir)) return { code: 2, errors: [`không thấy thư mục ${dir}`], specs: 0 };
  const files = listSpecs(dir);
  const errors = [];
  if (files.length === 0) errors.push(`${dir}: không có SPEC-*.md nào`);
  for (const f of files) errors.push(...checkSpec(f, readFileSync(join(dir, f), "utf8"), today));
  return { code: errors.length ? 1 : 0, errors, specs: files.length };
}

const FEAT = /^feat(\([^)]*\))?!?:/;

/** Lỗi của một PR theo luật 4. `commits`: mảng subject. Không phải `feat` → không lỗi. */
export function checkPrSpec({ title = "", commits = [], body = "" }, dir = join(root, SPECS_DIR)) {
  if (![title, ...commits].some((s) => FEAT.test(s.trim()))) return [];
  const errors = [];
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const names = new Set([...text.matchAll(/\bSPEC-[A-Za-z0-9_-]+/g)].map((m) => m[0].replace(/[-_]+$/, "")));
  if (names.size === 0) {
    errors.push("PR feat phải link một SPEC Approved trong mô tả (vd docs/specs/SPEC-checkout.md)");
  } else {
    const approved = [...names].filter((n) => {
      const f = join(dir, `${n}.md`);
      return existsSync(f) && isApproved(parseMeta(readFileSync(f, "utf8")).status);
    });
    if (approved.length === 0)
      errors.push(
        `PR feat: không có spec Approved nào trong ${[...names].join(", ")} (file không tồn tại hoặc chưa Approved)`,
      );
  }
  const m = /^##\s+Map tiêu chí\s*(?:→|->)\s*test\b[^\n]*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text);
  if (!m || !/[A-Za-z0-9]/.test(m[1].replace(/\|[\s:|-]+\|/g, "")))
    errors.push('PR feat: thiếu mục "## Map tiêu chí → test" có nội dung (ID tiêu chí → tên test)');
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--pr")) {
    let commits = [];
    try {
      if (process.env.COMMIT_SUBJECTS_FILE)
        commits = readFileSync(process.env.COMMIT_SUBJECTS_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    } catch (e) {
      console.error(`check-specs: không đọc được COMMIT_SUBJECTS_FILE: ${e.message}`);
      process.exit(2);
    }
    const errors = checkPrSpec({
      title: process.env.PR_TITLE ?? "",
      commits,
      body: process.env.PR_BODY ?? "",
    });
    for (const e of errors) console.error(`::error::pr-policy: ${e}`);
    if (errors.length === 0) console.log("check-specs --pr: OK");
    process.exit(errors.length ? 1 : 0);
  }
  const { code, errors, specs } = run();
  for (const e of errors) console.error(`check-specs: ${e}`);
  if (code === 0) console.log(`check-specs: OK — ${specs} spec đủ metadata và tiêu chí.`);
  process.exit(code);
}
