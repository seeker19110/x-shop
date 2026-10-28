#!/usr/bin/env node
// ADR đã chốt bất biến (ARC-ADR-004, BASE-DOC-003): so ADR đã chốt (mặc định; chỉ Proposed/Đề xuất/Draft/Nháp là chưa chốt — gồm
// accepted/superseded/deprecated/rejected, kể cả giá trị lạ) ở ref gốc với HEAD. Chỉ được đổi dòng/mục Status và dòng liên kết ("Superseded by", "Links").
//  - đổi chỗ khác → vi phạm; xoá/đổi tên ADR đã chốt → vi phạm; ADR mới/đang proposed → bỏ qua.
//  - Status ở HEAD vẫn phải là trạng thái đã chốt (không "gỡ" accepted về proposed để lách).
// Ref gốc: `--base <ref>` > biến ADR_BASE_REF > `origin/master`. CI: PR → origin/<nhánh đích>; push → commit trước push.
// So HEAD (commit), không so working tree. Cần lịch sử nhánh đích (CI: fetch-depth: 0). Thoát 0 = đạt; 1 = vi phạm/lỗi.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { UNFINAL_VALUE_RE, parseStatus, statusValue } from "./check-adr.mjs";

export const DEFAULT_BASE = "origin/master";
const MARK = "\u0000STATUS\u0000";

const split = (t) => (t ?? "").replace(/\r\n/g, "\n").split("\n");

/** Đã chốt? MẶC ĐỊNH là có; chỉ chưa chốt khi giá trị Status bắt đầu bằng Proposed/Đề xuất/Draft/Nháp (khối đầu tiên). */
export function isFinal(text) {
  return !UNFINAL_VALUE_RE.test(statusValue(text));
}

/**
 * Nội dung ADR phải giữ nguyên: mọi dòng, trừ dòng giá trị Status + dòng liên kết của khối Status đầu tiên, được thay
 * bằng một dấu tại ĐÚNG vị trí khối đó (chèn khối Status/liên kết ở chỗ khác, đổi danh sách heading → khác).
 */
export function immutablePart(text) {
  const lines = split(text);
  const st = parseStatus(lines);
  if (!st) return lines.join("\n");
  const out = [];
  lines.forEach((l, i) => {
    if (i === st.start) out.push(MARK);
    const inBlock = i >= st.start && i < st.end;
    if (!st.mutable.has(i) && !(inBlock && l.trim() === "")) out.push(l); // dòng trống trong khối Status không đáng kể
  });
  if (!out.includes(MARK)) out.unshift(MARK);
  return out.join("\n");
}

/** So một ADR: trả mảng lỗi. `head` = null nếu file không còn ở HEAD. */
export function compareAdr(name, base, head) {
  if (head === null) return [`${name}: ADR đã chốt bị xoá/đổi tên (chỉ được chuyển Status sang Superseded)`];
  const errors = [];
  if (!isFinal(head))
    errors.push(`${name}: Status không còn ở trạng thái đã chốt (accepted/superseded/deprecated)`);
  if (immutablePart(base) !== immutablePart(head)) {
    errors.push(`${name}: sửa nội dung ngoài dòng Status/liên kết — viết ADR mới "supersedes" thay vì sửa`);
  }
  return errors;
}

function git(cwd, args, allowFail = false) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 << 20,
    });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

/** { problems, checked } cho repo ở `cwd`. */
export function checkImmutable({ cwd = process.cwd(), base = DEFAULT_BASE, dir = "docs/adr" } = {}) {
  if (git(cwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], true) === null) {
    return {
      problems: [
        `ref gốc "${base}" không có trong repo (clone nông/chưa fetch?) — chạy \`git fetch origin <nhánh>\` (CI: fetch-depth: 0) hoặc truyền --base <ref>`,
      ],
      checked: [],
    };
  }
  const problems = [];
  const checked = [];
  const files = git(cwd, ["ls-tree", "-r", "--name-only", base, "--", `${dir}/`])
    .split("\n")
    .filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const baseText = git(cwd, ["show", `${base}:${f}`]);
    if (!isFinal(baseText)) continue;
    checked.push(f);
    const headText = git(cwd, ["show", `HEAD:${f}`], true);
    problems.push(...compareAdr(f, baseText, headText));
  }
  return { problems, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  let base = process.env.ADR_BASE_REF || DEFAULT_BASE;
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--base") base = argv[++i];
  const { problems, checked } = checkImmutable({ base });
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-adr-immutable: ${p}`);
    process.exit(1);
  }
  console.log(`check-adr-immutable: ${checked.length} ADR đã chốt giữ nguyên so với ${base}`);
}
