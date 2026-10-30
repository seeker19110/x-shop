#!/usr/bin/env node
// Kiểm docs/ops/RUNBOOK.md: mỗi mục cần có ngày diễn tập gần nhất (`node scripts/check-runbook.mjs`) — T-213, WF-DOC-008.
//
// ĐỊNH NGHĨA "mục" (máy kiểm được): mọi tiêu đề cấp `## ` có số thứ tự `## N. …` với N ≥ 1 (ngoài khối ``` ). Mục `## 0.`
// (liên lạc + bảng tổng hợp trạng thái diễn tập) và các tiêu đề `###`/`####` không bị đòi. Tiêu đề `## ` không có số → bỏ qua.
// Mỗi mục phải có DÒNG ĐẦU TIÊN (ngoài khối ```) bắt đầu bằng `last_drilled:` với một trong hai dạng:
//   last_drilled: YYYY-MM-DD            ngày diễn tập thật gần nhất (UTC, lịch hợp lệ, không ở tương lai)
//   last_drilled: chưa diễn tập <lý do> "chưa diễn tập" + lý do không rỗng (sau nó phải có chữ: `(…)`, `— …`, `: …`, `. …`)
// Chọn dạng "chưa diễn tập" thay vì bỏ trống/ngày giả: trung thực, và lý do là việc còn treo hiện ra trong output.
// Kết quả: ngày > 6 tháng lịch trước hôm nay → `::warning::` (vẫn thoát 0); "chưa diễn tập" → ghi chú `::notice::` (thoát 0);
// thiếu dòng / ngày sai định dạng / ngày không tồn tại / ngày tương lai / "chưa diễn tập" không lý do → thoát 1.
// Dùng: node scripts/check-runbook.mjs [--file <md>] [--today YYYY-MM-DD]   (--today chỉ để test).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const RUNBOOK_PATH = join(here, "..", "docs/ops/RUNBOOK.md");
export const STALE_MONTHS = 6;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Ngày YYYY-MM-DD hợp lệ theo lịch (từ chối 2026-02-30) → Date UTC; ngược lại null. */
export function parseDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

/** `date` cộng `months` tháng lịch (UTC), kẹp ngày cuối tháng (31/8 + 6 tháng = 28/2). */
export function addMonths(date, months) {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo, Math.min(date.getUTCDate(), last)));
}

/** Tách các mục `## N. …` (N ≥ 1) kèm dòng `last_drilled:` đầu tiên ngoài khối code. */
export function parseSections(markdown) {
  const sections = [];
  let fence = false;
  let current = null;
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = /^## (\d+)\.\s+(.*)$/.exec(line);
    if (h) {
      current = { number: Number(h[1]), title: h[2].trim(), line: i + 1, drilled: null };
      if (current.number >= 1) sections.push(current);
      else current = null;
      continue;
    }
    if (/^## /.test(line)) {
      current = null;
      continue;
    }
    if (current && current.drilled === null) {
      const m = /^last_drilled:[ \t]*(.*)$/.exec(line);
      if (m) current.drilled = { value: m[1].trim(), line: i + 1 };
    }
  }
  return sections;
}

/** Trả { errors, warnings, notices } (chuỗi). `today` là Date UTC (0h). */
export function checkRunbook(markdown, today) {
  const errors = [];
  const warnings = [];
  const notices = [];
  const sections = parseSections(markdown);
  if (sections.length === 0)
    errors.push("RUNBOOK không có mục `## N.` nào (N ≥ 1) — sai định dạng hoặc sai file");
  const limitFor = (d) => addMonths(d, STALE_MONTHS);
  for (const s of sections) {
    const label = `§${s.number} "${s.title}" (dòng ${s.line})`;
    if (!s.drilled) {
      errors.push(
        `${label}: thiếu dòng \`last_drilled: YYYY-MM-DD\` hoặc \`last_drilled: chưa diễn tập <lý do>\``,
      );
      continue;
    }
    const { value, line } = s.drilled;
    const pending = /^chưa diễn tập(?![\p{L}\p{N}])(.*)$/u.exec(value);
    if (pending) {
      if (!/[\p{L}\p{N}]/u.test(pending[1])) {
        errors.push(`${label}: "chưa diễn tập" thiếu lý do (dòng ${line})`);
      } else {
        notices.push(`${label}: chưa diễn tập`);
      }
      continue;
    }
    const dateText = /^(\S+)/.exec(value)?.[1] ?? "";
    const date = parseDate(dateText);
    if (!date) {
      errors.push(
        `${label}: last_drilled "${value}" không phải YYYY-MM-DD hợp lệ hoặc "chưa diễn tập <lý do>" (dòng ${line})`,
      );
      continue;
    }
    if (date.getTime() > today.getTime()) {
      errors.push(
        `${label}: last_drilled ${dateText} ở tương lai (hôm nay ${today.toISOString().slice(0, 10)}) (dòng ${line})`,
      );
    } else if (limitFor(date).getTime() < today.getTime()) {
      warnings.push(`${label}: diễn tập lần cuối ${dateText}, quá ${STALE_MONTHS} tháng — diễn tập lại`);
    }
  }
  return { errors, warnings, notices };
}

function main(argv) {
  let file = RUNBOOK_PATH;
  let today = new Date();
  today = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file" && argv[i + 1]) file = resolve(argv[++i]);
    else if (argv[i] === "--today" && argv[i + 1]) {
      const d = parseDate(argv[++i]);
      if (!d) {
        console.error("[check-runbook] --today phải là YYYY-MM-DD hợp lệ");
        return 2;
      }
      today = d;
    } else {
      console.error(`[check-runbook] tham số lạ: ${argv[i]}`);
      return 2;
    }
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    console.error(`[check-runbook] không đọc được ${file}: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const { errors, warnings, notices } = checkRunbook(text, today);
  for (const n of notices) console.log(`::notice::[check-runbook] ${n}`);
  for (const w of warnings) console.log(`::warning::[check-runbook] ${w}`);
  for (const e of errors) console.error(`[check-runbook] LỖI ${e}`);
  const total = parseSections(text).length;
  if (errors.length > 0) {
    console.error(`[check-runbook] ${errors.length} lỗi / ${total} mục`);
    return 1;
  }
  console.log(
    `[check-runbook] ${total} mục có last_drilled (${warnings.length} quá hạn, ${notices.length} chưa diễn tập)`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
