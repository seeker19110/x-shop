#!/usr/bin/env node
// ADR đã chốt bất biến (ARC-ADR-004, BASE-DOC-003): so ADR có Status accepted (hoặc đã superseded/deprecated — cũng là
// quyết định đã chốt) ở ref gốc với HEAD. Chỉ được đổi dòng/mục Status và dòng liên kết ("Superseded by", "Links").
//  - đổi chỗ khác → vi phạm; xoá/đổi tên ADR đã chốt → vi phạm; ADR mới/đang proposed → bỏ qua.
//  - Status ở HEAD vẫn phải là trạng thái đã chốt (không "gỡ" accepted về proposed để lách).
// Ref gốc: `--base <ref>` > biến ADR_BASE_REF > `origin/master`. CI: PR → origin/<nhánh đích>; push → commit trước push.
// So HEAD (commit), không so working tree. Cần lịch sử nhánh đích (CI: fetch-depth: 0). Thoát 0 = đạt; 1 = vi phạm/lỗi.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { statusLineIndexes } from "./check-adr.mjs";

export const DEFAULT_BASE = "origin/master";
const FINAL_RE = /accepted|superseded|deprecated/i;
const LINK_RE = /^\s*(?:[-*]\s*)?(?:links?|liên kết|superseded by|bị thay thế bởi|supersedes)\b/i;

const split = (t) => (t ?? "").replace(/\r\n/g, "\n").split("\n");

/** Trạng thái đã chốt? (xét riêng các dòng Status). */
export function isFinal(text) {
  const lines = split(text);
  const idx = statusLineIndexes(lines);
  return lines.some((l, i) => idx.has(i) && FINAL_RE.test(l));
}

/** Nội dung ADR sau khi bỏ phần được phép đổi (Status + dòng liên kết). */
export function immutablePart(text) {
  const lines = split(text);
  const idx = statusLineIndexes(lines);
  return lines.filter((l, i) => !idx.has(i) && !LINK_RE.test(l)).join("\n");
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
