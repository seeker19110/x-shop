#!/usr/bin/env node
// Lint cấu trúc ADR (ARC-ADR-003, ARC-STYLE-001): mỗi ADR số >= 0002 phải đủ Status · Date · Context · Considered Options
// (>= 2 mục) · Decision Outcome · Consequences · điều kiện đọc lại. ADR-0001 (accepted trước khi có luật) bất biến theo
// ARC-ADR-004 nên bị bỏ qua; ADR mới thay nó (Q-17) phải đạt. Tên file `NNNN-<slug-kebab>.md`, số không trùng.
// CLI: node scripts/check-adr.mjs [thư mục = docs/adr]. Thoát 0 = đạt; 1 = vi phạm (in lý do).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const FIRST_LINTED = 2;
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
    if (n < FIRST_LINTED) continue;
    linted.push(f);
    for (const e of lintAdr(readFileSync(join(dir, f), "utf8"))) problems.push(`${f}: ${e}`);
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
  console.log(`check-adr: ${linted.length} ADR đạt (${linted.join(", ")})`);
}
