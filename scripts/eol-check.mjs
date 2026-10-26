#!/usr/bin/env node
// Theo dõi EOL bằng máy (OPS-MAINT-003): đọc phiên bản đang dùng từ .nvmrc và image service của CI, đối chiếu
// endoflife.date. Đã EOL → exit 1; còn < 6 tháng (183 ngày) → cảnh báo, exit 0. Không gọi được mạng → cảnh báo, exit 0
// (cổng không đỏ vì mạng); `--strict` biến lỗi mạng thành exit 1. Chạy tuần bởi workflow `vuln-scan` (job eol-check).
// CLI: node scripts/eol-check.mjs [--strict]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WARN_DAYS = 183;
const DAY = 86_400_000;

/** Phiên bản dùng thật: [{product, version, source}]. Thiếu nguồn thì bỏ qua mục đó. */
export function collectUsage({ nvmrc, ciYml }) {
  const out = [];
  const node = /^v?(\d+(?:\.\d+){0,2})\s*$/m.exec(nvmrc ?? "");
  if (node) out.push({ product: "nodejs", version: node[1], source: ".nvmrc" });
  for (const [product, image] of [
    ["postgresql", "postgres"],
    ["redis", "redis"],
  ]) {
    const m = new RegExp(`image:\\s*${image}:(\\d+(?:\\.\\d+)?)`).exec(ciYml ?? "");
    if (m) out.push({ product, version: m[1], source: `ci.yml (image ${image})` });
  }
  return out;
}

/** Chọn chu kỳ khớp phiên bản: bằng đúng, hoặc tiền tố theo dấu chấm (7 → 7.4 mới nhất; 22.22.0 → 22). */
export function matchCycle(cycles, version) {
  const list = Array.isArray(cycles) ? cycles : [];
  const parts = String(version).split(".");
  for (let n = parts.length; n >= 1; n--) {
    const want = parts.slice(0, n).join(".");
    const hit =
      list.find((c) => String(c.cycle) === want) ?? list.find((c) => String(c.cycle).startsWith(`${want}.`));
    if (hit) return hit;
  }
  return null;
}

/** Trạng thái: {level: ok|warn|eol|unknown, eol, days}. `eol`: false | true | "YYYY-MM-DD". */
export function evaluate(cycle, now = new Date()) {
  if (!cycle) return { level: "unknown", eol: null, days: null };
  const eol = cycle.eol;
  if (eol === false || eol === undefined || eol === null) return { level: "ok", eol: false, days: null };
  if (eol === true) return { level: "eol", eol: true, days: 0 };
  const t = Date.parse(`${eol}T00:00:00Z`);
  if (Number.isNaN(t)) return { level: "unknown", eol, days: null };
  const days = Math.floor((t - now.getTime()) / DAY);
  if (days < 0) return { level: "eol", eol, days };
  return { level: days < WARN_DAYS ? "warn" : "ok", eol, days };
}

async function fetchCycles(product) {
  const res = await fetch(`https://endoflife.date/api/${product}.json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function main(argv = process.argv.slice(2), fetcher = fetchCycles, now = new Date()) {
  const strict = argv.includes("--strict");
  const usage = collectUsage({
    nvmrc: readFileSync(".nvmrc", "utf8"),
    ciYml: readFileSync(".github/workflows/ci.yml", "utf8"),
  });
  let bad = 0;
  for (const u of usage) {
    let r;
    try {
      r = evaluate(matchCycle(await fetcher(u.product), u.version), now);
    } catch (e) {
      console.log(`::warning::eol-check: không tra được ${u.product} (${e.message})`);
      if (strict) bad++;
      continue;
    }
    const msg = `${u.product} ${u.version} (${u.source}): ${r.level}${r.eol ? ` — EOL ${r.eol}` : ""}${r.days != null ? ` (${r.days} ngày)` : ""}`;
    if (r.level === "eol") {
      console.log(`::error::${msg}`);
      bad++;
    } else if (r.level === "warn" || r.level === "unknown") console.log(`::warning::${msg}`);
    else console.log(msg);
  }
  return bad ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main());
