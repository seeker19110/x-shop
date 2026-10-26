#!/usr/bin/env node
// Lighthouse lab theo hồ sơ khởi điểm của đặc tả §10.1: production build, viewport 390×844, CPU 4×, 1,6 Mbps xuống /
// 750 Kbps lên / RTT 150 ms. Mỗi trang chạy N lần (mặc định 5), báo từng lần + median + p75; đỏ (exit 1) khi median
// LCP > 2,5 s hoặc median CLS > 0,1 (hoặc thiếu mẫu). Mọi lần chạy là CACHE LẠNH (Lighthouse xoá lưu trữ giữa các lần);
// cache ấm chưa đo. INP không suy từ lab (§10.1) — chỉ ghi TBT để tham khảo, không làm ngưỡng.
// Dùng: node scripts/perf/lighthouse.mjs --base http://localhost:3000 --routes /,/danh-muc/ao --runs 5 --out docs/ops/perf
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";
import { LAB_LIMITS, LAB_PROFILE, summarizeLab } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const base = args.base ?? "http://localhost:3000";
const routes = (args.routes ?? "/").split(",");
const runs = Number(args.runs ?? 5);
const outDir = args.out ?? "docs/ops/perf";
if (!Number.isInteger(runs) || runs < 3) {
  console.error("--runs phải là số nguyên ≥ 3 (lab dao động: lấy median)");
  process.exit(2);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const settings = {
  onlyCategories: ["performance"],
  formFactor: "mobile",
  screenEmulation: { mobile: true, ...LAB_PROFILE.viewport, deviceScaleFactor: 2, disabled: false },
  // Điều tiết ÁP DỤNG thật (devtools), không phải mô phỏng: `simulate` trên localhost HTTP/1.1 (6 kết nối/origin, không
  // có CDN/HTTP2) cho LCP dao động ±0,3 s quanh ngưỡng — không dùng làm cổng. Hệ số theo quy ước của Lighthouse cho
  // điều tiết áp dụng: độ trễ mỗi request = RTT × 3,75 (bù bắt tay TCP/TLS không được mô phỏng), băng thông × 0,9.
  throttlingMethod: "devtools",
  throttling: {
    rttMs: LAB_PROFILE.rttMs,
    throughputKbps: LAB_PROFILE.throughputKbps,
    requestLatencyMs: LAB_PROFILE.rttMs * 3.75,
    downloadThroughputKbps: LAB_PROFILE.throughputKbps * 0.9,
    uploadThroughputKbps: LAB_PROFILE.uploadKbps * 0.9,
    cpuSlowdownMultiplier: LAB_PROFILE.cpuSlowdownMultiplier,
  },
  output: "json",
  logLevel: "error",
};

const executablePath = process.env.XT_CHROMIUM || undefined;
const port = await freePort();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: [`--remote-debugging-port=${port}`],
});
const chromeVersion = browser.version();
const pages = [];
let failed = false;
try {
  for (const route of routes) {
    const url = new URL(route, base).toString();
    const results = [];
    for (let i = 0; i < runs; i++) {
      const r = await lighthouse(url, { port }, { extends: "lighthouse:default", settings });
      const lhr = r?.lhr;
      if (!lhr || lhr.runtimeError) {
        console.log(`✗ ${route} lần ${i + 1}: ${lhr?.runtimeError?.message ?? "không có kết quả"}`);
        results.push({
          lcpMs: Number.NaN,
          cls: Number.NaN,
          tbtMs: Number.NaN,
          error: lhr?.runtimeError?.code ?? "NO_RESULT",
        });
        continue;
      }
      const a = lhr.audits;
      results.push({
        lcpMs: a["largest-contentful-paint"]?.numericValue ?? Number.NaN,
        cls: a["cumulative-layout-shift"]?.numericValue ?? Number.NaN,
        tbtMs: a["total-blocking-time"]?.numericValue ?? Number.NaN,
        fcpMs: a["first-contentful-paint"]?.numericValue ?? Number.NaN,
        // Phần tử LCP để điều tra outlier (§10.1): phần tử nào, và bao lâu là tải/hiển thị.
        lcpElement:
          a["lcp-breakdown-insight"]?.details?.items?.find((i) => i.type === "node")?.snippet ?? null,
        lighthouseVersion: lhr.lighthouseVersion,
      });
    }
    const summary = summarizeLab(results);
    if (summary.over.length) failed = true;
    pages.push({ route, results, summary });
  }
} finally {
  await browser.close();
}

const num = (v, d = 0) => (v === null || Number.isNaN(v) ? "n/a" : v.toFixed(d));
const lines = [];
for (const p of pages) {
  const s = p.summary;
  lines.push(
    `${s.over.length ? "✗" : "✓"} ${p.route}  LCP median ${num(s.lcpMedianMs)} ms (p75 ${num(s.lcpP75Ms)}; ≤ ${LAB_LIMITS.lcpMs})  CLS median ${num(s.clsMedian, 3)} (p75 ${num(s.clsP75, 3)}; ≤ ${LAB_LIMITS.cls})  TBT median ${num(s.tbtMedianMs)} ms  [${s.runs} lần]${s.over.length ? `  VƯỢT: ${s.over.join(",")}` : ""}`,
  );
}
console.log(lines.join("\n"));

const meta = {
  generatedAt: new Date().toISOString(),
  chrome: chromeVersion,
  lighthouse: pages[0]?.results.find((r) => r.lighthouseVersion)?.lighthouseVersion ?? null,
  node: process.version,
  profile: LAB_PROFILE,
  limits: LAB_LIMITS,
  throttlingMethod: settings.throttlingMethod,
  cache: "cold (mỗi lần chạy xoá lưu trữ)",
  base,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "lighthouse-latest.json"), JSON.stringify({ meta, pages }, null, 2));
const md = [
  "# Lighthouse lab — kết quả mới nhất",
  "",
  `Sinh bởi \`pnpm perf:budget\` (scripts/perf/lighthouse.mjs) lúc ${meta.generatedAt}. Hồ sơ đặc tả §10.1: 390×844, CPU ${LAB_PROFILE.cpuSlowdownMultiplier}×, ${LAB_PROFILE.throughputKbps} Kbps xuống / ${LAB_PROFILE.uploadKbps} Kbps lên / RTT ${LAB_PROFILE.rttMs} ms (Lighthouse \`devtools\`: điều tiết áp dụng thật). Chrome ${meta.chrome}, Lighthouse ${meta.lighthouse}, ${meta.node}. Dữ liệu mẫu (fixtures), cache lạnh. Ngưỡng theo median: LCP ≤ ${LAB_LIMITS.lcpMs} ms, CLS ≤ ${LAB_LIMITS.cls}. Đây là lab, không phải Core Web Vitals thực (không tuyên bố đạt CWV từ lab; INP đo bằng interaction test/RUM).`,
  "",
  "| Trang | Lần | LCP (ms) | CLS | TBT (ms) |",
  "|---|---|---|---|---|",
  ...pages.flatMap((p) =>
    p.results.map(
      (r, i) => `| ${p.route} | ${i + 1} | ${num(r.lcpMs)} | ${num(r.cls, 3)} | ${num(r.tbtMs)} |`,
    ),
  ),
  "",
  "| Trang | LCP median | LCP p75 | CLS median | CLS p75 | TBT median | Kết quả |",
  "|---|---|---|---|---|---|---|",
  ...pages.map((p) => {
    const s = p.summary;
    return `| ${p.route} | ${num(s.lcpMedianMs)} | ${num(s.lcpP75Ms)} | ${num(s.clsMedian, 3)} | ${num(s.clsP75, 3)} | ${num(s.tbtMedianMs)} | ${s.over.length ? `VƯỢT: ${s.over.join(", ")}` : "đạt"} |`;
  }),
  "",
].join("\n");
writeFileSync(path.join(outDir, "lighthouse-latest.md"), md);
process.exit(failed ? 1 : 0);
