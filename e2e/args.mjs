/**
 * Tham số chuyển cho `playwright test` từ dòng lệnh `pnpm e2e …`. pnpm giữ nguyên một dấu `--` đứng đầu
 * (`pnpm e2e -- xss-probe` → argv = ["--", "xss-probe"]); Playwright coi `--` là hết tuỳ chọn và bỏ bộ lọc → chạy cả
 * bộ. Bỏ đúng MỘT `--` đứng đầu để `pnpm e2e -- <tên spec>` lọc như `pnpm e2e <tên spec>`.
 * @param {readonly string[]} argv phần sau `node e2e/run.mjs`
 * @returns {string[]}
 */
export function playwrightArgs(argv) {
  return argv[0] === "--" ? argv.slice(1) : [...argv];
}
