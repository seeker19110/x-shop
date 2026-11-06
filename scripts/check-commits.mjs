#!/usr/bin/env node
// Kiểm Conventional Commits 1.0.0 cho MỌI commit của PR (BASE-REPO-005): `type(scope)!: mô tả`, subject <= 72 ký tự,
// thân cách subject một dòng trống, footer `BREAKING CHANGE: <mô tả>` viết hoa đúng và không rỗng.
// Miễn: commit merge (`Merge …`), `Revert "…"` do GitHub sinh, commit của bot (`[bot]`). `fixup!`/`squash!` không được miễn (phải autosquash trước khi mở PR).
// CLI: node scripts/check-commits.mjs <base> <head>  (khoảng `base..head`; thoát 0 = đạt, 1 = vi phạm, 2 = lỗi dùng/git).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
export const MAX_SUBJECT = 72;
const SUBJECT_RE = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9._/-]+\\))?(!)?: (\\S.*)$`);
// Footer theo spec §9: token `BREAKING CHANGE` hoặc `BREAKING-CHANGE`, rồi `: ` (hoặc ` #`).
const BREAKING_OK_RE = /^BREAKING[ -]CHANGE: \S/;
const BREAKING_ANY_RE = /^breaking[ -]change\s*:/i; // dòng trông như footer breaking (kể cả viết sai hoa/thường, rỗng)

/** Commit được miễn kiểm? (merge, revert của GitHub, bot) */
export function isExempt({ subject = "", author = "" } = {}) {
  return /^Merge /.test(subject) || /^Revert ".*"$/.test(subject) || /\[bot\]/i.test(author);
}

/** Lỗi của một thông điệp commit (mảng rỗng = đạt). */
export function lintMessage(message) {
  const errors = [];
  const lines = String(message ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/, "")
    .split("\n");
  const subject = lines[0] ?? "";
  if (!subject.trim()) return ["thông điệp rỗng"];
  if (!SUBJECT_RE.test(subject)) {
    errors.push(
      `subject phải dạng "<type>(scope)!: mô tả" với type thuộc {${TYPES.join(", ")}}: ${JSON.stringify(subject)}`,
    );
  }
  const len = [...subject].length;
  if (len > MAX_SUBJECT) errors.push(`subject dài ${len} ký tự (> ${MAX_SUBJECT})`);
  if (lines.length > 1 && lines[1] !== "") errors.push("thân phải cách subject đúng một dòng trống");
  for (const l of lines.slice(1)) {
    if (BREAKING_ANY_RE.test(l) && !BREAKING_OK_RE.test(l)) {
      errors.push(`footer BREAKING CHANGE phải viết hoa, có mô tả không rỗng: ${JSON.stringify(l)}`);
    }
  }
  return errors;
}

/** Tách đầu ra `git log --format=%H%x1f%ae%x1f%B%x1e`. */
export function parseLog(raw) {
  return String(raw ?? "")
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim() !== "")
    .map((r) => {
      const [sha, author, ...rest] = r.split("\x1f");
      const message = rest.join("\x1f");
      return { sha, author, message, subject: message.split("\n")[0] };
    });
}

/** Kiểm danh sách commit; trả [{sha, subject, errors}] chỉ gồm commit vi phạm. */
export function checkCommits(commits) {
  const bad = [];
  for (const c of commits) {
    if (isExempt(c)) continue;
    const errors = lintMessage(c.message);
    if (errors.length) bad.push({ sha: c.sha, subject: c.subject, errors });
  }
  return bad;
}

export function main(argv = process.argv.slice(2)) {
  const [base, head] = argv;
  if (!base || !head) {
    console.error("Dùng: node scripts/check-commits.mjs <base> <head>");
    return 2;
  }
  let raw;
  try {
    raw = execFileSync("git", ["log", "--format=%H%x1f%ae%x1f%B%x1e", `${base}..${head}`], {
      encoding: "utf8",
    });
  } catch (e) {
    console.error(`::error::git log ${base}..${head} lỗi: ${e.message}`);
    return 2;
  }
  const commits = parseLog(raw);
  const bad = checkCommits(commits);
  for (const b of bad) for (const e of b.errors) console.log(`::error::${b.sha.slice(0, 8)} ${e}`);
  console.log(`check-commits: ${commits.length} commit, ${bad.length} vi phạm`);
  return bad.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
