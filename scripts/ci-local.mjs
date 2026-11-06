#!/usr/bin/env node
// Chạy ở máy đúng các bước kiểm một dòng của job `gate` trong .github/workflows/ci.yml mà `dev-task.sh gate` không chạy
// (check-fixtures, depcruise, check-schema…). Hàng rào cho lỗi lặp "bước chỉ có trên CI đỏ sau khi đẩy" (AGENTS.md §4).
// Đọc thẳng từ ci.yml nên không lệch danh sách. CLI: node scripts/ci-local.mjs [--list]  (thoát 0 = mọi bước xanh).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Lệnh `run:` một dòng của các bước kiểm (pnpm check/depcruise/load:test, node scripts, node --test) trong job `gate`. */
export function gateCheckCommands(yml) {
  const lines = String(yml).split("\n");
  const start = lines.findIndex((l) => /^ {2}gate:\s*$/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) break; // job kế tiếp
    const m = /^\s+(?:-\s+)?run:\s+(.+)$/.exec(lines[i]);
    if (m === null) continue;
    const cmd = m[1].trim();
    if (cmd === "|" || cmd === ">") continue;
    if (/^(pnpm (check|depcruise|load:test)|node (scripts\/|--test ))/.test(cmd)) out.push(cmd);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const cmds = gateCheckCommands(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  if (cmds.length === 0) {
    console.error("ci-local: không tìm thấy bước kiểm nào trong job gate của ci.yml");
    return 2;
  }
  if (argv.includes("--list")) {
    for (const c of cmds) console.log(c);
    return 0;
  }
  for (const cmd of cmds) {
    console.log(`[ci-local] ${cmd}`);
    const r = spawnSync("bash", ["-c", cmd], { cwd: root, stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`[ci-local] ĐỎ: ${cmd} (mã ${r.status ?? "?"})`);
      return 1;
    }
  }
  console.log(`[ci-local] xanh — ${cmds.length} bước`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main());
