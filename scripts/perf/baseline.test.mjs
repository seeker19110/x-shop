import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baselineFileName,
  buildBaseline,
  environmentInfo,
  extractAssets,
  parseArgs,
  parseProcStat,
  parseProcStatus,
  summarizeBackend,
  summarizePage,
  sumProcs,
  transferBytes,
  unmeasured,
  utcDate,
} from "./baseline.mjs";

test("utcDate: theo UTC, không theo múi giờ cục bộ", () => {
  assert.equal(utcDate(new Date("2026-10-31T23:59:59Z")), "2026-10-31");
  assert.equal(utcDate(new Date("2026-11-01T00:00:00Z")), "2026-11-01");
});

test("baselineFileName: chặn ngày sai định dạng", () => {
  assert.equal(baselineFileName("2026-10-31"), "baseline-2026-10-31.json");
  assert.throws(() => baselineFileName("31/10/2026"));
  assert.throws(() => baselineFileName("../x"));
});

test("extractAssets: script/link/img, bỏ trùng, giải &amp;, bỏ data:", () => {
  const html = `<link rel="stylesheet" href="/_next/a.css"/>
    <link rel="preload" as="font" href="/_next/f.woff2"/>
    <link rel="canonical" href="/x"/>
    <script src="/_next/a.js" async></script><script src="/_next/a.js"></script>
    <script>inline()</script>
    <img src="/_next/image?url=a&amp;w=64"/><img src="data:image/png;base64,AAA"/>`;
  assert.deepEqual(extractAssets(html), [
    "/_next/a.js",
    "/_next/a.css",
    "/_next/f.woff2",
    "/_next/image?url=a&w=64",
  ]);
  assert.deepEqual(extractAssets(""), []);
});

test("summarizePage: rỗng = 0 request; loại lạ gộp vào other", () => {
  assert.deepEqual(summarizePage([]).requests, 0);
  assert.equal(summarizePage([]).totalBytes, 0);
  const s = summarizePage([
    { kind: "html", bytes: 1024 },
    { kind: "js", bytes: 2048 },
    { kind: "weird", bytes: 10 },
  ]);
  assert.equal(s.requests, 3);
  assert.equal(s.totalBytes, 3082);
  assert.equal(s.bytes.other, 10);
  assert.equal(s.totalKiB, 3);
});

test("transferBytes: font/ảnh giữ nguyên, văn bản được nén", () => {
  const body = Buffer.from("a".repeat(5000));
  assert.equal(transferBytes("font", body), 5000);
  assert.equal(transferBytes("image", body), 5000);
  assert.ok(transferBytes("js", body) < 100);
  assert.ok(transferBytes("js", Buffer.alloc(0)) > 0); // gzip rỗng vẫn có header
});

test("parseProcStat: tên tiến trình có khoảng trắng và ngoặc", () => {
  const line = "123 (node (v8) x) S 1 77 77 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 11 0 5 1000 2000";
  assert.deepEqual(parseProcStat(line), { pgrp: 77, cpuTicks: 300 });
  assert.throws(() => parseProcStat("garbage"));
});

test("parseProcStatus: kB; thiếu trường → 0", () => {
  assert.deepEqual(parseProcStatus("Name:\tnode\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\n"), {
    rssKiB: 1024,
    hwmKiB: 2048,
  });
  assert.deepEqual(parseProcStatus("Name:\tkworker\n"), { rssKiB: 0, hwmKiB: 0 });
});

test("sumProcs: rỗng = 0", () => {
  assert.deepEqual(sumProcs([]), { cpuTicks: 0, rssKiB: 0, hwmKiB: 0 });
  assert.deepEqual(
    sumProcs([
      { cpuTicks: 1, rssKiB: 2, hwmKiB: 3 },
      { cpuTicks: 10, rssKiB: 20, hwmKiB: 30 },
    ]),
    { cpuTicks: 11, rssKiB: 22, hwmKiB: 33 },
  );
});

test("summarizeBackend: tính CPU/request, RSS, thông lượng", () => {
  const s = summarizeBackend({
    before: { cpuTicks: 1000, rssKiB: 102_400, hwmKiB: 110_000 },
    after: { cpuTicks: 1500, rssKiB: 112_640, hwmKiB: 204_800 },
    requests: 1000,
    wallMs: 10_000,
  });
  assert.equal(s.cpuMs, 5000);
  assert.equal(s.cpuMsPerRequest, 5);
  assert.equal(s.requestsPerSecond, 100);
  assert.equal(s.cpuUtilizationPercentOfOneCore, 50);
  assert.equal(s.rssBeforeMiB, 100);
  assert.equal(s.rssDeltaMiB, 10);
  assert.equal(s.peakRssSumMiB, 200);
});

test("summarizeBackend: CPU không đổi = 0 (không phải null); đầu vào sai → ném lỗi", () => {
  const m = { cpuTicks: 5, rssKiB: 1, hwmKiB: 1 };
  assert.equal(summarizeBackend({ before: m, after: m, requests: 1, wallMs: 1 }).cpuMs, 0);
  assert.throws(() => summarizeBackend({ before: m, after: m, requests: 0, wallMs: 1 }));
  assert.throws(() => summarizeBackend({ before: m, after: m, requests: 1, wallMs: 0 }));
  assert.throws(() => summarizeBackend({ before: m, after: { ...m, cpuTicks: 1 }, requests: 1, wallMs: 1 }));
});

test("buildBaseline + unmeasured: null kèm reason", () => {
  const now = new Date("2026-10-31T10:00:00Z");
  const doc = buildBaseline({
    commit: "abc",
    now,
    env: environmentInfo(
      { cpus: () => [{ model: " X CPU " }, {}], totalmem: () => 2 ** 33 },
      { version: "v24", platform: "linux", arch: "x64" },
    ),
    storefront: unmeasured("không có build"),
    backend: unmeasured("không có dataset"),
  });
  assert.equal(doc.dateUtc, "2026-10-31");
  assert.equal(doc.commit, "abc");
  assert.equal(doc.environment.cpuCores, 2);
  assert.equal(doc.environment.cpuModel, "X CPU");
  assert.equal(doc.environment.memTotalGiB, 8);
  assert.equal(doc.storefront.value, null);
  assert.equal(doc.backend.reason, "không có dataset");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(doc)));
});

test("parseArgs: mặc định, cờ, giá trị sai", () => {
  assert.equal(parseArgs([]).requests, 1000);
  assert.equal(parseArgs(["--requests", "5", "--skip-storefront"]).skipStorefront, true);
  assert.throws(() => parseArgs(["--requests", "0"]));
  assert.throws(() => parseArgs(["--requests", "x"]));
  assert.throws(() => parseArgs(["--lạ"]));
});
