// Hàm thuần dùng chung cho kiểm tải (đặc tả §10.3, ngưỡng §10.1) — có test ở lib.test.mjs.
import { percentile } from "../perf/lib.mjs";

export { percentile };

/** PRNG tất định (mulberry32): cùng seed → cùng dãy; dùng để chọn nội dung request (không dùng cho thời điểm). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Số nguyên đều trong [lo, hi] (cả hai đầu). */
export const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Chọn theo trọng số: entries = [[giá_trị, trọng_số], …]; tổng trọng số 0 → lỗi (không âm thầm chọn bừa). */
export function pickWeighted(rng, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!(total > 0)) throw new Error("Tổng trọng số phải > 0");
  let x = rng() * total;
  for (const [v, w] of entries) {
    if (x < w) return v;
    x -= w;
  }
  return entries[entries.length - 1][0];
}

/**
 * "Bộ bài" chọn theo trọng số CHÍNH XÁC: mỗi vòng gồm đủ số lá theo tỷ lệ (60/20/20 → 6+2+2 trên 10 lá, xáo bằng PRNG),
 * hết vòng xáo lại. Mix cố định của §10.3 được giữ đúng trên mọi cửa sổ 10 request, kể cả khi chạy ngắn.
 */
export function createDeck(rng, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!(total > 0) || entries.some(([, w]) => !Number.isInteger(w) || w < 0)) {
    throw new Error("Trọng số bộ bài phải là số nguyên không âm, tổng > 0");
  }
  const g = entries.reduce((a, [, w]) => gcd(a, w), 0);
  let deck = [];
  return () => {
    if (deck.length === 0) {
      deck = entries.flatMap(([v, w]) => Array(w / g).fill(v));
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
    }
    return deck.pop();
  };
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/** Read mix và write mix cố định của §10.3. */
export const READ_MIX = [
  ["listing", 60],
  ["pdp", 20],
  ["search", 20],
];
export const WRITE_MIX = [
  ["cart_edit", 60],
  ["quote", 20],
  ["submit", 20],
];

/**
 * Ngưỡng theo §10.1 (p95, ms) và tỷ lệ lỗi < 0,5%. Nhóm đo:
 *  - read: listing + PDP + search (API catalog/search ≤ 300 ms)
 *  - write: tạo/sửa giỏ + báo giá (API ghi nội bộ ≤ 700 ms)
 *  - checkout: submit COD với provider giả (Checkout nội bộ ≤ 2 giây)
 * Burst (tăng gấp đôi): latency tối đa gấp đôi ngưỡng steady, lỗi vẫn < 0,5%.
 */
export const THRESHOLDS = {
  p95Ms: { read: 300, write: 700, checkout: 2000 },
  errorRate: 0.005,
  burstLatencyFactor: 2,
};

/** Request thuộc nhóm đo nào. */
export function groupOf(op) {
  if (op === "listing" || op === "pdp" || op === "search") return "read";
  if (op === "cart_create" || op === "cart_add" || op === "cart_update" || op === "quote") return "write";
  if (op === "submit") return "checkout";
  return "setup";
}

/**
 * Phân loại kết quả một request: "ok" | "business" (lỗi nghiệp vụ hợp lệ, không tính vào lỗi server) | "error".
 * Mạng/timeout (status 0), 5xx và 429 (rate limit chặn tải = cấu hình môi trường tải sai) luôn là lỗi; 4xx ngoài danh
 * sách cho phép cũng là lỗi vì bộ sinh request luôn gửi đầu vào hợp lệ.
 */
export function classify(op, status, { allowBusiness = [] } = {}) {
  if (!Number.isInteger(status) || status === 0 || status >= 500 || status === 429) return "error";
  if (status >= 200 && status < 300) return "ok";
  return allowBusiness.includes(status) ? "business" : "error";
}

/** Tóm tắt mẫu [{ms, outcome}] của một nhóm. Không có mẫu → p95 null (KHÔNG coi là đạt). */
export function summarize(samples) {
  const ms = samples.map((s) => s.ms);
  const errors = samples.filter((s) => s.outcome === "error").length;
  return {
    count: samples.length,
    errors,
    business: samples.filter((s) => s.outcome === "business").length,
    errorRate: samples.length === 0 ? null : errors / samples.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    max: ms.length ? Math.max(...ms) : null,
    // Phân bố "trạng thái:mã" của request không ok (mã problem+json) — để biết VÌ SAO lỗi, không chỉ có bao nhiêu.
    codes: countBy(samples.filter((s) => s.outcome !== "ok").map((s) => `${s.status}:${s.code ?? "-"}`)),
  };
}

function countBy(xs) {
  const o = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

/** Bảng theo từng loại request (op): để thấy request nào kéo p95. Trả [{op, ...summarize}] sắp theo tên. */
export function summarizeByOp(samples) {
  const ops = [...new Set(samples.map((s) => s.op))].sort();
  return ops.map((op) => ({ op, ...summarize(samples.filter((s) => s.op === op)) }));
}

/**
 * Đánh giá một pha theo ngưỡng. `factor` nhân ngưỡng latency (burst = 2). Nhóm không có mẫu → không đạt
 * ("không đo được" ≠ "đạt"). `dropped` (request không phát được vì đầy hàng chờ của máy tải) là lỗi của phép đo.
 */
export function evaluatePhase(byGroup, { factor = 1, dropped = 0, thresholds = THRESHOLDS } = {}) {
  const rows = [];
  for (const group of ["read", "write", "checkout"]) {
    const s = byGroup[group] ?? summarize([]);
    const limit = thresholds.p95Ms[group] * factor;
    const okLatency = s.p95 !== null && s.p95 <= limit;
    const okErrors = s.errorRate !== null && s.errorRate < thresholds.errorRate;
    rows.push({ group, ...s, limit, okLatency, okErrors, ok: okLatency && okErrors });
  }
  // Tỷ lệ lỗi chung (gồm cả request chuẩn bị/setup) cũng phải < 0,5%; không có mẫu nào → không đạt.
  const overall = byGroup.overall ?? summarize([]);
  const okOverall = overall.errorRate !== null && overall.errorRate < thresholds.errorRate;
  const okDropped = dropped === 0;
  return {
    rows,
    overall,
    okOverall,
    dropped,
    okDropped,
    ok: okDropped && okOverall && rows.every((r) => r.ok),
  };
}

const f = (v) => (v === null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));
const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);

/** Bảng markdown cho một pha. */
export function renderPhaseTable(evaluation) {
  const lines = [
    "| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const r of evaluation.rows) {
    lines.push(
      `| ${r.group} | ${r.count} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ≤ ${r.limit} | ${r.errors} | ${pct(r.errorRate)} | ${r.business} | ${r.ok ? "đạt" : "VƯỢT"} |`,
    );
  }
  const o = evaluation.overall;
  lines.push(
    `| (chung) | ${o.count} | ${f(o.p50)} | ${f(o.p95)} | ${f(o.p99)} | — | ${o.errors} | ${pct(o.errorRate)} | ${o.business} | ${evaluation.okOverall ? "đạt" : "VƯỢT"} |`,
  );
  const codes = Object.entries(evaluation.overall.codes ?? {});
  if (codes.length)
    lines.push("", `Request không ok (trạng thái:mã): ${codes.map(([k, v]) => `${k} ×${v}`).join(", ")}`);
  if (!evaluation.okDropped)
    lines.push("", `Request bị bỏ vì máy tải đầy hàng chờ: ${evaluation.dropped} (không đạt).`);
  return lines.join("\n");
}

/** Gom mẫu theo nhóm đo + "overall" (mọi request, gồm setup). */
export function groupSamples(samples) {
  const by = { overall: summarize(samples) };
  for (const g of ["read", "write", "checkout", "setup"]) {
    by[g] = summarize(samples.filter((s) => groupOf(s.op) === g));
  }
  return by;
}

/** Danh sách SKU/biến thể: id tất định từ dataset.mjs (variant_LD<n:5><ci><si>). */
export const variantIdOf = (n, ci, si) => `variant_LD${String(n).padStart(5, "0")}${ci}${si}`;

/** Tồn khởi tạo của biến thể theo đúng công thức SQL của dataset.mjs (seq = n*10 + ci*5 + si). */
export function initialStock(n, ci, si) {
  const seq = n * 10 + ci * 5 + si;
  return seq % 20 === 0 ? 0 : 5 + ((seq * 7) % 56);
}

/** IPv4 giả cho khách thứ i (dải 100.64.0.0/10, không nằm trong XS_TRUSTED_PROXIES) — qua X-Forwarded-For. */
export function fakeIp(i) {
  const v = (i >>> 0) % (64 * 256 * 256);
  return `100.${64 + (v >> 16)}.${(v >> 8) & 255}.${v & 255}`;
}
