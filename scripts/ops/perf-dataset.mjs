/**
 * Dựng DB đo đạc (T-074): catalog 10.000 sản phẩm / 50.000 SKU (bộ sinh của tải `scripts/load/dataset.mjs`) + lịch sử
 * đơn tổng hợp (mặc định 200.000 đơn) cho `explain-hot-paths.mjs`, và đo thời gian `catalog:reindex` ở 50k SKU.
 *
 *   node scripts/ops/perf-dataset.mjs                 # DB mới: migrate → seed → catalog SQL → đo reindex → lịch sử đơn
 *   node scripts/ops/perf-dataset.mjs --reindex-only  # chỉ đo lại reindex trên DB đã dựng
 *   node scripts/ops/perf-dataset.mjs --orders-only   # chỉ sinh lịch sử đơn trên DB đã có catalog
 *   node scripts/ops/perf-dataset.mjs --drop          # xoá DB đo đạc + dọn Redis DB index đo đạc
 *
 * Biến: PERF_DB_NAME (mặc định xshop_perf; bắt buộc khớp ^xshop_perf[a-z0-9_]*$ — chặn drop nhầm DB khác) ·
 * PERF_PG_BASE_URL (postgres://xshop:xshop@localhost:5432) · PERF_REDIS_DB (14; không cho 0/7/13/15 của dev/E2E/tải/
 * diễn tập, và từ chối nếu DB index không rỗng lúc bắt đầu) · PERF_PRODUCTS (10000) · PERF_ORDERS (200000) ·
 * PERF_REINDEX_RUNS (2). Chỉ dành cho DB dùng riêng — dữ liệu hoàn toàn tổng hợp, không dữ liệu thật.
 *
 * Lịch sử đơn sinh bằng SQL hàng loạt (generate_series), TẤT ĐỊNH theo số thứ tự i, trừ "đuôi gần đây" (0,1% đơn mới
 * nhất: chờ thanh toán / chờ xác nhận COD / attempt đang chuẩn bị / outbox chưa gửi) có mốc tương đối với now() để các
 * job định kỳ thấy việc đến hạn như production.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectedSkuCount, generateDataset } from "../load/dataset.mjs";
import { backendEnv } from "../load/env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const backendDir = path.join(root, "apps/backend");
const fromRoot = createRequire(path.join(root, "package.json"));
const fromBackend = createRequire(path.join(backendDir, "package.json"));
const log = (m) => console.log(`[perf] ${m}`);

export const PERF = {
  dbName: process.env.PERF_DB_NAME ?? "xshop_perf",
  pgBase: process.env.PERF_PG_BASE_URL ?? "postgres://xshop:xshop@localhost:5432",
  redisDb: Number(process.env.PERF_REDIS_DB ?? 14),
  products: Number(process.env.PERF_PRODUCTS ?? 10_000),
  orders: Number(process.env.PERF_ORDERS ?? 200_000),
  reindexRuns: Number(process.env.PERF_REINDEX_RUNS ?? 2),
};

/** Chặn dùng nhầm DB/Redis của việc khác. */
export function assertSafePerfTargets(p = PERF) {
  if (!/^xshop_perf[a-z0-9_]*$/.test(p.dbName))
    throw new Error(`PERF_DB_NAME phải khớp ^xshop_perf[a-z0-9_]*$ (nhận "${p.dbName}")`);
  if (!Number.isInteger(p.redisDb) || p.redisDb < 1 || p.redisDb > 15 || [7, 13, 15].includes(p.redisDb))
    throw new Error(
      `PERF_REDIS_DB không hợp lệ (${p.redisDb}): dùng 1–15, trừ 7 (E2E), 13 (tải), 15 (diễn tập)`,
    );
  if (!Number.isInteger(p.products) || p.products < 1 || p.products > 99_999)
    throw new Error(`PERF_PRODUCTS không hợp lệ: ${p.products}`);
  if (!Number.isInteger(p.orders) || p.orders < 1_000 || p.orders > 9_999_999)
    throw new Error(`PERF_ORDERS không hợp lệ: ${p.orders} (1.000–9.999.999)`);
  if (!Number.isInteger(p.reindexRuns) || p.reindexRuns < 1 || p.reindexRuns > 10)
    throw new Error(`PERF_REINDEX_RUNS không hợp lệ: ${p.reindexRuns}`);
}

export const perfUrls = (p = PERF) => ({
  admin: `${p.pgBase}/postgres`,
  db: `${p.pgBase}/${p.dbName}`,
  redis: `redis://localhost:6379/${p.redisDb}`,
});

/** Số đơn "đuôi gần đây" (chưa xong) — 0,1% đơn mới nhất, tối thiểu 20. */
export const recentTail = (n) => Math.max(20, Math.floor(n / 1000));

/**
 * Câu SQL sinh lịch sử đơn tổng hợp cho N đơn (chạy tuần tự trong một giao dịch). Mốc thời gian: đơn i tạo lúc
 * 2024-11-01 UTC + i × (730 ngày / N) — 2 năm bán hàng. Tỷ lệ: nửa COD, nửa VNPAY; 2% hủy; 10% có thêm attempt lỗi;
 * VNPAY 5% có thêm lượt thanh toán lỗi; 1% có ngoại lệ vận hành (đã xử lý); ~3 sự kiện outbox mỗi đơn.
 */
export function orderHistoryStatements(n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`số đơn không hợp lệ: ${n}`);
  const tail = recentTail(n);
  const series = `SELECT i, lpad(i::text, 7, '0') AS p,
            timestamptz '2024-11-01 00:00:00+00' + (i * (730.0 / ${n})) * interval '1 day' AS t,
            (i > ${n - tail}) AS recent, (i % 2 = 0) AS vnpay, (i % 50 = 0 AND i <= ${n - tail}) AS cancelled,
            99000 + (i % 400) * 1000 AS total
       FROM generate_series(1, ${n}) AS i`;
  return [
    `CREATE TEMP TABLE pf_orders ON COMMIT DROP AS ${series}`,
    `INSERT INTO order_finance (id, order_id, display_ref, checkout_attempt_id, cart_id, state, total, payment_method,
                                hold_expires_at, cod_confirm_by, policy_version, quote, address, contact, created_at,
                                updated_at)
     SELECT 'ofin_PF' || p, 'order_PF' || p, 'XS-P' || p, 'chk_PF' || p, 'cart_PF' || p,
            CASE WHEN recent THEN CASE WHEN vnpay THEN 'awaiting_payment' ELSE 'placed' END
                 WHEN cancelled THEN 'cancelled'
                 WHEN i > ${n - 5 * tail} THEN 'confirmed' ELSE 'completed' END,
            total, CASE WHEN vnpay THEN 'vnpay' ELSE 'cod' END,
            CASE WHEN recent AND vnpay THEN now() + ((i % 30) - 3) * interval '1 minute' END,
            CASE WHEN recent AND NOT vnpay THEN now() + ((i % 48) - 4) * interval '1 hour' END,
            'returns-v1', jsonb_build_object('total', total, 'shipping', 30000),
            jsonb_build_object('province', 'Hồ Chí Minh', 'district', 'Quận ' || (i % 12 + 1), 'line1', 'Số ' || i),
            jsonb_build_object('name', 'Khách ' || i, 'phone', '09' || lpad((i % 100000000)::text, 8, '0')),
            t, t
       FROM pf_orders`,
    // Attempt thành công của mỗi đơn + 10% attempt lỗi trước đó + attempt đang chuẩn bị ở đuôi (1/7 quá lease).
    `INSERT INTO checkout_attempt (id, cart_id, cart_version, idempotency_scope, idempotency_key, payload_hash, quote_id,
                                   state, order_id, payment_method, hold_expires_at, error_code, lease_until,
                                   created_at, updated_at)
     SELECT 'chk_PF' || p, 'cart_PF' || p, 1, 'checkout', 'idk_PF' || p, 'h' || p, 'cq_PF' || p, 'ready',
            'order_PF' || p, CASE WHEN vnpay THEN 'vnpay' ELSE 'cod' END, NULL::timestamptz, NULL::text,
            t + interval '30 seconds', t, t
       FROM pf_orders
     UNION ALL
     SELECT 'chk_PFF' || p, 'cart_PF' || p, 1, 'checkout', 'idk_PFF' || p, 'h' || p, 'cq_PF' || p, 'failed', NULL,
            CASE WHEN vnpay THEN 'vnpay' ELSE 'cod' END, NULL, 'OUT_OF_STOCK', t - interval '2 minutes',
            t - interval '3 minutes', t - interval '3 minutes'
       FROM pf_orders WHERE i % 10 = 0
     UNION ALL
     SELECT 'chk_PFX' || p, 'cart_PFX' || p, 1, 'checkout', 'idk_PFX' || p, 'h' || p, 'cq_PFX' || p, 'preparing',
            NULL, 'cod', NULL, NULL, now() + CASE WHEN i % 14 = 0 THEN interval '-5 minutes' ELSE interval '1 minute' END,
            now(), now()
       FROM pf_orders WHERE recent AND i % 7 = 0`,
    `INSERT INTO cart_version (id, cart_id, version, fingerprint, frozen_by_attempt, created_at, updated_at)
     SELECT 'cv_PF' || p, 'cart_PF' || p, 1, 'f' || p, 'chk_PF' || p, t, t FROM pf_orders`,
    `INSERT INTO payment_attempt (id, order_id, provider, txn_ref, amount, state, expires_at, provider_txn_no,
                                  created_at, updated_at)
     SELECT 'payatt_PF' || p, 'order_PF' || p, 'vnpay', 'T' || p, total,
            CASE WHEN recent THEN 'pending' WHEN cancelled THEN 'failed' ELSE 'captured' END,
            t + interval '15 minutes', CASE WHEN recent OR cancelled THEN NULL ELSE 'V' || p END, t, t
       FROM pf_orders WHERE vnpay
     UNION ALL
     SELECT 'payatt_PFF' || p, 'order_PF' || p, 'vnpay', 'TF' || p, total, 'failed', t + interval '5 minutes', NULL,
            t - interval '1 minute', t - interval '1 minute'
       FROM pf_orders WHERE vnpay AND i % 20 = 0`,
    `INSERT INTO payment_ledger (id, order_id, kind, amount, provider, provider_txn_id, refund_id, state, created_at,
                                 updated_at)
     SELECT 'pled_PF' || p, 'order_PF' || p, 'capture', total, 'vnpay', 'V' || p, NULL, 'succeeded', t, t
       FROM pf_orders WHERE vnpay AND NOT recent AND NOT cancelled
     UNION ALL
     SELECT 'pled_PFR' || p, 'order_PF' || p, 'refund', 50000, 'vnpay', 'R' || p, 'ret_PF' || p, 'succeeded',
            t + interval '7 days', t + interval '7 days'
       FROM pf_orders WHERE vnpay AND NOT recent AND NOT cancelled AND i % 100 = 0`,
    `INSERT INTO webhook_inbox (id, provider, event_key, source, payload, payload_hash, verified, result, processed_at,
                                created_at, updated_at)
     SELECT 'whin_PF' || p, 'vnpay', 'V' || p, 'ipn', jsonb_build_object('vnp_TxnRef', 'T' || p), 'h' || p, true,
            '{"ok": true}'::jsonb, t, t, t
       FROM pf_orders WHERE vnpay AND NOT recent AND NOT cancelled`,
    // Outbox: placed + (confirmed | cancelled) + giao xong; đuôi: chưa gửi (pending đến hạn / failed hẹn sau / dead).
    `INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, attempts, next_attempt_at, created_at,
                               updated_at)
     SELECT 'obx_PF' || e.k || p, e.type || ':order_PF' || p, 'order_PF' || p, e.type,
            jsonb_build_object('order_id', 'order_PF' || p),
            CASE WHEN NOT recent THEN 'sent' WHEN i % 5 = 0 THEN 'failed' WHEN i % 97 = 0 THEN 'dead' ELSE 'pending' END,
            CASE WHEN recent AND i % 5 = 0 THEN 2 ELSE 0 END,
            CASE WHEN NOT recent THEN t + e.off WHEN i % 5 = 0 THEN now() + interval '2 minutes'
                 ELSE now() - interval '5 seconds' END,
            t + e.off, t + e.off
       FROM pf_orders
       JOIN LATERAL (VALUES ('P', 'order.placed', interval '0'),
                            (CASE WHEN cancelled THEN 'C' ELSE 'K' END,
                             CASE WHEN cancelled THEN 'order.cancelled' ELSE 'order.confirmed' END, interval '10 minutes'),
                            ('D', 'shipment.delivered', interval '3 days')) AS e(k, type, off)
         ON e.k = 'P' OR NOT recent
      WHERE NOT (e.k = 'D' AND cancelled)`,
    `INSERT INTO ops_exception (id, kind, dedupe_key, order_id, amount, state, owner, priority, due_at, detail,
                                created_at, updated_at)
     SELECT 'opx_PF' || p, CASE WHEN vnpay THEN 'payment_unknown' ELSE 'cod_confirm_overdue' END, 'pf:' || p,
            'order_PF' || p, total, CASE WHEN recent THEN 'open' ELSE 'resolved' END, 'ops', 'normal',
            t + interval '1 day', '{}'::jsonb, t, t
       FROM pf_orders WHERE i % 100 = 0 OR (recent AND i % 10 = 0)`,
    `INSERT INTO shipment (id, order_id, client_order_code, provider, provider_order_code, state, cod_amount,
                           shipping_fee, payer, created_by, settlement_state, delivered_at, created_at, updated_at)
     SELECT 'shp_PF' || p, 'order_PF' || p, 'XS-P' || p || '-1', 'ghn', 'G' || p,
            CASE WHEN i > ${n - 5 * tail} THEN 'shipped' ELSE 'delivered' END,
            CASE WHEN vnpay THEN 0 ELSE total END, 30000, 'recipient', 'user_ops',
            CASE WHEN i > ${n - 5 * tail} THEN 'unsettled' ELSE 'settled' END,
            CASE WHEN i > ${n - 5 * tail} THEN NULL ELSE t + interval '3 days' END, t + interval '1 day',
            t + interval '1 day'
       FROM pf_orders WHERE NOT recent AND NOT cancelled`,
  ];
}

const LARGE_TABLE_COUNTS = `SELECT
  (SELECT count(*)::int FROM order_finance) AS order_finance,
  (SELECT count(*)::int FROM checkout_attempt) AS checkout_attempt,
  (SELECT count(*)::int FROM payment_attempt) AS payment_attempt,
  (SELECT count(*)::int FROM payment_ledger) AS payment_ledger,
  (SELECT count(*)::int FROM outbox_event) AS outbox_event,
  (SELECT count(*)::int FROM ops_exception) AS ops_exception,
  (SELECT count(*)::int FROM webhook_inbox) AS webhook_inbox,
  (SELECT count(*)::int FROM shipment) AS shipment,
  (SELECT count(*)::int FROM catalog_variant_index) AS catalog_variant_index`;

/** Chạy lệnh, chờ xong; trả { ms, output } (stdout+stderr gộp, đồng thời in ra console). Mã ≠ 0 → ném lỗi. */
function run(cmd, args, { cwd = root, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const sink = (stream) => (chunk) => {
      output += chunk;
      stream.write(chunk);
    };
    child.stdout.on("data", sink(process.stdout));
    child.stderr.on("data", sink(process.stderr));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (code === 0) resolve({ ms, output });
      else reject(new Error(`${cmd} ${args.join(" ")} thoát mã ${code ?? signal}`));
    });
  });
}

async function connect(url) {
  const { Client } = fromRoot("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function withRedis(url, fn) {
  const { default: Redis } = fromBackend("ioredis");
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

async function resetDatabase(urls) {
  const admin = await connect(urls.admin);
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [PERF.dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${PERF.dbName}"`);
    await admin.query(`CREATE DATABASE "${PERF.dbName}"`);
  } finally {
    await admin.end();
  }
}

/** Môi trường backend cho medusa exec: như môi trường tải nhưng trỏ DB/Redis đo đạc. */
function perfBackendEnv(urls) {
  return { ...backendEnv(), DATABASE_URL: urls.db, REDIS_URL: urls.redis };
}

/** Đo `catalog:reindex` (lệnh một dòng của vận hành) + `index-dataset.ts` (cùng hàm, in thời gian bên trong). */
async function measureReindex(urls) {
  const env = perfBackendEnv(urls);
  const runs = [];
  for (let k = 1; k <= PERF.reindexRuns; k++) {
    log(`catalog:reindex lần ${k}/${PERF.reindexRuns}…`);
    const loadBefore = os.loadavg()[0];
    const r = await run("pnpm", ["--filter", "@x-shop/backend", "catalog:reindex"], { env });
    const m = r.output.match(/Rebuild: (\d+) sản phẩm, (\d+) dòng/);
    runs.push({
      command: "pnpm --filter @x-shop/backend catalog:reindex",
      wall_ms: Math.round(r.ms),
      products: m ? Number(m[1]) : null,
      rows: m ? Number(m[2]) : null,
      loadavg_1m_before: Number(loadBefore.toFixed(2)),
    });
  }
  log("index-dataset.ts (thời gian bên trong rebuildCatalogIndex)…");
  const loadBefore = os.loadavg()[0];
  const inner = await run("pnpm", ["exec", "medusa", "exec", "../../scripts/load/index-dataset.ts"], {
    cwd: backendDir,
    env,
  });
  const m = inner.output.match(/(\d+) dòng read model \(kỳ vọng (\d+).*trong (\d+) ms/);
  const db = await connect(urls.db);
  try {
    const c = await db.query(
      `SELECT count(*)::int AS rows,
              count(*) FILTER (WHERE variant_id LIKE 'variant_LD%')::int AS load_rows FROM catalog_variant_index`,
    );
    const expectedLoad = expectedSkuCount(PERF.products);
    if (c.rows[0].load_rows !== expectedLoad)
      throw new Error(`read model thiếu dòng: ${c.rows[0].load_rows}/${expectedLoad} SKU tải`);
    return {
      runs,
      inner: {
        command: "medusa exec ../../scripts/load/index-dataset.ts",
        wall_ms: Math.round(inner.ms),
        rebuild_ms: m ? Number(m[3]) : null,
        rows: m ? Number(m[1]) : null,
        expected: m ? Number(m[2]) : null,
        loadavg_1m_before: Number(loadBefore.toFixed(2)),
      },
      table_rows: c.rows[0].rows,
    };
  } finally {
    await db.end();
  }
}

async function generateOrders(urls) {
  const db = await connect(urls.db);
  try {
    await db.query("BEGIN");
    for (const sql of orderHistoryStatements(PERF.orders)) {
      const t = Date.now();
      await db.query(sql);
      const ms = Date.now() - t;
      if (ms >= 2000) log(`  ${(ms / 1000).toFixed(1)} s: ${sql.replace(/\s+/g, " ").slice(0, 70)}`);
    }
    await db.query("COMMIT");
    await db.query("VACUUM ANALYZE");
    return (await db.query(LARGE_TABLE_COUNTS)).rows[0];
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      log(`ROLLBACK lỗi (giữ lỗi gốc): ${rollbackError.message}`);
    }
    throw e;
  } finally {
    await db.end();
  }
}

function machine() {
  const cpus = os.cpus();
  return {
    cpus: cpus.length,
    cpu_model: cpus[0]?.model ?? "?",
    ram_gib: Number((os.totalmem() / 2 ** 30).toFixed(1)),
    loadavg: os.loadavg().map((x) => Number(x.toFixed(2))),
    node: process.version,
  };
}

async function main(argv) {
  assertSafePerfTargets();
  const urls = perfUrls();
  if (argv.includes("--drop")) {
    const admin = await connect(urls.admin);
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${PERF.dbName}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
    await withRedis(urls.redis, (r) => r.flushdb());
    log(`đã xoá DB ${PERF.dbName} và dọn Redis DB ${PERF.redisDb}`);
    return;
  }
  const summary = { date_utc: new Date().toISOString(), machine: machine(), db: PERF.dbName, timings_ms: {} };
  const timed = async (name, fn) => {
    const t = Date.now();
    const r = await fn();
    summary.timings_ms[name] = Date.now() - t;
    log(`${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return r;
  };
  const reindexOnly = argv.includes("--reindex-only");
  const ordersOnly = argv.includes("--orders-only");
  if (!reindexOnly && !ordersOnly) {
    const keys = await withRedis(urls.redis, (r) => r.dbsize());
    if (keys > 0)
      throw new Error(`Redis DB ${PERF.redisDb} đang có ${keys} khoá (việc khác?) — chọn PERF_REDIS_DB rỗng`);
    const env = perfBackendEnv(urls);
    const medusa = (args) => run("pnpm", ["exec", "medusa", ...args], { cwd: backendDir, env });
    await timed("build domain", () => run("pnpm", ["--filter", "@x-shop/domain", "build"]));
    await timed("làm mới DB", () => resetDatabase(urls));
    await timed("migrate", () => medusa(["db:migrate"]));
    await timed("seed nền + catalog demo", () => medusa(["exec", "./src/scripts/seed-catalog.ts"]));
    summary.catalog = await timed("sinh catalog (SQL)", async () => {
      const db = await connect(urls.db);
      try {
        return await generateDataset(db, PERF.products);
      } finally {
        await db.end();
      }
    });
  }
  if (!ordersOnly) {
    summary.reindex = await timed("đo reindex", () => measureReindex(urls));
    log(`reindex ${JSON.stringify(summary.reindex)}`); // in ngay — bước sau lỗi cũng không mất số đo
  }
  if (!reindexOnly) {
    summary.orders = await timed("sinh lịch sử đơn (SQL) + VACUUM ANALYZE", () => generateOrders(urls));
  }
  console.log(`[perf] KẾT QUẢ ${JSON.stringify(summary)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[perf] LỖI: ${e.message}`);
    process.exit(1);
  });
}
