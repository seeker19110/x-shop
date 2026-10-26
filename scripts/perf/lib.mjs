// Hàm thuần dùng chung cho đo hiệu năng (đặc tả §10.1 lab, §10.2 ngân sách tài nguyên) — có test ở lib.test.mjs.
export const KiB = 1024;

/** Ngân sách tài nguyên tải đầu, mobile (§10.2). Không nới: đổi số ở đây = đổi đặc tả. */
export const BUDGET = { js: 200 * KiB, css: 50 * KiB, font: 100 * KiB, total: 900 * KiB };

/** Ngưỡng lab theo median (§10.1): LCP ≤ 2,5 giây, CLS ≤ 0,1. INP không suy từ lab (chỉ báo TBT để tham khảo). */
export const LAB_LIMITS = { lcpMs: 2500, cls: 0.1 };

/** Hồ sơ lab khởi điểm (§10.1): 390×844, CPU 4×, 1,6 Mbps xuống, 750 Kbps lên, RTT 150 ms. */
export const LAB_PROFILE = {
  viewport: { width: 390, height: 844 },
  cpuSlowdownMultiplier: 4,
  throughputKbps: 1600,
  uploadKbps: 750,
  rttMs: 150,
};

/** Phân loại phản hồi theo loại tài nguyên. */
export function kind(contentType, url) {
  const ct = contentType ?? "";
  if (/javascript/.test(ct) || /\.m?js(\?|$)/.test(url)) return "js";
  if (/css/.test(ct)) return "css";
  if (/font|woff2?/.test(ct) || /\.woff2?(\?|$)/.test(url)) return "font";
  if (/^image\//.test(ct)) return "image";
  if (/text\/x-component/.test(ct) || /_rsc=/.test(url)) return "rsc";
  if (/html/.test(ct)) return "html";
  return "other";
}

/** Danh sách loại vượt ngân sách (rỗng = đạt). Bằng đúng ngân sách là đạt. */
export function overBudget(sizes, budget = BUDGET) {
  const over = [];
  for (const k of ["js", "css", "font"]) if (sizes[k] > budget[k]) over.push(k);
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  if (total > budget.total) over.push("total");
  return over;
}

/** Median; mảng rỗng → null (không phải 0: "không có mẫu" khác "đo được 0"). */
export function median(xs) {
  return percentile(xs, 50);
}

/** Phân vị nearest-rank (p75 của 5 mẫu = mẫu thứ 4); median số mẫu chẵn = trung bình hai mẫu giữa. Rỗng → null. */
export function percentile(xs, p) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (p === 50 && v.length % 2 === 0) return (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const rank = Math.max(1, Math.ceil((p / 100) * v.length));
  return v[rank - 1];
}

/** Tóm tắt các lần chạy lab của một trang; thiếu mẫu (không có LCP hợp lệ) → ghi rõ, không coi là đạt. */
export function summarizeLab(runs, limits = LAB_LIMITS) {
  const lcp = runs.map((r) => r.lcpMs);
  const cls = runs.map((r) => r.cls);
  const s = {
    runs: runs.length,
    lcpMedianMs: median(lcp),
    lcpP75Ms: percentile(lcp, 75),
    clsMedian: median(cls),
    clsP75: percentile(cls, 75),
    tbtMedianMs: median(runs.map((r) => r.tbtMs)),
    over: [],
  };
  if (s.lcpMedianMs === null || s.clsMedian === null) s.over.push("thiếu mẫu");
  else {
    if (s.lcpMedianMs > limits.lcpMs) s.over.push("lcp");
    if (s.clsMedian > limits.cls) s.over.push("cls");
  }
  return s;
}

export const fmtKiB = (n) => `${(n / KiB).toFixed(1)} KiB`;
