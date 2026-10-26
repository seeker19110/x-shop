#!/usr/bin/env node
// Ngân sách tài nguyên tải đầu (đặc tả §10.2): đo trên bản build production đang chạy, bằng trình duyệt thật,
// mọi phản hồi phát sinh khi tải trang (gồm RSC/prefetch thực), cộng kích thước gzip theo loại. Đỏ (exit 1) khi vượt.
// Dùng: node scripts/perf/budget.mjs --base http://localhost:3000 [--routes /,/danh-muc/ao] [--json out.json]
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { BUDGET, LAB_PROFILE, fmtKiB, kind, overBudget } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const base = args.base ?? "http://localhost:3000";
const routes = (args.routes ?? "/").split(",");

const executablePath = process.env.XT_CHROMIUM || undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const report = [];
let failed = false;
for (const route of routes) {
  // Hồ sơ mobile của đặc tả §10.1: viewport 390×844.
  const ctx = await browser.newContext({ viewport: LAB_PROFILE.viewport, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const sizes = { js: 0, css: 0, font: 0, image: 0, rsc: 0, html: 0, other: 0 };
  const pending = [];
  page.on("response", (res) => {
    pending.push(
      res
        .body()
        .then((body) => {
          const k = kind(res.headers()["content-type"] ?? "", res.url());
          // Ảnh/font đã nén sẵn: tính kích thước thật; văn bản: gzip mức 9 như CDN.
          sizes[k] += k === "image" || k === "font" ? body.length : gzipSync(body, { level: 9 }).length;
        })
        .catch((err) => {
          // Phản hồi redirect/bị hủy không có body: bỏ qua nhưng để lại dấu vết.
          console.warn(`[budget] bỏ qua body ${res.url()}: ${err instanceof Error ? err.message : err}`);
        }),
    );
  });
  const main = await page.goto(new URL(route, base).toString(), { waitUntil: "networkidle" });
  // Không đo trang lỗi như thể là trang thật.
  if (!main || main.status() >= 400) {
    console.log(`✗ ${route} trả HTTP ${main ? main.status() : "không phản hồi"} — không đo`);
    failed = true;
    await ctx.close();
    continue;
  }
  await Promise.all(pending);
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  const over = overBudget(sizes);
  if (over.length) failed = true;
  report.push({ route, ...sizes, total, over });
  await ctx.close();
}
await browser.close();

// Bảng: mỗi hàng một route; ô vượt ngân sách đánh dấu "!" và nêu rõ ở cột cuối.
const cell = (v, limit) => `${fmtKiB(v)}${v > limit ? " !" : ""}`;
const rows = [
  [
    "route",
    `js (≤ ${BUDGET.js / 1024})`,
    `css (≤ ${BUDGET.css / 1024})`,
    `font (≤ ${BUDGET.font / 1024})`,
    `tổng (≤ ${BUDGET.total / 1024})`,
    "kết quả",
  ],
  ...report.map((r) => [
    r.route,
    cell(r.js, BUDGET.js),
    cell(r.css, BUDGET.css),
    cell(r.font, BUDGET.font),
    cell(r.total, BUDGET.total),
    r.over.length ? `VƯỢT: ${r.over.join(",")}` : "đạt",
  ]),
];
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
for (const r of rows) console.log(r.map((c, i) => c.padEnd(w[i])).join("  "));
if (args.json)
  writeFileSync(args.json, JSON.stringify({ budget: BUDGET, profile: LAB_PROFILE, report }, null, 2));
process.exit(failed ? 1 : 0);
