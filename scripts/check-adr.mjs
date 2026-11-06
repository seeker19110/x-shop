#!/usr/bin/env node
// Lint cấu trúc ADR (ARC-ADR-003, ARC-STYLE-001): MỌI ADR phải đủ Status · Date · Context · Considered Options
// (>= 2 mục) · Decision Outcome · Consequences · điều kiện đọc lại. Ngoại lệ duy nhất theo trạng thái: ADR đã
// "Superseded by ADR-NNNN" — bất biến theo ARC-ADR-004 nên không thể sửa cho đủ heading (ADR-0001, Q-17); thay vào đó
// BẮT BUỘC trỏ tới ADR thay thế có thật trong thư mục (ADR thay thế tự bị lint đầy đủ). Không có ngoại lệ theo số.
// Tên file `NNNN-<slug-kebab>.md`, số không trùng.
// CLI: node scripts/check-adr.mjs [thư mục = docs/adr]. Thoát 0 = đạt; 1 = vi phạm (in lý do).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FILE_RE = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

/** Mỗi nhóm: nhãn báo lỗi + các tiêu đề chấp nhận (không phân biệt hoa thường, bỏ dấu `:` cuối). */
export const REQUIRED = [
  ["Status", ["trạng thái", "status"]],
  ["Date", ["ngày", "date"]],
  ["Context and Problem Statement", ["bối cảnh", "context and problem statement"]],
  ["Considered Options", ["phương án đã cân nhắc", "considered options"]],
  ["Decision Outcome", ["quyết định", "decision outcome"]],
  ["Consequences", ["hệ quả", "consequences"]],
  ["Điều kiện đọc lại", ["điều kiện đọc lại"]],
];

/** Dòng liên kết/thay thế (được phép thêm/sửa trong khối Status của ADR đã chốt). */
export const LINK_RE =
  /^\s*(?:[-*]\s*)?(?:links?|liên kết|superseded by|bị thay thế bởi|bị thay bởi|supersedes|thay thế|thay)\s*:?\s*ADR-\d{4}/iu;
const W = "(?![\\p{L}\\p{N}_])"; // ranh giới từ hiểu Unicode (\b của JS không xử lý chữ có dấu)
/** Từ đầu hợp lệ của giá trị Status (ép bởi check-adr); phần sau tuỳ ý. */
export const STATUS_VALUE_RE = new RegExp(
  `^(?:proposed|accepted|rejected|deprecated|superseded by ADR-\\d{4}|đề xuất|chấp nhận|từ chối|lỗi thời|bị thay bởi ADR-\\d{4})${W}`,
  "iu",
);
/** Giá trị Status chưa chốt (ADR còn được sửa tự do). */
export const UNFINAL_VALUE_RE = new RegExp(`^(?:proposed|draft|đề xuất|nháp)${W}`, "iu");
const STATUS_LINE_RE = /^\s*(?:[-*]\s*)?(?:trạng thái|status)\s*:/i;

/**
 * Khối Status ĐẦU TIÊN của ADR (các khối sau là nội dung thường): front matter, mục `## Trạng thái|Status`, hoặc dòng
 * `- Trạng thái:`/`Status:` (kèm các dòng liên kết liền sau). Trả { start, end (loại trừ), mutable: Set<chỉ số dòng> }
 * — mutable = dòng giá trị Status + dòng liên kết; phần còn lại của khối vẫn là nội dung phải giữ nguyên. Không có → null.
 */
export function parseStatus(lines) {
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) {
      const mutable = new Set();
      for (let i = 1; i < close; i++)
        if (/^status\s*:/i.test(lines[i]) || LINK_RE.test(lines[i])) mutable.add(i);
      const value = lines.findIndex((l, i) => i > 0 && i < close && /^status\s*:/i.test(l));
      return { start: 0, end: close + 1, mutable, value };
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{2}\s+(.+?)\s*$/.exec(lines[i]);
    if (h && ["trạng thái", "status"].includes(norm(h[1]))) {
      let end = lines.findIndex((l, j) => j > i && /^#{1,6}\s/.test(l));
      if (end < 0) end = lines.length;
      const mutable = new Set();
      const first = lines.findIndex((l, j) => j > i && j < end && l.trim() !== "");
      if (first >= 0) mutable.add(first);
      for (let j = i + 1; j < end; j++) if (LINK_RE.test(lines[j])) mutable.add(j);
      return { start: i, end, mutable, value: first };
    }
    if (STATUS_LINE_RE.test(lines[i])) {
      let end = i + 1;
      const mutable = new Set([i]);
      while (end < lines.length && LINK_RE.test(lines[end])) mutable.add(end++);
      return { start: i, end, mutable, value: i };
    }
  }
  return null;
}

/** Giá trị Status (bỏ nhãn `Status:`/`- Trạng thái:`), "" nếu không có. */
export function statusValue(text) {
  const lines = toLines(text);
  const st = parseStatus(lines);
  if (!st || st.value < 0) return "";
  return lines[st.value].replace(/^\s*(?:[-*]\s*)?(?:(?:trạng thái|status)\s*:)?\s*/iu, "").trim();
}

const toLines = (t) => (t ?? "").replace(/\r\n/g, "\n").split("\n");

/** Văn bản các dòng có thể đổi của khối Status đầu tiên ("" nếu không có). */
export function statusText(text) {
  const lines = toLines(text);
  const st = parseStatus(lines);
  return st ? lines.filter((_, i) => st.mutable.has(i)).join("\n") : "";
}

/** Số ADR thay thế nếu Status ghi "Superseded by ADR-NNNN", ngược lại null. */
export function supersededBy(text) {
  const m = /superseded\s+by\s+ADR-(\d{4})/i.exec(statusText(text));
  return m ? m[1] : null;
}

/** ADR này tuyên bố thay ADR số `n` (dòng "Supersedes ADR-NNNN" / "Thay ADR-NNNN" trong khối Status)? */
export function declaresSupersedes(text, n) {
  const lines = toLines(text);
  const st = parseStatus(lines);
  if (!st) return false;
  const re = new RegExp(`(?:supersedes|thay(?: thế)?)\\s+ADR-${String(n).padStart(4, "0")}\\b`, "i");
  return re.test(lines.slice(st.start, st.end).join("\n"));
}

const norm = (s) => s.trim().replace(/:$/, "").trim().toLowerCase();

/** Trả về danh sách lỗi (mảng rỗng = đạt) cho nội dung một ADR. */
export function lintAdr(text) {
  const errors = [];
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const headings = [];
  lines.forEach((l, i) => {
    const m = /^#{2}\s+(.+?)\s*$/.exec(l);
    if (m) headings.push({ name: norm(m[1]), line: i });
  });
  if (parseStatus(lines) && !STATUS_VALUE_RE.test(statusValue(text))) {
    errors.push(
      "Status phải bắt đầu bằng Proposed|Accepted|Rejected|Deprecated|Superseded by ADR-NNNN (hoặc Đề xuất|Chấp nhận|Từ chối|Lỗi thời|Bị thay bởi ADR-NNNN)",
    );
  }
  for (const [label, accepted] of REQUIRED) {
    const h = headings.find((x) => accepted.includes(x.name));
    if (!h) {
      errors.push(`thiếu heading "${label}"`);
      continue;
    }
    const next = headings.find((x) => x.line > h.line);
    const section = lines.slice(h.line + 1, next ? next.line : lines.length);
    if (section.join("\n").trim() === "") errors.push(`heading "${label}" rỗng`);
    if (label === "Considered Options") {
      const n = section.filter((l) => /^(\d+\.|[-*])\s+\S/.test(l)).length;
      if (n < 2) errors.push(`"Considered Options" cần >= 2 mục (có ${n})`);
    }
  }
  return errors;
}

/** Kiểm cả thư mục; trả về { problems: string[], linted: string[] }. */
export function checkAdrDir(dir) {
  const problems = [];
  const linted = [];
  const seen = new Map();
  const texts = new Map();
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const m = FILE_RE.exec(f);
    if (!m) {
      problems.push(`${f}: tên file phải là NNNN-<slug-kebab>.md`);
      continue;
    }
    const n = Number(m[1]);
    if (seen.has(n)) problems.push(`${f}: số ${m[1]} trùng với ${seen.get(n)}`);
    seen.set(n, f);
    texts.set(f, readFileSync(join(dir, f), "utf8"));
  }
  const verdict = new Map(); // f -> true nếu đạt (đệ quy theo chuỗi thay thế; số đích > số mình nên dừng)
  const check = (f) => {
    if (verdict.has(f)) return verdict.get(f);
    verdict.set(f, false); // chặn vòng
    const text = texts.get(f);
    const by = supersededBy(text);
    let ok;
    if (by === null) {
      const errs = lintAdr(text);
      for (const e of errs) problems.push(`${f}: ${e}`);
      linted.push(f);
      ok = errs.length === 0;
    } else {
      // Miễn lint heading CHỈ khi ADR đích có thật, số lớn hơn, tuyên bố supersedes ngược lại và tự đạt (có thể chuỗi).
      const mine = Number(FILE_RE.exec(f)[1]);
      const target = [...texts.keys()].find((k) => FILE_RE.exec(k)[1] === by);
      if (!target) problems.push(`${f}: "Superseded by ADR-${by}" nhưng không có ADR số ${by}`);
      else if (Number(by) <= mine) problems.push(`${f}: ADR thay thế (${by}) phải có số lớn hơn`);
      else if (!declaresSupersedes(texts.get(target), mine)) {
        problems.push(
          `${f}: ${target} không có dòng "Supersedes ADR-${String(mine).padStart(4, "0")}" trong khối Status`,
        );
      } else if (!check(target)) problems.push(`${f}: ADR thay thế ${target} không đạt`);
      ok = problems.every((p) => !p.startsWith(`${f}:`));
    }
    verdict.set(f, ok);
    return ok;
  };
  for (const f of texts.keys()) check(f);
  linted.sort();
  return { problems, linted };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2] ?? "docs/adr";
  const { problems, linted } = checkAdrDir(dir);
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-adr: ${p}`);
    process.exit(1);
  }
  console.log(`check-adr: ${linted.length} ADR đạt (${linted.join(", ")}); ADR superseded chỉ kiểm liên kết`);
}
