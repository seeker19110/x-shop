#!/usr/bin/env node
/**
 * Bộ đo PDP cho vòng tối ưu (T-127, LOOP-OPT; điểm nóng T-060: `/store/x/products/:handle`). Một lần chạy = gửi N request
 * PDP theo danh sách handle TẤT ĐỊNH (trộn nhóm 500 sản phẩm đầu và đuôi dài, như read mix của smoke) tới backend tải
 * đang chạy (`node scripts/load/serve.mjs start`), mỗi lúc tối đa C request. Đại lượng đo là thời gian tường của cả lần
 * chạy — `xt.py perf sample` bấm giờ từ ngoài, script này không tự báo số (không có số tự khai để sửa).
 * Kiểm tương đương tối thiểu: mọi phản hồi phải 200 và đúng `handle` đã hỏi; sai → exit 1 (perf sample không ghi mẫu lỗi).
 * Bộ đo KHOÁ trong task tối ưu (`perf guard --locked 'scripts/load/*'`).
 * CLI: node scripts/load/bench-pdp.mjs [--requests 40] [--concurrency 1]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASE_URL, LOAD, assertNotProduction } from "./env.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const SERVE_STATE = path.join(root, "node_modules/.cache/xshop-load/serve.json");
const REQUEST_TIMEOUT_MS = 10_000;

/** Tham số: số request (1–10 000) và số request song song (1–64). Sai → ném lỗi. */
export function parseArgs(argv) {
  const opts = { requests: 40, concurrency: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a !== "--requests" && a !== "--concurrency") throw new Error(`tham số lạ: ${a}`);
    const v = Number(argv[++i]);
    const max = a === "--requests" ? 10_000 : 64;
    if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${a} phải là số nguyên 1–${max}`);
    opts[a.slice(2)] = v;
  }
  return opts;
}

/**
 * Handle tất định: chẵn → nhóm "bán chạy" 1..min(500, products), lẻ → đuôi dài 1..products; bước nguyên tố để rải đều.
 * Cùng (n, products) → cùng danh sách ở mọi lần chạy và mọi commit (đầu vào đo cố định).
 */
export function pdpHandles(n, products) {
  if (!Number.isInteger(products) || products < 1) throw new Error(`products không hợp lệ: ${products}`);
  const hot = Math.min(500, products);
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = i % 2 === 0 ? 1 + ((i * 7919) % hot) : 1 + ((i * 104_729) % products);
    out.push(`sp-load-${String(k).padStart(5, "0")}`);
  }
  return out;
}

/** Phản hồi hợp lệ cho handle đã hỏi? Trả chuỗi lỗi hoặc null. */
export function checkResponse(handle, status, body) {
  if (status !== 200) return `${handle}: HTTP ${status}`;
  if (!body || typeof body !== "object" || body.handle !== handle)
    return `${handle}: thân phản hồi không đúng handle`;
  return null;
}

/** Publishable key: biến LOAD_PUBLISHABLE_KEY, không thì file trạng thái của serve.mjs. */
export function publishableKey(env = process.env, stateFile = SERVE_STATE) {
  if (env.LOAD_PUBLISHABLE_KEY) return env.LOAD_PUBLISHABLE_KEY;
  try {
    const key = JSON.parse(readFileSync(stateFile, "utf8")).publishableKey;
    if (key) return key;
  } catch {
    /* rơi xuống lỗi dưới */
  }
  throw new Error(
    `thiếu publishable key — chạy \`node scripts/load/serve.mjs start\` trước (đọc ${stateFile})`,
  );
}

async function fetchOne(handle, key) {
  const res = await fetch(`${BASE_URL}/store/x/products/${handle}`, {
    headers: { "x-publishable-api-key": key, "x-forwarded-for": "100.64.0.2" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = res.status === 200 ? await res.json() : await res.text();
  return checkResponse(handle, res.status, body);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  assertNotProduction(BASE_URL);
  const key = publishableKey();
  const queue = pdpHandles(opts.requests, LOAD.products);
  const errors = [];
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const handle = queue[next++];
      const err = await fetchOne(handle, key).catch((e) => `${handle}: ${e.message}`);
      if (err) errors.push(err);
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  if (errors.length) {
    console.error(`bench-pdp: ${errors.length}/${queue.length} lỗi — ${errors.slice(0, 3).join("; ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`bench-pdp: ${e.message}`);
      process.exit(2);
    },
  );
}
