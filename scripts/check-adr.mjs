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

/** Số ADR thay thế nếu Status ghi "Superseded by ADR-NNNN" (bỏ dấu `_`/`-` linh hoạt), ngược lại null. */
export function supersededBy(text) {
  const m = /superseded\s+by\s+ADR-(\d{4})/i.exec(statusBlock(text));
  return m ? m[1] : null;
}

/** Chỉ số dòng thuộc Status: front matter `status:`, dòng `- Trạng thái:`/`Status:`, hoặc cả mục `## Trạng thái`. */
export function statusLineIndexes(lines) {
  const idx = new Set();
  let inFront = lines[0]?.trim() === "---";
  let inSection = false;
  lines.forEach((l, i) => {
    if (inFront) {
      if (i > 0 && l.trim() === "---") inFront = false;
      else if (/^status\s*:/i.test(l)) idx.add(i);
      return;
    }
    const h = /^#{2}\s+(.+?)\s*$/.exec(l);
    if (h) {
      inSection = ["trạng thái", "status"].includes(norm(h[1]));
      if (inSection) idx.add(i);
      return;
    }
    if (inSection || /^\s*(?:[-*]\s*)?(?:trạng thái|status)\s*:/i.test(l)) idx.add(i);
  });
  return idx;
}

function statusBlock(text) {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const idx = statusLineIndexes(lines);
  return lines.filter((_, i) => idx.has(i)).join("\n");
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
  for (const [f, text] of texts) {
    const by = supersededBy(text);
    if (by !== null) {
      const target = [...seen.entries()].find(([k]) => String(k).padStart(4, "0") === by);
      if (!target) problems.push(`${f}: "Superseded by ADR-${by}" nhưng không có ADR số ${by}`);
      else if (target[1] === f) problems.push(`${f}: tự thay thế chính mình`);
      continue;
    }
    linted.push(f);
    for (const e of lintAdr(text)) problems.push(`${f}: ${e}`);
  }
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
