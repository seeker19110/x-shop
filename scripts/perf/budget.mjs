#!/usr/bin/env node
// Ngân sách tài nguyên tải đầu (đặc tả §10.2): đo trên bản build production đang chạy, bằng trình duyệt thật,
// mọi phản hồi phát sinh khi tải trang (gồm RSC/prefetch thực), cộng kích thước gzip theo loại. Đỏ (exit 1) khi vượt.
// Dùng: node scripts/perf/budget.mjs --base http://localhost:3000 [--routes /,/danh-muc/ao] [--json out.json]
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const base = args.base ?? "http://localhost:3000";
const routes = (args.routes ?? "/").split(",");
const KiB = 1024;
export const BUDGET = { js: 200 * KiB, css: 50 * KiB, font: 100 * KiB, total: 900 * KiB };

function kind(contentType, url) {
  if (/javascript/.test(contentType) || /\.m?js(\?|$)/.test(url)) return "js";
  if (/css/.test(contentType)) return "css";
  if (/font|woff2?/.test(contentType) || /\.woff2?(\?|$)/.test(url)) return "font";
  if (/^image\//.test(contentType)) return "image";
  if (/text\/x-component/.test(contentType) || /_rsc=/.test(url)) return "rsc";
  if (/html/.test(contentType)) return "html";
  return "other";
}

const executablePath = process.env.XT_CHROMIUM || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const report = [];
let failed = false;
for (const route of routes) {
  // Hồ sơ mobile của đặc tả §10.1: viewport 390×844.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const sizes = { js: 0, css: 0, font: 0, image: 0, rsc: 0, html: 0, other: 0 };
  const pending = [];
  page.on("response", (res) => {
    pending.push(
      res
        .body()
        .then((body) => {
          const k = kind(res.headers()["content-type"] ?? "", res.url());
          // Ảnh đã nén sẵn: tính kích thước thật; văn bản: gzip mức 9 như CDN.
          sizes[k] += k === "image" || k === "font" ? body.length : gzipSync(body, { level: 9 }).length;
        })
        .catch(() => {}),
    );
  });
  await page.goto(new URL(route, base).toString(), { waitUntil: "networkidle" });
  await Promise.all(pending);
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  const over = [];
  for (const k of ["js", "css", "font"]) if (sizes[k] > BUDGET[k]) over.push(k);
  if (total > BUDGET.total) over.push("total");
  if (over.length) failed = true;
  report.push({ route, ...sizes, total, over });
  await ctx.close();
}
await browser.close();
for (const r of report) {
  const f = (n) => `${(n / KiB).toFixed(1)}KiB`;
  console.log(
    `${r.over.length ? "✗" : "✓"} ${r.route} js=${f(r.js)} css=${f(r.css)} font=${f(r.font)} img=${f(r.image)} rsc=${f(r.rsc)} html=${f(r.html)} total=${f(r.total)}${r.over.length ? ` VƯỢT: ${r.over.join(",")}` : ""}`,
  );
}
if (args.json) writeFileSync(args.json, JSON.stringify({ budget: BUDGET, report }, null, 2));
process.exit(failed ? 1 : 0);
