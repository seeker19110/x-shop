/**
 * Dựng môi trường tải (theo cách của e2e/run.mjs): build domain → DB riêng (drop + create) → migrate → seed nền + catalog
 * demo → sinh bộ dữ liệu 10k/50k (SQL hàng loạt) → read model → build backend. Trả thời gian từng bước (ms).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDataset, HANDLE_PREFIX } from "./dataset.mjs";
import {
  ADMIN_DB_URL,
  assertNotProduction,
  assertSafeTargets,
  backendEnv,
  BASE_URL,
  DATABASE_URL,
  LOAD,
  REDIS_URL,
} from "./env.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const backendDir = path.join(root, "apps/backend");
const fromRoot = createRequire(path.join(root, "package.json"));
const fromBackend = createRequire(path.join(backendDir, "package.json"));
export const log = (m) => console.log(`[load] ${m}`);

/** Chạy lệnh và chờ xong; mã thoát khác 0 → ném lỗi. Đầu ra con đi thẳng ra console trừ khi `quiet`. */
export function run(cmd, args, { cwd = root, env = {}, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} thoát mã ${code ?? signal}`)),
    );
  });
}

async function timed(timings, name, fn) {
  const t = Date.now();
  const r = await fn();
  timings[name] = Date.now() - t;
  log(`${name}: ${(timings[name] / 1000).toFixed(1)} s`);
  return r;
}

export async function connectDb(url = DATABASE_URL) {
  const { Client } = fromRoot("pg");
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function resetDatabase() {
  const admin = await connectDb(ADMIN_DB_URL);
  try {
    const name = `"${LOAD.dbName.replace(/"/g, "")}"`;
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [LOAD.dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function databaseExists() {
  const admin = await connectDb(ADMIN_DB_URL);
  try {
    const r = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [LOAD.dbName]);
    return r.rowCount > 0;
  } finally {
    await admin.end();
  }
}

export async function flushRedis() {
  const { default: Redis } = fromBackend("ioredis");
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

/** Dataset đã đủ trong DB hiện có? (chế độ LOAD_REUSE). */
async function datasetPresent() {
  if (!(await databaseExists())) return false;
  const db = await connectDb();
  try {
    const r = await db.query(
      `SELECT (SELECT count(*)::int FROM product WHERE handle LIKE $1) AS products,
              (SELECT count(*)::int FROM catalog_variant_index WHERE variant_id LIKE 'variant_LD%') AS indexed`,
      [`${HANDLE_PREFIX}%`],
    );
    return r.rows[0].products >= LOAD.products && r.rows[0].indexed > 0;
  } catch {
    return false; // chưa migrate
  } finally {
    await db.end();
  }
}

/** Biến thể dùng cho stress 1-đơn-vị: SKU (màu 0, size 0) của sản phẩm cao nhất chưa có giữ chỗ; đặt tồn = 1. */
async function armContentionVariant() {
  const db = await connectDb();
  try {
    const r = await db.query(
      `SELECT pv.id AS variant_id, ii.id AS item_id
         FROM product_variant pv
         JOIN product_variant_inventory_item l ON l.variant_id = pv.id
         JOIN inventory_item ii ON ii.id = l.inventory_item_id
         JOIN inventory_level il ON il.inventory_item_id = ii.id
        WHERE pv.id ~ '^variant_LD[0-9]{5}00$' AND il.reserved_quantity = 0 AND pv.deleted_at IS NULL
        ORDER BY pv.id DESC LIMIT 1`,
    );
    if (r.rowCount === 0) throw new Error("Không tìm được biến thể chưa giữ chỗ cho stress 1 đơn vị");
    const { variant_id: variantId, item_id: itemId } = r.rows[0];
    await db.query(
      `UPDATE inventory_level SET stocked_quantity = 1, raw_stocked_quantity = '{"value": "1", "precision": 20}'::jsonb
        WHERE inventory_item_id = $1`,
      [itemId],
    );
    return { variantId, itemId };
  } finally {
    await db.end();
  }
}

export async function prepare() {
  assertSafeTargets();
  assertNotProduction(BASE_URL);
  const timings = {};
  const env = backendEnv();
  const medusa = (args) => run("pnpm", ["exec", "medusa", ...args], { cwd: backendDir, env });

  await timed(timings, "build domain", () =>
    run("pnpm", ["--filter", "@x-shop/domain", "build"], { quiet: true }),
  );
  let dataset = null;
  if (LOAD.reuse && (await datasetPresent())) {
    log("LOAD_REUSE=1: dùng lại DB đã dựng (bỏ migrate/seed/sinh dữ liệu/read model)");
    timings.reused = 1;
  } else {
    await timed(timings, "làm mới DB + Redis", async () => {
      await resetDatabase();
      await flushRedis();
    });
    await timed(timings, "migrate", () => medusa(["db:migrate"]));
    await timed(timings, "seed nền + catalog demo", () => medusa(["exec", "./src/scripts/seed-catalog.ts"]));
    dataset = await timed(timings, "sinh dữ liệu (SQL)", async () => {
      const db = await connectDb();
      try {
        return await generateDataset(db, LOAD.products, {
          onStep: (sql, ms) => ms >= 2000 && log(`  chậm ${(ms / 1000).toFixed(1)} s: ${sql}`),
        });
      } finally {
        await db.end();
      }
    });
    await timed(timings, "dựng read model (syncCatalogProducts)", () =>
      medusa(["exec", "../../scripts/load/index-dataset.ts"]),
    );
  }
  const contention = await armContentionVariant();
  // SQL trực tiếp không phát sự kiện: xoá cache (tồn/giá) trước khi bật backend để không đọc giá trị cũ.
  await flushRedis();
  await timed(timings, "build backend", () => medusa(["build"]));
  const key = await readPublishableKey();
  return { timings, dataset, contention, publishableKey: key };
}

async function readPublishableKey() {
  const db = await connectDb();
  try {
    const r = await db.query("SELECT token FROM api_key WHERE title = $1 AND type = 'publishable'", [
      "Storefront x-shop",
    ]);
    const token = r.rows[0]?.token;
    if (!token) throw new Error("Seed không tạo publishable key 'Storefront x-shop'");
    return token;
  } finally {
    await db.end();
  }
}

/** Bật backend (nhóm tiến trình riêng); trả { stop, logFile } — stop() dừng cả nhóm, an toàn gọi nhiều lần. */
export async function startBackend(logPath) {
  const { openSync } = await import("node:fs");
  const out = openSync(logPath, "w");
  const child = spawn("pnpm", ["exec", "medusa", "start", "-p", String(LOAD.port)], {
    cwd: backendDir,
    env: { ...process.env, ...backendEnv() },
    stdio: ["ignore", out, out],
    detached: true,
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* đã thoát */
    }
  };
  child.on("exit", () => (stopped = true));
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`backend thoát sớm (mã ${child.exitCode}) — xem ${logPath}`);
    try {
      const res = await fetch(`http://127.0.0.1:${LOAD.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      /* chưa lên */
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(`backend không lên sau 180 s — xem ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { stop, pid: child.pid };
}
