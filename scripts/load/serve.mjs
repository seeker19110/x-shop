#!/usr/bin/env node
/**
 * Bật/tắt backend tải của CÂY HIỆN TẠI cho bộ đo (T-127, LOOP-OPT): `start` = prepare() của smoke (build domain + backend;
 * LOAD_REUSE=1 dùng lại DB tải đã dựng, không thì dựng lại 10k/50k) rồi `medusa start` nền trên cổng tải, ghi
 * {pid, publishableKey, commit} vào node_modules/.cache/xshop-load/serve.json; `stop` = dừng cả nhóm tiến trình đó.
 * Dùng làm `--setup`/`--teardown` của scripts/perf/opt-gate.sh: mỗi cây (commit gốc, cây sau) chạy backend của chính nó.
 * CLI: node scripts/load/serve.mjs start|stop
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SERVE_STATE } from "./bench-pdp.mjs";
import { BASE_URL } from "./env.mjs";
import { log, prepare, root, startBackend } from "./prepare.mjs";
import { currentCommit } from "./report.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthy() {
  try {
    return (await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

async function start() {
  if (await healthy())
    throw new Error(`${BASE_URL} đã có backend chạy — \`serve.mjs stop\` (hoặc dừng tiến trình đó) trước`);
  const prep = await prepare();
  mkdirSync(path.dirname(SERVE_STATE), { recursive: true });
  const logFile = path.join(path.dirname(SERVE_STATE), "serve-backend.log");
  log(`bật backend nền (log: ${logFile})`);
  const backend = await startBackend(logFile);
  writeFileSync(
    SERVE_STATE,
    `${JSON.stringify({ pid: backend.pid, publishableKey: prep.publishableKey, commit: currentCommit(root), base: BASE_URL }, null, 2)}\n`,
  );
  log(`backend sẵn sàng (pid nhóm ${backend.pid})`);
  return 0;
}

async function stop() {
  let state;
  try {
    state = JSON.parse(readFileSync(SERVE_STATE, "utf8"));
  } catch {
    log("không có serve.json — không có gì để dừng");
    return 0;
  }
  const pid = Number(state.pid);
  if (Number.isInteger(pid) && pid > 1) {
    for (const [sig, waitMs] of [
      ["SIGTERM", 30_000],
      ["SIGKILL", 5_000],
    ]) {
      try {
        process.kill(-pid, sig);
      } catch {
        break; // nhóm đã thoát
      }
      const deadline = Date.now() + waitMs;
      while (alive(pid) && Date.now() < deadline) await sleep(200);
      if (!alive(pid)) break;
    }
  }
  rmSync(SERVE_STATE, { force: true });
  log(`đã dừng backend (pid nhóm ${pid})`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cmd = process.argv[2];
  const run = cmd === "start" ? start : cmd === "stop" ? stop : null;
  if (!run) {
    console.error("cách dùng: node scripts/load/serve.mjs start|stop");
    process.exit(2);
  }
  // exit tường minh: backend là nhóm tiến trình tách riêng (detached) nên sống tiếp sau khi script này thoát.
  run().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`serve: ${e.message}`);
      process.exit(1);
    },
  );
}
