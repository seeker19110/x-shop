#!/usr/bin/env node
/**
 * `pnpm load:smoke` (T-036) — kiểm tải smoke theo đặc tả §10.3 ở tỷ lệ thu nhỏ:
 *   1. dựng môi trường tải (DB riêng + dataset 10.000 sản phẩm / 50.000 SKU, xem prepare.mjs); LOAD_REUSE=1 giữ DB cũ
 *   2. bật backend (cổng riêng, mock provider), chạy 3 pha: lạnh → steady → burst gấp đôi (workload.mjs)
 *   3. stress 50 lượt đặt đồng thời cho SKU còn 1 đơn vị
 *   4. kiểm tính đúng trong DB (verify.mjs): không âm tồn, không đơn trùng idempotency, không mất đơn
 *   5. ghi docs/ops/perf/load-smoke-latest.md (+ .json không commit); dừng backend; thoát ≠ 0 nếu vượt ngưỡng/sai
 * Biến: xem env.mjs (LOAD_*). Kịch bản đầy đủ chạy bằng k6: scripts/load/k6/xshop-load.js.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE_URL, LOAD } from "./env.mjs";
import { evaluatePhase, groupSamples, summarizeByOp, THRESHOLDS } from "./lib.mjs";
import { connectDb, log, prepare, root, startBackend } from "./prepare.mjs";
import { renderReport } from "./report.mjs";
import { pgCacheStats, snapshotBefore, verifyAfter } from "./verify.mjs";
import { createContext, runContention, runPhase } from "./workload.mjs";

const outDir = path.join(root, "docs/ops/perf");

async function getJson(pathname, key) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "x-publishable-api-key": key, "x-forwarded-for": "100.64.0.1" },
  });
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
  return res.json();
}

function machineInfo(pgVersion) {
  const cpus = os.cpus();
  return {
    cpus: cpus.length,
    cpuModel: cpus[0]?.model?.trim() ?? "?",
    memGiB: (os.totalmem() / 2 ** 30).toFixed(1),
    node: process.version,
    pg: pgVersion,
    loadavg: os
      .loadavg()
      .map((x) => x.toFixed(2))
      .join("/"),
  };
}

async function main() {
  const started = new Date();
  // Log backend trong node_modules/.cache của repo (đã gitignore) — không ghi ra ngoài worktree.
  const logDir = path.join(root, "node_modules/.cache/xshop-load");
  mkdirSync(logDir, { recursive: true });
  const backendLog = path.join(logDir, "backend.log");
  const prep = await prepare();
  log(`bật backend (log: ${backendLog})`);
  const backend = await startBackend(backendLog);
  const stopAll = () => backend.stop();
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      stopAll();
      process.exit(130);
    });
  }
  const db = await connectDb();
  try {
    const pgVersion = (await db.query("SHOW server_version")).rows[0].server_version;
    const machineStart = machineInfo(`PostgreSQL ${pgVersion}`);
    const regions = await getJson("/store/regions", prep.publishableKey);
    const regionId = regions.regions.find((r) => r.currency_code === "vnd")?.id;
    const provinces = (await getJson("/store/x/addresses/provinces", prep.publishableKey)).provinces;
    const province = provinces[0].code;
    const ward = (await getJson(`/store/x/addresses/provinces/${province}/wards`, prep.publishableKey))
      .wards[0].code;
    const ctx = createContext({
      base: BASE_URL,
      key: prep.publishableKey,
      regionId,
      products: LOAD.products,
      province,
      ward,
      seed: LOAD.seed,
      excluded: [prep.contention.variantId],
    });
    const before = await snapshotBefore(db);
    const cacheBefore = await pgCacheStats(db);

    const plan = [
      { name: "lạnh", seconds: LOAD.coldSeconds, factor: 1, rate: 1, gating: false },
      { name: "steady", seconds: LOAD.steadySeconds, factor: 1, rate: 1, gating: true },
      {
        name: "burst (gấp đôi)",
        seconds: LOAD.burstSeconds,
        factor: THRESHOLDS.burstLatencyFactor,
        rate: 2,
        gating: true,
      },
    ];
    const phases = [];
    const allSamples = [];
    for (const p of plan) {
      log(`pha ${p.name}: ${p.seconds} s, ${LOAD.readRps * p.rate} đọc/s + ${LOAD.writeRps * p.rate} ghi/s`);
      const res = await runPhase(ctx, {
        name: p.name,
        seconds: p.seconds,
        readRps: LOAD.readRps * p.rate,
        writeRps: LOAD.writeRps * p.rate,
      });
      allSamples.push(...res.samples);
      const evaluation = evaluatePhase(groupSamples(res.samples), { factor: p.factor, dropped: res.dropped });
      phases.push({
        ...p,
        seconds: p.seconds,
        issued: res.issued,
        evaluation,
        byOp: summarizeByOp(res.samples),
      });
      log(`  → ${evaluation.ok ? "đạt" : "VƯỢT"} (${res.samples.length} request)`);
    }

    log(`stress ${LOAD.contention} lượt đặt đồng thời cho ${prep.contention.variantId} (tồn 1)`);
    const contentionResult = await runContention(ctx, {
      variantId: prep.contention.variantId,
      concurrency: LOAD.contention,
    });
    const cacheAfter = await pgCacheStats(db);
    const checks = await verifyAfter(db, ctx, { before, contention: prep.contention, contentionResult });
    const overall = groupSamples(allSamples).overall;
    checks.push({
      name: `Tỷ lệ lỗi toàn phiên (cả pha lạnh) < ${THRESHOLDS.errorRate * 100}%`,
      ok: overall.errorRate !== null && overall.errorRate < THRESHOLDS.errorRate,
      detail: `${overall.errors}/${overall.count}`,
    });

    const gating = phases.filter((p) => p.gating);
    const ok = gating.every((p) => p.evaluation.ok) && checks.every((c) => c.ok);
    const machineEnd = machineInfo(machineStart.pg);
    const report = {
      date: started.toISOString(),
      config: { ...LOAD, dbName: LOAD.dbName },
      machine: { ...machineStart, loadavg: `${machineStart.loadavg} → ${machineEnd.loadavg}` },
      timings: prep.timings,
      dataset: prep.dataset,
      phases,
      checks,
      cache: { hit: cacheAfter.hit - cacheBefore.hit, read: cacheAfter.read - cacheBefore.read },
      ok,
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "load-smoke-latest.md"), `${renderReport(report)}\n`);
    writeFileSync(path.join(outDir, "load-smoke-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n${renderReport(report)}`);
    if (!ok) console.error("\n[load] KHÔNG ĐẠT — xem bảng trên và docs/ops/perf/load-smoke-latest.md");
    return ok ? 0 : 1;
  } finally {
    await db
      .end()
      .catch((err) =>
        console.error(`[load] đóng kết nối DB lỗi: ${err instanceof Error ? err.message : err}`),
      );
    stopAll();
    // Chờ nhóm tiến trình backend (do script này tạo) nhận SIGTERM và thoát.
    await new Promise((r) => setTimeout(r, 1000));
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[load] LỖI: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    process.exit(1);
  });
