/* global __ENV -- biến toàn cục do runtime k6 cung cấp */
/**
 * Kịch bản k6 ĐẦY ĐỦ theo đặc tả §10.3 (chạy trên staging/máy tải riêng — `pnpm load:smoke` là bản thu nhỏ bằng Node).
 *
 *   - Tải khởi điểm: 100 request đọc/s tới origin + 10 thao tác giỏ/checkout/s trong 30 phút (STEADY), rồi gấp đôi
 *     trong 2 phút (BURST). Open-model (arrival rate): độ trễ tăng không làm giảm tải.
 *   - Read mix cố định 60% listing (kèm facet) · 20% PDP · 20% search; write mix 60% sửa giỏ · 20% quote · 20% submit
 *     (Idempotency-Key riêng; 15% submit gửi lại cùng khoá để kiểm idempotency). Chia theo bộ đếm lần lặp → đúng tỷ lệ.
 *   - Ngưỡng (§10.1): p95 catalog/search ≤ 300 ms; ghi nội bộ ≤ 700 ms; checkout nội bộ ≤ 2 s; lỗi server < 0,5%.
 *     Burst: latency tối đa gấp đôi, lỗi vẫn < 0,5%. Pha `cold` (đầu bài) chỉ báo cáo.
 *   - Stress §10.3: CONTENTION lượt đặt đồng thời cho MỘT SKU còn 1 đơn vị (CONTENTION_VARIANT) → đúng 1 thành công.
 *
 * Chạy (k6 ≥ 1.0; đã kiểm với v2.3.0, AGPL-3.0 — chỉ là công cụ chạy bên ngoài, không đóng gói vào sản phẩm):
 *   k6 run -e BASE_URL=https://staging.example -e PUBLISHABLE_KEY=pk_… -e REGION_ID=reg_… scripts/load/k6/xshop-load.js
 * Biến: PRODUCTS (10000) · READ_RPS (100) · WRITE_OPS (10) · COLD (30s) · STEADY (30m) · BURST (2m) ·
 *       CONTENTION (50) · CONTENTION_VARIANT (rỗng = bỏ stress) · TRUST_XFF (1: gửi X-Forwarded-For giả).
 * Rate limit KHÔNG bị nới: origin tải phải đặt XS_TRUSTED_PROXIES tin nguồn của máy tải và máy tải gửi X-Forwarded-For
 * khác nhau mỗi khách (TRUST_XFF=1, mặc định). Mặc định của sản phẩm giữ nguyên. Dataset: scripts/load/dataset.mjs
 * (id biến thể tất định `variant_LD<n:5><màu><size>`, tồn công thức ở initialStock bên dưới — trùng lib.mjs).
 */
import http from "k6/http";
import exec from "k6/execution";
import { sleep } from "k6";
import { Counter, Rate } from "k6/metrics";

const E = (k, d) => (__ENV[k] !== undefined && __ENV[k] !== "" ? __ENV[k] : d);
const BASE_URL = E("BASE_URL", "http://127.0.0.1:9200");
const KEY = E("PUBLISHABLE_KEY", "");
const PRODUCTS = Number(E("PRODUCTS", "10000"));
const READ_RPS = Number(E("READ_RPS", "100"));
const WRITE_OPS = Number(E("WRITE_OPS", "10"));
const COLD = E("COLD", "30s");
const STEADY = E("STEADY", "30m");
const BURST = E("BURST", "2m");
const CONTENTION = Number(E("CONTENTION", "50"));
const CONTENTION_VARIANT = E("CONTENTION_VARIANT", "");
const TRUST_XFF = E("TRUST_XFF", "1") === "1";

const toSeconds = (s) => {
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) throw new Error(`Thời lượng không hợp lệ: ${s}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
};
const COLD_S = toSeconds(COLD);
const STEADY_S = toSeconds(STEADY);
const BURST_S = toSeconds(BURST);
const RAMP_S = 10;
// Mốc pha tính từ lúc bắt đầu bài (k6 không cho gắn thẻ theo stage của ramping-arrival-rate).
const T_STEADY = COLD_S;
const T_BURST = COLD_S + STEADY_S + RAMP_S;
const T_END_BURST = T_BURST + BURST_S;
const TOTAL_S = T_END_BURST + RAMP_S;

const serverErrors = new Rate("server_errors");
const contentionWins = new Counter("contention_wins");
const idempotencyViolations = new Counter("idempotency_violations");

const stages = (rate) => [
  { duration: COLD, target: rate },
  { duration: STEADY, target: rate },
  { duration: `${RAMP_S}s`, target: rate * 2 },
  { duration: BURST, target: rate * 2 },
  { duration: `${RAMP_S}s`, target: rate },
];

const arrival = (rate, exec_, vus) => ({
  executor: "ramping-arrival-rate",
  startRate: rate,
  timeUnit: "1s",
  preAllocatedVUs: vus,
  maxVUs: vus * 8,
  stages: stages(rate),
  exec: exec_,
});

const scenarios = {
  reads: arrival(READ_RPS, "reads", Math.max(20, Math.ceil(READ_RPS / 2))),
  writes: arrival(WRITE_OPS, "writes", Math.max(10, WRITE_OPS * 2)),
};
if (CONTENTION_VARIANT !== "") {
  scenarios.contention = {
    executor: "per-vu-iterations",
    vus: CONTENTION,
    iterations: 1,
    startTime: `${Math.floor(TOTAL_S) + 5}s`,
    maxDuration: "5m",
    exec: "contention",
  };
}

const thresholds = {
  "http_req_duration{group_name:read,phase:steady}": ["p(95)<300"],
  "http_req_duration{group_name:write,phase:steady}": ["p(95)<700"],
  "http_req_duration{group_name:checkout,phase:steady}": ["p(95)<2000"],
  "http_req_duration{group_name:read,phase:burst}": ["p(95)<600"],
  "http_req_duration{group_name:write,phase:burst}": ["p(95)<1400"],
  "http_req_duration{group_name:checkout,phase:burst}": ["p(95)<4000"],
  "server_errors{phase:steady}": ["rate<0.005"],
  "server_errors{phase:burst}": ["rate<0.005"],
  idempotency_violations: ["count==0"],
};
if (CONTENTION_VARIANT !== "") thresholds.contention_wins = ["count==1"];

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

/* ------------------------------------------------------------------ tiện ích */

const T0_KEY = "__t0";
export function setup() {
  if (KEY === "") throw new Error("Thiếu PUBLISHABLE_KEY (-e PUBLISHABLE_KEY=pk_…)");
  const headers = { "x-publishable-api-key": KEY, accept: "application/json" };
  const regionId =
    E("REGION_ID", "") || http.get(`${BASE_URL}/store/regions`, { headers }).json("regions.0.id");
  const provinces = http.get(`${BASE_URL}/store/x/addresses/provinces`, { headers }).json("provinces");
  const province = provinces[0].code;
  const ward = http
    .get(`${BASE_URL}/store/x/addresses/provinces/${province}/wards`, { headers })
    .json("wards.0.code");
  return { [T0_KEY]: Date.now(), regionId, province, ward };
}

const phaseOf = (data) => {
  const t = (Date.now() - data[T0_KEY]) / 1000;
  if (t < T_STEADY) return "cold";
  if (t < T_BURST) return "steady";
  if (t < T_END_BURST) return "burst";
  return "cooldown";
};

const GROUP = {
  listing: "read",
  pdp: "read",
  search: "read",
  cart: "write",
  quote: "write",
  submit: "checkout",
};

// Số ngẫu nhiên tất định theo (VU, lần lặp): cùng cấu hình → cùng nội dung request.
function rngFor(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

const fakeIp = (i) => {
  const v = (i >>> 0) % (64 * 256 * 256);
  return `100.${64 + (v >> 16)}.${(v >> 8) & 255}.${v & 255}`;
};

let ipSeq = 1;
function call(data, op, method, path, { body, ip, headers, allowBusiness = [] } = {}) {
  const phase = phaseOf(data);
  const res = http.request(method, `${BASE_URL}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers: {
      accept: "application/json",
      "x-publishable-api-key": KEY,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(TRUST_XFF ? { "x-forwarded-for": ip ?? fakeIp(exec.vu.idInTest * 100_003 + ipSeq++) } : {}),
      ...headers,
    },
    tags: { group_name: GROUP[op], op, phase },
    responseCallback: http.expectedStatuses({ min: 200, max: 399 }, ...allowBusiness),
  });
  // Lỗi server: mạng/timeout (status 0), 5xx, 429 (rate limit chặn tải = cấu hình môi trường sai), 4xx ngoài danh sách.
  const bad =
    res.status === 0 ||
    res.status >= 500 ||
    res.status === 429 ||
    (res.status >= 400 && !allowBusiness.includes(res.status));
  serverErrors.add(bad, { phase });
  return res;
}

/* ------------------------------------------------------------------ đọc */

const CATEGORIES = ["ao-nu", "quan-nu", "vay-dam", "ao-nam", "quan-nam", "giay", "nu", "nam"];
const COLORS = ["den", "trang", "be", "xam", "xanh-navy", "xanh-reu", "nau", "do", "hong"];
const SIZES = ["xs", "s", "m", "l", "xl", "38", "39", "40"];
const MATERIALS = ["len", "lua", "polyester", "voan", "denim", "da", "linen", "kaki", "cotton"];
const SORTS = ["newest", "price_asc", "price_desc"];
const SEARCHES = [
  "áo sơ mi",
  "ao so mi",
  "quần jeans",
  "dam xoe",
  "giày sneaker",
  "kaki",
  "lụa",
  "váy midi",
  "áo thun nam",
  "sandal",
  "denim",
  "zzzz không có",
];

function listingPath(rng) {
  const q = [`category=${CATEGORIES[randInt(rng, 0, CATEGORIES.length - 1)]}`];
  if (rng() < 0.5) q.push(`color=${COLORS[randInt(rng, 0, COLORS.length - 1)]}`);
  if (rng() < 0.4) q.push(`size=${SIZES[randInt(rng, 0, SIZES.length - 1)]}`);
  if (rng() < 0.2) q.push(`material=${MATERIALS[randInt(rng, 0, MATERIALS.length - 1)]}`);
  if (rng() < 0.2) {
    const lo = randInt(rng, 1, 3) * 100_000;
    q.push(`price_min=${lo}`, `price_max=${lo + 200_000}`);
  }
  if (rng() < 0.5) q.push(`sort=${SORTS[randInt(rng, 0, 2)]}`);
  if (rng() < 0.3) q.push(`page=${randInt(rng, 2, 5)}`);
  return `/store/x/products?${q.join("&")}`;
}

export function reads(data) {
  const i = exec.scenario.iterationInTest;
  const rng = rngFor(i * 2654435761 + 11);
  const slot = i % 5; // 0,1,2 = listing (60%) · 3 = PDP (20%) · 4 = search (20%)
  if (slot <= 2) return call(data, "listing", "GET", listingPath(rng));
  if (slot === 3) {
    const n = rng() < 0.5 ? randInt(rng, 1, Math.min(500, PRODUCTS)) : randInt(rng, 1, PRODUCTS);
    return call(data, "pdp", "GET", `/store/x/products/sp-load-${String(n).padStart(5, "0")}`);
  }
  const term =
    rng() < 0.8
      ? SEARCHES[randInt(rng, 0, SEARCHES.length - 1)]
      : `mẫu ${String(randInt(rng, 1, PRODUCTS)).padStart(5, "0")}`;
  return call(data, "search", "GET", `/store/x/search?q=${encodeURIComponent(term)}`);
}

/* ------------------------------------------------------------------ ghi */

const SHAPES = [
  [1, 5],
  [2, 3],
  [2, 2],
  [1, 5],
];
const variantIdOf = (n, ci, si) => `variant_LD${String(n).padStart(5, "0")}${ci}${si}`;
const initialStock = (n, ci, si) => {
  const seq = n * 10 + ci * 5 + si;
  return seq % 20 === 0 ? 0 : 5 + ((seq * 7) % 56);
};
function pickVariant(rng) {
  for (;;) {
    const n = randInt(rng, 1, PRODUCTS);
    const [nc, ns] = SHAPES[n % 4];
    const ci = randInt(rng, 0, nc - 1);
    const si = randInt(rng, 0, ns - 1);
    const id = variantIdOf(n, ci, si);
    if (initialStock(n, ci, si) > 0 && id !== CONTENTION_VARIANT) return id;
  }
}

// Mỗi VU giữ hồ giỏ riêng (module-level = theo VU).
const pool = { editable: [], quoted: [] };
let keySeq = 0;

const itemsOf = (res) => {
  const items = res.status === 200 ? res.json("cart.items") : null;
  return Array.isArray(items) ? items.map((x) => ({ id: x.id, quantity: x.quantity })) : null;
};

function addLine(data, rng, cart) {
  const res = call(data, "cart", "POST", `/store/carts/${cart.id}/line-items`, {
    body: { variant_id: pickVariant(rng), quantity: randInt(rng, 1, 2) },
    ip: cart.ip,
  });
  const items = itemsOf(res);
  if (items) cart.lines = items;
  return items !== null;
}

function newCart(data, rng) {
  const ip = fakeIp(exec.vu.idInTest * 100_003 + ipSeq++);
  const res = call(data, "cart", "POST", "/store/carts", { body: { region_id: data.regionId }, ip });
  const id = res.status === 200 ? res.json("cart.id") : null;
  if (!id) return null;
  const cart = { id, ip, lines: [] };
  return addLine(data, rng, cart) ? cart : null;
}

const addressOf = (data) => ({
  province_code: data.province,
  ward_code: data.ward,
  line: "12 Phố Điện Biên Phủ, tòa A, căn 305",
});

function quoteCart(data, cart) {
  const res = call(data, "quote", "POST", "/store/x/checkout/quote", {
    body: { cart_id: cart.id, payment_method: "cod", address: addressOf(data) },
    ip: cart.ip,
  });
  if (res.status !== 200) return false;
  cart.quote = { id: res.json("quote.id"), version: res.json("quote.cart_version") };
  return true;
}

function takeCart(data, rng, from) {
  if (from.length > 0) return from.splice(randInt(rng, 0, from.length - 1), 1)[0];
  return newCart(data, rng);
}

function submitOnce(data, rng, cart, allowBusiness = [409]) {
  keySeq += 1;
  // Idempotency-Key hợp lệ: 16–128 ký tự [A-Za-z0-9_-].
  const key = `k6-load-${exec.vu.idInTest}-${String(exec.scenario.iterationInTest).padStart(8, "0")}-${keySeq}`;
  const body = {
    cart_id: cart.id,
    cart_version: cart.quote.version,
    quote_id: cart.quote.id,
    payment_method: "cod",
    contact: { name: "Nguyễn Văn Tải", phone: `09${randInt(rng, 10_000_000, 99_999_999)}` },
    address: addressOf(data),
  };
  const res = call(data, "submit", "POST", "/store/x/checkout/submit", {
    body,
    ip: cart.ip,
    headers: { "idempotency-key": key },
    allowBusiness,
  });
  return { res, key, body };
}

export function writes(data) {
  const i = exec.scenario.iterationInTest;
  const rng = rngFor(i * 40503 + 7);
  const slot = i % 5; // 0,1,2 = sửa giỏ (60%) · 3 = quote (20%) · 4 = submit (20%)
  if (slot <= 2) {
    if (pool.editable.length > 0 && rng() < 0.6) {
      const cart = pool.editable[randInt(rng, 0, pool.editable.length - 1)];
      if (cart.lines.length < 4 && rng() < 0.4) addLine(data, rng, cart);
      else {
        const line = cart.lines[randInt(rng, 0, cart.lines.length - 1)];
        const res = call(data, "cart", "POST", `/store/carts/${cart.id}/line-items/${line.id}`, {
          body: { quantity: randInt(rng, 1, 3) },
          ip: cart.ip,
        });
        const items = itemsOf(res);
        if (items) cart.lines = items;
      }
      return;
    }
    const cart = newCart(data, rng);
    if (cart) {
      pool.editable.push(cart);
      if (pool.editable.length > 100) pool.editable.shift();
    }
    return;
  }
  if (slot === 3) {
    const cart = takeCart(data, rng, pool.editable);
    if (cart && quoteCart(data, cart)) {
      pool.quoted.push(cart);
      if (pool.quoted.length > 100) pool.quoted.shift();
    }
    return;
  }
  const cart = takeCart(data, rng, pool.quoted);
  if (!cart || (!cart.quote && !quoteCart(data, cart))) return;
  const first = submitOnce(data, rng, cart);
  // 15% gửi lại CÙNG khoá + CÙNG nội dung: phải trả đúng đơn cũ (không đơn thứ hai).
  if (first.res.status === 200 && rng() < 0.15) {
    const again = http.post(`${BASE_URL}/store/x/checkout/submit`, JSON.stringify(first.body), {
      headers: {
        "content-type": "application/json",
        "x-publishable-api-key": KEY,
        "idempotency-key": first.key,
        ...(TRUST_XFF ? { "x-forwarded-for": cart.ip } : {}),
      },
      tags: { group_name: "setup", op: "submit_replay", phase: phaseOf(data) },
    });
    if (again.status !== 200 || again.json("order.id") !== first.res.json("order.id"))
      idempotencyViolations.add(1);
  }
}

/* ------------------------------------------------------------------ stress: N lượt đặt đồng thời cho SKU còn 1 */

export function contention(data) {
  const rng = rngFor(exec.vu.idInTest * 7919 + 3);
  const ip = fakeIp(900_000 + exec.vu.idInTest);
  const created = http.post(`${BASE_URL}/store/carts`, JSON.stringify({ region_id: data.regionId }), {
    headers: { "content-type": "application/json", "x-publishable-api-key": KEY, "x-forwarded-for": ip },
  });
  const id = created.json("cart.id");
  http.post(
    `${BASE_URL}/store/carts/${id}/line-items`,
    JSON.stringify({ variant_id: CONTENTION_VARIANT, quantity: 1 }),
    {
      headers: { "content-type": "application/json", "x-publishable-api-key": KEY, "x-forwarded-for": ip },
    },
  );
  const cart = { id, ip, lines: [] };
  if (!quoteCart({ ...data, [T0_KEY]: Date.now() }, cart)) return;
  // Hàng rào thời gian: mọi VU submit cùng lúc sau 20 giây kể từ lúc iteration đầu tiên bắt đầu.
  const fireAt = Math.floor(exec.scenario.startTime / 1000 + 20) * 1000;
  const wait = fireAt - Date.now();
  if (wait > 0) sleep(wait / 1000);
  const { res } = submitOnce({ ...data, [T0_KEY]: Date.now() }, rng, cart, [409, 422]);
  if (res.status === 200) contentionWins.add(1);
}
