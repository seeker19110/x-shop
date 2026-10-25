// Chạy `vitest run`, bỏ token `--` đứng đầu mà pnpm chuyển tiếp nguyên văn
// (`pnpm test -- home layout` → vitest sẽ coi `home layout` là tham số sau `--`, không lọc).
import { spawnSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

const r = spawnSync("pnpm", ["exec", "vitest", "run", ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
