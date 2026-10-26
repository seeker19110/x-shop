// Chạy `vitest run`, bỏ token `--` đứng đầu mà pnpm chuyển tiếp nguyên văn
// (`pnpm test -- home layout` → vitest sẽ coi `home layout` là tham số sau `--`, không lọc).
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

// FE-TEST-003: múi giờ/locale cố định để test tất định trên mọi máy.
const env = { ...process.env, TZ: "UTC", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const r = spawnSync("pnpm", ["exec", "vitest", "run", ...args], { stdio: "inherit", env });
process.exit(r.status ?? 1);
