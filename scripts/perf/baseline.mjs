#!/usr/bin/env node
/**
 * Baseline tài nguyên (T-216, XC-GREEN-001) → docs/perf/baseline-<YYYY-MM-DD>.json. Hai nhóm số liệu:
 *   (a) storefront: số request + trọng lượng (gzip mức 9, font/ảnh theo byte thật) tải đầu của các màn chính, đo trên
 *       `next start` của bản build production dữ liệu mẫu (XS_DATA_SOURCE=fixtures, như run-budget.sh). Không cần trình
 *       duyệt: lấy HTML rồi tải mọi tài nguyên tĩnh nó tham chiếu (script/stylesheet/preload/ảnh/font). KHÔNG tính chunk
 *       nạp động sau hydrate, RSC prefetch, ảnh lazy — đó là việc của budget.mjs (trình duyệt thật).
 *   (b) backend: CPU (ms) và RSS của cả nhóm tiến trình backend tải cho N request PDP (mặc định 1.000), đọc /proc.
 *       Backend dựng bằng scripts/load/serve.mjs (DB riêng xshop_load); cỡ dataset đọc từ LOAD_PRODUCTS và được ghi lại.
 * Phần không đo được → null kèm `reason`, không bịa số.
 * Chạy: node scripts/perf/baseline.mjs [--requests 1000] [--concurrency 8] [--port 3198] [--skip-storefront] [--skip-backend]
 *   LOAD_PRODUCTS=2000 LOAD_REUSE=1 node scripts/perf/baseline.mjs   (cỡ dataset nhỏ hơn mặc định 10.000)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { kind } from "./lib.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ROUTES = [
  { name: "trang-chu", path: "/" },
  { name: "danh-muc", path: "/danh-muc/ao" },
  { name: "pdp", path: "/san-pham/ao-so-mi-lua" },
  { name: "gio-hang", path: "/gio-hang" },
];
const CLK_TCK = 100; // USER_HZ của Linux (getconf CLK_TCK) — mặc định mọi kernel phổ biến

// ---------- hàm thuần (có test ở baseline.test.mjs) ----------

/** Ngày UTC YYYY-MM-DD. */
export function utcDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function baselineFileName(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`ngày không hợp lệ: ${date}`);
  return `baseline-${date}.json`;
}

/** URL tài nguyên tĩnh trong HTML (script src, link stylesheet/preload/icon, img src), bỏ trùng, giữ thứ tự xuất hiện. */
export function extractAssets(html) {
  const out = [];
  const add = (u) => {
    if (!u || u.startsWith("data:") || u.startsWith("#")) return;
    if (!out.includes(u)) out.push(u);
  };
  const decode = (u) => u.replace(/&amp;/g, "&");
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) add(decode(m[1]));
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = m[0];
    const rel = /\brel="([^"]+)"/.exec(tag)?.[1] ?? "";
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href && /\b(stylesheet|preload|modulepreload|icon)\b/.test(rel)) add(decode(href));
  }
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) add(decode(m[1]));
  return out;
}

/** Cộng các phản hồi [{ kind, bytes }] thành tổng theo loại + tổng chung; số request = số phản hồi. */
export function summarizePage(responses) {
  const bytes = { html: 0, js: 0, css: 0, font: 0, image: 0, rsc: 0, other: 0 };
  for (const r of responses) bytes[r.kind in bytes ? r.kind : "other"] += r.bytes;
  const totalBytes = Object.values(bytes).reduce((a, b) => a + b, 0);
  return { requests: responses.length, totalBytes, totalKiB: round(totalBytes / 1024, 1), bytes };
}

/** Ảnh/font đã nén sẵn: byte thật; văn bản: gzip mức 9 như CDN (giống budget.mjs). */
export function transferBytes(k, body) {
  return k === "image" || k === "font" ? body.length : gzipSync(body, { level: 9 }).length;
}

export function round(x, digits = 1) {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Tách /proc/<pid>/stat: utime+stime (tick) và pgid. Tên tiến trình (trường 2) có thể chứa khoảng trắng/ngoặc. */
export function parseProcStat(text) {
  const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
  // sau ")" : state(0) ppid(1) pgrp(2) session(3) tty(4) tpgid(5) flags(6) minflt(7) cminflt(8) majflt(9) cmajflt(10) utime(11) stime(12)
  const pgrp = Number(rest[2]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (![pgrp, utime, stime].every(Number.isFinite)) throw new Error("không đọc được /proc/<pid>/stat");
  return { pgrp, cpuTicks: utime + stime };
}

/** Tách VmRSS và VmHWM (kiB) từ /proc/<pid>/status; thiếu → 0 (tiến trình kernel/zombie). */
export function parseProcStatus(text) {
  const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text)?.[1] ?? 0);
  return { rssKiB: kb("VmRSS"), hwmKiB: kb("VmHWM") };
}

/** Gộp mẫu từng tiến trình [{ cpuTicks, rssKiB, hwmKiB }] của cả nhóm → tổng. */
export function sumProcs(procs) {
  return procs.reduce(
    (a, p) => ({
      cpuTicks: a.cpuTicks + p.cpuTicks,
      rssKiB: a.rssKiB + p.rssKiB,
      hwmKiB: a.hwmKiB + p.hwmKiB,
    }),
    { cpuTicks: 0, rssKiB: 0, hwmKiB: 0 },
  );
}

/**
 * Số liệu backend cho một đợt N request từ hai mẫu tổng (trước/sau). CPU = chênh tick → ms; RSS tính MiB.
 * N<1, thời gian ≤ 0 hoặc CPU giảm (tiến trình khởi động lại giữa hai mẫu) → ném lỗi, không trả số vô nghĩa.
 */
export function summarizeBackend({ before, after, requests, wallMs, clkTck = CLK_TCK }) {
  if (!Number.isInteger(requests) || requests < 1) throw new Error(`requests không hợp lệ: ${requests}`);
  if (!(wallMs > 0)) throw new Error(`wallMs không hợp lệ: ${wallMs}`);
  const ticks = after.cpuTicks - before.cpuTicks;
  if (ticks < 0) throw new Error("CPU giảm giữa hai mẫu — tiến trình backend đã đổi/khởi động lại");
  const cpuMs = (ticks * 1000) / clkTck;
  return {
    requests,
    wallMs: Math.round(wallMs),
    requestsPerSecond: round((requests * 1000) / wallMs, 1),
    cpuMs: Math.round(cpuMs),
    cpuMsPerRequest: round(cpuMs / requests, 2),
    cpuUtilizationPercentOfOneCore: round((cpuMs / wallMs) * 100, 1),
    rssBeforeMiB: round(before.rssKiB / 1024, 1),
    rssAfterMiB: round(after.rssKiB / 1024, 1),
    rssDeltaMiB: round((after.rssKiB - before.rssKiB) / 1024, 1),
    peakRssSumMiB: round(after.hwmKiB / 1024, 1),
    cpuClockTicksPerSecond: clkTck,
  };
}

/** Khối "không đo được". */
export const unmeasured = (reason) => ({ measured: false, value: null, reason });

/** Lắp tài liệu cuối. `storefront`/`backend` là kết quả đo hoặc unmeasured(). */
export function buildBaseline({ commit, now, env, storefront, backend }) {
  return {
    schema: 1,
    task: "T-216",
    commit,
    dateUtc: utcDate(now),
    generatedAtUtc: now.toISOString(),
    environment: env,
    storefront,
    backend,
  };
}

/** Môi trường đo từ os + process. */
export function environmentInfo(o = os, proc = process) {
  const cpus = o.cpus();
  return {
    node: proc.version,
    platform: `${proc.platform}-${proc.arch}`,
    cpuModel: cpus[0]?.model?.trim() ?? null,
    cpuCores: cpus.length,
    memTotalGiB: round(o.totalmem() / 2 ** 30, 1),
  };
}

export function parseArgs(argv) {
  const o = { requests: 1000, concurrency: 8, port: 3198, skipStorefront: false, skipBackend: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-storefront") o.skipStorefront = true;
    else if (a === "--skip-backend") o.skipBackend = true;
    else if (a === "--requests" || a === "--concurrency" || a === "--port") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 65_535) throw new Error(`${a} cần số nguyên dương hợp lệ`);
      o[a.slice(2)] = v;
    } else throw new Error(`tham số lạ: ${a}`);
  }
  return o;
}

// ---------- phần chạy thật (cần server) ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(url, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).status < 500) return;
    } catch {
      /* chưa lên */
    }
    await sleep(500);
  }
  throw new Error(`${url} không lên sau ${ms / 1000} s`);
}

async function fetchBytes(url) {
  const res = await fetch(url, {
    headers: { "accept-encoding": "identity" },
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: res.status,
    type: res.headers.get("content-type") ?? "",
    body: Buffer.from(await res.arrayBuffer()),
  };
}

/** Đo một route: HTML + mọi tài nguyên tĩnh cùng origin mà HTML tham chiếu. */
async function measureRoute(base, route) {
  const page = await fetchBytes(new URL(route.path, base));
  if (page.status !== 200) throw new Error(`${route.path} trả HTTP ${page.status}`);
  const responses = [{ kind: "html", bytes: transferBytes("html", page.body) }];
  const failed = [];
  for (const href of extractAssets(page.body.toString("utf8"))) {
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) continue; // chỉ đo tài nguyên của chính app
    const r = await fetchBytes(u);
    if (r.status !== 200) {
      failed.push(`${u.pathname} → ${r.status}`);
      continue;
    }
    const k = kind(r.type, u.pathname);
    responses.push({ kind: k, bytes: transferBytes(k, r.body) });
  }
  if (failed.length) throw new Error(`${route.path}: tài nguyên lỗi ${failed.join(", ")}`);
  return { route: route.path, name: route.name, ...summarizePage(responses) };
}

async function measureStorefront(port) {
  const env = {
    ...process.env,
    PORT: String(port),
    NEXT_PUBLIC_SITE_URL: `http://localhost:${port}`,
    NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: "pk_perf_placeholder",
    MEDUSA_BACKEND_URL: "http://127.0.0.1:9",
    XS_DATA_SOURCE: "fixtures",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const build = spawnSync("pnpm", ["--filter", "@x-shop/storefront", "build"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (build.status !== 0)
    throw new Error(`build storefront lỗi (mã ${build.status}): ${build.stderr.slice(-300)}`);
  const server = spawn("pnpm", ["start"], {
    cwd: path.join(root, "apps/storefront"),
    env,
    stdio: "ignore",
    detached: true,
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitUp(`${base}/`);
    const pages = [];
    for (const route of ROUTES) pages.push(await measureRoute(base, route));
    return {
      measured: true,
      method:
        "HTTP: HTML + tài nguyên tĩnh tham chiếu trong HTML, gzip-9 (font/ảnh byte thật); next start, XS_DATA_SOURCE=fixtures; không gồm chunk động/RSC prefetch/ảnh lazy",
      command: `XS_DATA_SOURCE=fixtures pnpm --filter @x-shop/storefront build && PORT=${port} pnpm --filter @x-shop/storefront start`,
      pages,
    };
  } finally {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* đã thoát */
    }
  }
}

/** Mọi tiến trình thuộc nhóm pgid (backend chạy detached nên pgid = pid gốc). */
function sampleGroup(pgid) {
  const procs = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const st = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
      if (st.pgrp !== pgid) continue;
      const mem = parseProcStatus(readFileSync(`/proc/${name}/status`, "utf8"));
      procs.push({ cpuTicks: st.cpuTicks, ...mem });
    } catch {
      /* tiến trình vừa thoát */
    }
  }
  if (procs.length === 0) throw new Error(`không có tiến trình nào trong nhóm ${pgid}`);
  return sumProcs(procs);
}

async function measureBackend({ requests, concurrency }) {
  const serve = path.join(root, "scripts/load/serve.mjs");
  const { LOAD, BASE_URL, assertNotProduction } = await import("../load/env.mjs");
  const { pdpHandles, publishableKey, SERVE_STATE } = await import("../load/bench-pdp.mjs");
  assertNotProduction(BASE_URL);
  const started = spawnSync("node", [serve, "start"], { cwd: root, stdio: "inherit" });
  if (started.status !== 0) throw new Error(`serve.mjs start lỗi (mã ${started.status})`);
  try {
    const pgid = Number(JSON.parse(readFileSync(SERVE_STATE, "utf8")).pid);
    const key = publishableKey();
    const queue = pdpHandles(requests, LOAD.products);
    const hit = async (handle) => {
      const res = await fetch(`${BASE_URL}/store/x/products/${handle}`, {
        headers: { "x-publishable-api-key": key, "x-forwarded-for": "100.64.0.3" },
        signal: AbortSignal.timeout(15_000),
      });
      await res.arrayBuffer();
      return res.status;
    };
    // khởi động nóng 50 request (JIT/cache kết nối) — không tính vào số đo
    for (const h of pdpHandles(50, LOAD.products)) await hit(h);
    const before = sampleGroup(pgid);
    const statuses = new Map();
    let next = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < queue.length) {
          const s = await hit(queue[next++]).catch(() => 0);
          statuses.set(s, (statuses.get(s) ?? 0) + 1);
        }
      }),
    );
    const wallMs = performance.now() - t0;
    const after = sampleGroup(pgid);
    const ok = statuses.get(200) ?? 0;
    if (ok !== requests)
      throw new Error(`chỉ ${ok}/${requests} request 200 (${JSON.stringify([...statuses])})`);
    return {
      measured: true,
      method:
        "N request GET /store/x/products/:handle (PDP) qua scripts/load/serve.mjs; CPU = utime+stime, RSS = VmRSS cộng cả nhóm tiến trình backend, đọc /proc trước/sau (sau 50 request khởi động nóng)",
      command: `LOAD_PRODUCTS=${LOAD.products} node scripts/perf/baseline.mjs --requests ${requests} --concurrency ${concurrency}`,
      dataset: { products: LOAD.products, db: LOAD.dbName },
      concurrency,
      ...summarizeBackend({ before, after, requests, wallMs }),
    };
  } finally {
    spawnSync("node", [serve, "stop"], { cwd: root, stdio: "inherit" });
  }
}

function gitCommit() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const attempt = async (skip, why, fn) => {
    if (skip) return unmeasured(why);
    try {
      return await fn();
    } catch (e) {
      return unmeasured(e instanceof Error ? e.message : String(e));
    }
  };
  const storefront = await attempt(opts.skipStorefront, "bỏ qua bằng --skip-storefront", () =>
    measureStorefront(opts.port),
  );
  const backend = await attempt(opts.skipBackend, "bỏ qua bằng --skip-backend", () => measureBackend(opts));
  const now = new Date();
  const doc = buildBaseline({ commit: gitCommit(), now, env: environmentInfo(), storefront, backend });
  const dir = path.join(root, "docs/perf");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, baselineFileName(utcDate(now)));
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`[baseline] đã ghi ${path.relative(root, file)}`);
  return storefront.measured === false && backend.measured === false ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      console.error(`baseline: ${e.message}`);
      process.exit(2);
    },
  );
}
