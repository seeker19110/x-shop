/** Dựng báo cáo markdown của `pnpm load:smoke` (docs/ops/perf/load-smoke-latest.md). Hàm thuần — có test. */
import { renderPhaseTable, THRESHOLDS } from "./lib.mjs";

const num = (v) => (v === null || v === undefined ? "—" : Math.round(v));

/** Bảng chi tiết theo loại request (op) của một pha. */
export function renderOpTable(byOp) {
  const lines = ["| Request | Số lượng | p50 ms | p95 ms | Lỗi |", "|---|---:|---:|---:|---:|"];
  for (const o of byOp) lines.push(`| ${o.op} | ${o.count} | ${num(o.p50)} | ${num(o.p95)} | ${o.errors} |`);
  return lines.join("\n");
}

const sec = (ms) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);

/**
 * @param {object} d
 * @param {string} d.date ISO UTC
 * @param {object} d.config LOAD (đã dùng)
 * @param {object} d.machine { cpus, cpuModel, memGiB, node, pg, loadavg }
 * @param {object} d.timings thời gian từng bước dựng môi trường (ms)
 * @param {object|null} d.dataset { products, variants }
 * @param {{name:string, seconds:number, issued:{read:number,write:number}, evaluation:object, factor:number, gating:boolean}[]} d.phases
 * @param {{name:string, ok:boolean, detail:string}[]} d.checks
 * @param {{hit:number, read:number}} d.cache delta cache PostgreSQL trong lúc tải
 * @param {boolean} d.ok
 */
export function renderReport(d) {
  const L = [];
  L.push("# Kiểm tải smoke — kết quả mới nhất (T-036)", "");
  L.push(
    `Kết quả: **${d.ok ? "ĐẠT" : "KHÔNG ĐẠT"}** · ${d.date} · \`pnpm load:smoke\``,
    "",
    "> Máy dev dùng chung, một tiến trình Node vừa phát tải vừa chạy cạnh backend + PostgreSQL + Redis: đây là **cổng hồi quy ở tỷ lệ thu nhỏ**, không phải năng lực production và không thay thế chạy đầy đủ §10.3 trên staging (xem `README.md` và `load-dataset.md`).",
    "",
  );
  L.push("## Điều kiện tái lập", "");
  const c = d.config;
  L.push(
    `- Máy: ${d.machine.cpus} CPU (${d.machine.cpuModel}), ${d.machine.memGiB} GiB RAM, tải hệ thống đầu/cuối: ${d.machine.loadavg}; Node ${d.machine.node}; ${d.machine.pg}.`,
    `- Backend: Medusa 2.22.1 \`medusa start\` (1 tiến trình, worker shared), \`NODE_ENV=development\` (production từ chối mock GHN), GHN mock, chỉ COD, \`XS_TRUSTED_PROXIES=loopback\`; kết nối DB theo mặc định Medusa (không đặt pool).`,
    `- Dataset: ${d.dataset ? `${d.dataset.products} sản phẩm / ${d.dataset.variants} SKU (sinh mới)` : "dùng lại DB đã dựng (LOAD_REUSE=1)"} + 24 sản phẩm demo; seed ${c.seed}; DB \`${c.dbName}\`, Redis DB ${c.redisDb}, cổng ${c.port}.`,
    `- Tải (§10.3 khởi điểm = 100 đọc/s + 10 ghi/s; smoke = ${Math.round(100 / c.readRps)}× nhỏ hơn): **${c.readRps} request đọc/s + ${c.writeRps} thao tác ghi/s**; pha lạnh ${c.coldSeconds} s → steady ${c.steadySeconds} s → burst gấp đôi ${c.burstSeconds} s.`,
    `- Read mix 60% listing (lọc theo danh mục/màu/size/chất liệu/giá/sắp xếp/trang, kèm facet) · 20% PDP · 20% search; write mix 60% sửa giỏ · 20% quote · 20% submit COD (Idempotency-Key riêng; 15% submit gửi lại cùng khoá để kiểm idempotency). Mỗi khách ảo một IP qua X-Forwarded-For.`,
    `- Ngưỡng (§10.1): p95 đọc ≤ ${THRESHOLDS.p95Ms.read} ms, ghi ≤ ${THRESHOLDS.p95Ms.write} ms, checkout ≤ ${THRESHOLDS.p95Ms.checkout} ms; lỗi server < ${THRESHOLDS.errorRate * 100}%; burst: latency ≤ ${THRESHOLDS.burstLatencyFactor}× ngưỡng. Pha lạnh chỉ báo cáo (không làm cổng).`,
    "",
  );
  L.push("## Dựng môi trường", "", "| Bước | Thời gian |", "|---|---:|");
  for (const [k, v] of Object.entries(d.timings))
    L.push(`| ${k} | ${k === "reused" ? "dùng lại" : sec(v)} |`);
  L.push("");
  for (const p of d.phases) {
    const mark = p.gating ? (p.evaluation.ok ? "đạt" : "VƯỢT") : "chỉ báo cáo";
    L.push(
      `## Pha ${p.name} (${p.seconds} s, hệ số ngưỡng ×${p.factor}) — ${mark}`,
      "",
      `Đã phát: ${p.issued.read} đọc, ${p.issued.write} thao tác ghi.`,
      "",
      renderPhaseTable(p.evaluation),
      "",
      renderOpTable(p.byOp ?? []),
      "",
    );
  }
  const total = d.cache.hit + d.cache.read;
  L.push(
    "## Cache PostgreSQL",
    "",
    total > 0
      ? `Hit ratio vùng đệm trong lúc tải: ${((d.cache.hit / total) * 100).toFixed(2)}% (${d.cache.hit} hit / ${d.cache.read} read). Không phải hit ratio CDN: smoke đo origin, không CDN.`
      : "Không đo được.",
    "",
  );
  L.push("## Tính đúng sau tải", "", "| Kiểm tra | Kết quả | Chi tiết |", "|---|---|---|");
  for (const k of d.checks) L.push(`| ${k.name} | ${k.ok ? "đạt" : "KHÔNG ĐẠT"} | ${k.detail} |`);
  L.push("");
  return L.join("\n");
}
