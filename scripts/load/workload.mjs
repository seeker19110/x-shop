/**
 * Kịch bản tải mở (open-loop) cho smoke — bản thu nhỏ của §10.3, cùng read/write mix với `k6/xshop-load.js`.
 * Request đến theo tốc độ cố định (không chờ request trước), nên độ trễ tăng không làm giảm tải (tránh "coordinated
 * omission"). Mỗi "khách" ảo có IP giả riêng qua X-Forwarded-For (backend phải đặt XS_TRUSTED_PROXIES cho socket tải).
 */
import { SHAPES } from "./dataset.mjs";
import {
  classify,
  createDeck,
  fakeIp,
  initialStock,
  mulberry32,
  randInt,
  READ_MIX,
  variantIdOf,
  WRITE_MIX,
} from "./lib.mjs";

const REQUEST_TIMEOUT_MS = 10_000;
/** Số request tối đa đang bay; vượt → bỏ request và tính là lỗi của phép đo (máy tải/server không theo kịp). */
const MAX_IN_FLIGHT = 400;

export const CATEGORIES = ["ao-nu", "quan-nu", "vay-dam", "ao-nam", "quan-nam", "giay", "nu", "nam"];
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

export function createContext({
  base,
  key,
  regionId,
  products,
  province,
  ward,
  seed = 20_260_101,
  excluded = [],
}) {
  return {
    excluded: new Set(excluded),
    base,
    key,
    regionId,
    products,
    province,
    ward,
    rng: mulberry32(seed),
    nextRead: createDeck(mulberry32(seed + 1), READ_MIX),
    nextWrite: createDeck(mulberry32(seed + 2), WRITE_MIX),
    ipSeq: 1,
    keySeq: 0,
    runId: Date.now().toString(36),
    pool: { editable: [], quoted: [] },
    submits: [],
    violations: [],
  };
}

async function call(ctx, phase, op, method, path, { body, ip, headers, allowBusiness } = {}) {
  const started = performance.now();
  let status = 0;
  let json = null;
  try {
    const res = await fetch(`${ctx.base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "x-publishable-api-key": ctx.key,
        "x-forwarded-for": ip ?? fakeIp(ctx.ipSeq++),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  } catch {
    status = 0;
  }
  const ms = performance.now() - started;
  const outcome = classify(op, status, { allowBusiness });
  phase.samples.push({
    op,
    status,
    ms,
    outcome,
    code: json?.code ? `${json.code}${json.field ? `@${json.field}` : ""}` : undefined,
  });
  return { status, json, outcome };
}

/* ------------------------------------------------------------------ đọc (60% listing · 20% PDP · 20% search) */

function listingPath(ctx) {
  const { rng } = ctx;
  const q = new URLSearchParams();
  q.set("category", CATEGORIES[randInt(rng, 0, CATEGORIES.length - 1)]);
  if (rng() < 0.5) q.set("color", COLORS[randInt(rng, 0, COLORS.length - 1)]);
  if (rng() < 0.4) q.set("size", SIZES[randInt(rng, 0, SIZES.length - 1)]);
  if (rng() < 0.2) q.set("material", MATERIALS[randInt(rng, 0, MATERIALS.length - 1)]);
  if (rng() < 0.2) {
    const lo = randInt(rng, 1, 3) * 100_000;
    q.set("price_min", String(lo));
    q.set("price_max", String(lo + 200_000));
  }
  if (rng() < 0.5) q.set("sort", SORTS[randInt(rng, 0, 2)]);
  if (rng() < 0.3) q.set("page", String(randInt(rng, 2, 5)));
  return `/store/x/products?${q}`;
}

/** PDP: 50% từ nhóm "bán chạy" (500 sản phẩm đầu — cache ấm), 50% đuôi dài đều (cache nguội). */
function pdpPath(ctx) {
  const n =
    ctx.rng() < 0.5 ? randInt(ctx.rng, 1, Math.min(500, ctx.products)) : randInt(ctx.rng, 1, ctx.products);
  return `/store/x/products/sp-load-${String(n).padStart(5, "0")}`;
}

function searchPath(ctx) {
  const { rng } = ctx;
  const term =
    rng() < 0.8
      ? SEARCHES[randInt(rng, 0, SEARCHES.length - 1)]
      : `mẫu ${String(randInt(rng, 1, ctx.products)).padStart(5, "0")}`;
  return `/store/x/search?q=${encodeURIComponent(term)}`;
}

async function readOp(ctx, phase) {
  const op = ctx.nextRead();
  const path = op === "listing" ? listingPath(ctx) : op === "pdp" ? pdpPath(ctx) : searchPath(ctx);
  await call(ctx, phase, op, "GET", path);
}

/* ------------------------------------------------------------------ ghi (60% sửa giỏ · 20% quote · 20% submit) */

/** Biến thể còn tồn (theo công thức tồn khởi tạo của dataset) để request hợp lệ không bị từ chối vì hết hàng. */
function pickVariant(ctx) {
  for (;;) {
    const n = randInt(ctx.rng, 1, ctx.products);
    const shape = SHAPES[n % 4];
    const ci = randInt(ctx.rng, 0, shape.colors - 1);
    const si = randInt(ctx.rng, 0, shape.sizes - 1);
    const id = variantIdOf(n, ci, si);
    if (initialStock(n, ci, si) > 0 && !ctx.excluded.has(id)) return id;
  }
}

/** Tạo giỏ + thêm dòng đầu. `prefix` = "" (thao tác chính) hoặc "setup_" (chuẩn bị cho quote/submit, không tính mix). */
async function newCart(ctx, phase, prefix = "") {
  const ip = fakeIp(ctx.ipSeq++);
  const created = await call(ctx, phase, `${prefix}cart_create`, "POST", "/store/carts", {
    body: { region_id: ctx.regionId },
    ip,
  });
  const id = created.json?.cart?.id;
  if (!id) return null;
  const cart = { id, ip, lines: [] };
  return (await addLine(ctx, phase, cart, prefix)) ? cart : null;
}

async function addLine(ctx, phase, cart, prefix = "") {
  const r = await call(ctx, phase, `${prefix}cart_add`, "POST", `/store/carts/${cart.id}/line-items`, {
    body: { variant_id: pickVariant(ctx), quantity: randInt(ctx.rng, 1, 2) },
    ip: cart.ip,
  });
  const items = r.json?.cart?.items;
  if (!Array.isArray(items)) return false;
  cart.lines = items.map((i) => ({ id: i.id, quantity: i.quantity }));
  return true;
}

async function cartEditOp(ctx, phase) {
  const { editable } = ctx.pool;
  // 60%: sửa giỏ đã có (đổi số lượng / thêm dòng); còn lại (hoặc chưa có giỏ): giỏ mới.
  if (editable.length > 0 && ctx.rng() < 0.6) {
    const cart = editable[randInt(ctx.rng, 0, editable.length - 1)];
    if (cart.busy) return;
    cart.busy = true;
    try {
      if (cart.lines.length < 4 && ctx.rng() < 0.4) {
        await addLine(ctx, phase, cart);
      } else {
        const line = cart.lines[randInt(ctx.rng, 0, cart.lines.length - 1)];
        const r = await call(
          ctx,
          phase,
          "cart_update",
          "POST",
          `/store/carts/${cart.id}/line-items/${line.id}`,
          {
            body: { quantity: randInt(ctx.rng, 1, 3) },
            ip: cart.ip,
          },
        );
        const items = r.json?.cart?.items;
        if (Array.isArray(items)) cart.lines = items.map((i) => ({ id: i.id, quantity: i.quantity }));
      }
    } finally {
      cart.busy = false;
    }
    return;
  }
  const cart = await newCart(ctx, phase);
  if (cart) {
    editable.push(cart);
    if (editable.length > 200) editable.shift();
  }
}

const addressOf = (ctx) => ({
  province_code: ctx.province,
  ward_code: ctx.ward,
  line: "12 Phố Điện Biên Phủ, tòa A, căn 305",
});

async function quoteCart(ctx, phase, cart, op = "quote") {
  const r = await call(ctx, phase, op, "POST", "/store/x/checkout/quote", {
    body: { cart_id: cart.id, payment_method: "cod", address: addressOf(ctx) },
    ip: cart.ip,
  });
  const quote = r.json?.quote;
  if (!quote?.id) return false;
  cart.quote = { id: quote.id, version: quote.cart_version };
  return true;
}

/** Lấy giỏ từ hồ sơ `from` (rút ra khỏi hồ để không hai thao tác dùng chung); không có thì tạo giỏ mới (setup). */
async function takeCart(ctx, phase, from) {
  const idle = from.filter((c) => !c.busy);
  if (idle.length > 0) {
    const cart = idle[randInt(ctx.rng, 0, idle.length - 1)];
    from.splice(from.indexOf(cart), 1);
    return cart;
  }
  return newCart(ctx, phase, "setup_");
}

async function quoteOp(ctx, phase) {
  const cart = await takeCart(ctx, phase, ctx.pool.editable);
  if (!cart) return;
  if (await quoteCart(ctx, phase, cart)) {
    ctx.pool.quoted.push(cart);
    if (ctx.pool.quoted.length > 200) ctx.pool.quoted.shift();
  }
}

export function submitBody(ctx, cart) {
  return {
    cart_id: cart.id,
    cart_version: cart.quote.version,
    quote_id: cart.quote.id,
    payment_method: "cod",
    contact: { name: "Nguyễn Văn Tải", phone: `09${String(randInt(ctx.rng, 10_000_000, 99_999_999))}` },
    address: addressOf(ctx),
  };
}

export async function submitOnce(ctx, phase, cart, op = "submit") {
  // Idempotency-Key hợp lệ: 16–128 ký tự [A-Za-z0-9_-].
  const key = `lt-${ctx.runId}-${String(++ctx.keySeq).padStart(8, "0")}`;
  const body = submitBody(ctx, cart);
  const r = await call(ctx, phase, op, "POST", "/store/x/checkout/submit", {
    body,
    ip: cart.ip,
    headers: { "idempotency-key": key },
    allowBusiness: [409],
  });
  const orderId = r.json?.order?.id ?? null;
  ctx.submits.push({
    key,
    cartId: cart.id,
    status: r.status,
    orderId,
    attemptId: r.json?.checkout_attempt_id ?? null,
  });
  return { key, body, cart, ...r, orderId };
}

async function submitOp(ctx, phase) {
  const cart = await takeCart(ctx, phase, ctx.pool.quoted);
  if (!cart) return;
  if (!cart.quote && !(await quoteCart(ctx, phase, cart, "setup_quote"))) return;
  const first = await submitOnce(ctx, phase, cart);
  // 15% gửi lại CÙNG khoá + CÙNG nội dung (retry mạng): phải trả đúng đơn cũ, không tạo đơn thứ hai (idempotency).
  if (first.status === 200 && ctx.rng() < 0.15) {
    const again = await call(ctx, phase, "submit_replay", "POST", "/store/x/checkout/submit", {
      body: first.body,
      ip: cart.ip,
      headers: { "idempotency-key": first.key },
    });
    if (again.status !== 200 || again.json?.order?.id !== first.orderId) {
      ctx.violations.push(
        `replay khoá ${first.key}: status ${again.status}, đơn ${again.json?.order?.id ?? "?"} ≠ ${first.orderId}`,
      );
    }
  }
}

async function writeOp(ctx, phase) {
  const op = ctx.nextWrite();
  if (op === "cart_edit") return cartEditOp(ctx, phase);
  if (op === "quote") return quoteOp(ctx, phase);
  return submitOp(ctx, phase);
}

/* ------------------------------------------------------------------ chạy một pha */

/**
 * Chạy pha `seconds` giây với `readRps` request đọc/giây và `writeRps` thao tác ghi/giây (mở, lịch cố định). Chờ các
 * request còn bay (tối đa 20 giây) rồi trả { name, samples, dropped, seconds, issued }.
 */
export async function runPhase(ctx, { name, seconds, readRps, writeRps }) {
  const phase = { name, seconds, samples: [], dropped: 0, issued: { read: 0, write: 0 } };
  const pending = new Set();
  const launch = (kind, fn) => {
    if (pending.size >= MAX_IN_FLIGHT) {
      phase.dropped++;
      return;
    }
    phase.issued[kind]++;
    const p = fn(ctx, phase)
      .catch((e) => {
        // Lỗi lập trình/mạng ngoài call(): ghi là lỗi để cổng đỏ thay vì nuốt.
        phase.samples.push({
          op: "harness",
          status: 0,
          ms: 0,
          outcome: "error",
          note: String(e?.message ?? e),
        });
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  const t0 = performance.now();
  let issuedRead = 0;
  let issuedWrite = 0;
  await new Promise((resolve) => {
    const tick = setInterval(() => {
      const elapsed = (performance.now() - t0) / 1000;
      if (elapsed >= seconds) {
        clearInterval(tick);
        resolve();
        return;
      }
      while (issuedRead < Math.floor(readRps * elapsed)) {
        issuedRead++;
        launch("read", readOp);
      }
      while (issuedWrite < Math.floor(writeRps * elapsed)) {
        issuedWrite++;
        launch("write", writeOp);
      }
    }, 5);
  });
  const drain = Promise.allSettled([...pending]);
  await Promise.race([drain, new Promise((r) => setTimeout(r, 20_000))]);
  return phase;
}

/**
 * Stress §10.3: `concurrency` lượt đặt đồng thời cho MỘT biến thể chỉ còn 1 đơn vị. Chuẩn bị (giỏ + báo giá) tuần tự
 * theo lô nhỏ, rồi bắn submit cùng lúc. Trả mã trạng thái từng lượt.
 */
export async function runContention(ctx, { variantId, concurrency = 50 }) {
  const phase = { name: "contention", seconds: 0, samples: [], dropped: 0, issued: { read: 0, write: 0 } };
  const carts = [];
  const prepare = async () => {
    const ip = fakeIp(ctx.ipSeq++);
    const created = await call(ctx, phase, "setup_cart_create", "POST", "/store/carts", {
      body: { region_id: ctx.regionId },
      ip,
    });
    const id = created.json?.cart?.id;
    if (!id) return;
    const cart = { id, ip, lines: [] };
    const add = await call(ctx, phase, "setup_cart_add", "POST", `/store/carts/${id}/line-items`, {
      body: { variant_id: variantId, quantity: 1 },
      ip,
    });
    if (add.status !== 200) return;
    if (await quoteCart(ctx, phase, cart, "setup_quote")) carts.push(cart);
  };
  for (let i = 0; i < concurrency; i += 10) {
    await Promise.all(Array.from({ length: Math.min(10, concurrency - i) }, prepare));
  }
  const results = await Promise.all(carts.map((cart) => submitOnce(ctx, phase, cart, "contention_submit")));
  return {
    prepared: carts.length,
    statuses: results.map((r) => r.status),
    orderIds: results.filter((r) => r.status === 200).map((r) => r.orderId),
    samples: phase.samples,
  };
}
