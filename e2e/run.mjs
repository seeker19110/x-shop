#!/usr/bin/env node
/**
 * `pnpm e2e` — dựng môi trường E2E từ đầu rồi chạy Playwright (Playwright tự bật/tắt backend, storefront, cổng VNPAY
 * giả lập qua `webServer` trong playwright.config.ts):
 *   1. build packages/domain (mock VNPAY dùng bản dist)
 *   2. DB riêng `xshop_e2e` (drop + create mỗi lần) + Redis DB số 7 làm sạch
 *   3. migrate + seed nền + seed catalog demo (apps/backend/src/scripts) + nâng tồn demo (boost-stock.mjs)
 *   4. build backend (medusa build, không Admin) + build storefront với publishable key vừa seed
 *   5. `playwright test` (đối số sau `pnpm e2e` được chuyển tiếp)
 * Cần PostgreSQL + Redis cục bộ (`bash scripts/dev-services.sh`); đổi nơi chứa bằng E2E_PG_BASE_URL / E2E_REDIS_BASE_URL.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADMIN_DB_URL, backendEnv, DATABASE_URL, E2E_DB_NAME, REDIS_URL, storefrontEnv } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = path.join(root, "apps/backend");
const log = (m) => console.log(`[e2e] ${m}`);

/** Chạy lệnh, chờ xong; mã thoát khác 0 → ném lỗi. */
function run(cmd, args, { cwd = root, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} thoát mã ${code ?? signal}`)),
    );
  });
}

const fromBackend = createRequire(path.join(backendDir, "package.json"));
const fromRoot = createRequire(path.join(root, "package.json"));

async function resetDatabase() {
  const { Client } = fromRoot("pg");
  const admin = new Client({ connectionString: ADMIN_DB_URL });
  await admin.connect();
  try {
    const name = `"${E2E_DB_NAME.replace(/"/g, "")}"`;
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [E2E_DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

async function flushRedis() {
  const { default: Redis } = fromBackend("ioredis");
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

async function readPublishableKey() {
  const { Client } = fromRoot("pg");
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
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

async function prepare() {
  const beEnv = backendEnv();
  log("build packages/domain");
  await run("pnpm", ["--filter", "@x-shop/domain", "build"]);

  log(`làm mới DB ${E2E_DB_NAME} và Redis DB 7`);
  await resetDatabase();
  await flushRedis();

  log("migrate + seed nền + seed catalog");
  const medusa = (args) => run("pnpm", ["exec", "medusa", ...args], { cwd: backendDir, env: beEnv });
  await medusa(["db:migrate"]);
  await medusa(["exec", "./src/scripts/seed.ts"]);
  await medusa(["exec", "./src/scripts/seed-catalog.ts"]);
  await run("node", ["e2e/boost-stock.mjs"]);
  const key = await readPublishableKey();

  // Luôn build lại storefront: publishable key đổi theo mỗi lần seed và được nhúng vào bundle lúc build.
  log("build backend");
  await medusa(["build"]);
  log("build storefront");
  await run("pnpm", ["--filter", "@x-shop/storefront", "exec", "next", "build"], {
    env: { ...storefrontEnv(key) },
  });
  return key;
}

async function main() {
  // E2E_REUSE_BUILD=1: CHỈ để chạy lặp lúc viết test — dùng lại DB + bản build của lần chạy đầy đủ trước (đơn cũ vẫn
  // còn trong DB). Cổng chính thức luôn là `pnpm e2e` không đặt biến này.
  const key = process.env.E2E_REUSE_BUILD === "1" ? await readPublishableKey() : await prepare();

  // Làm sạch cache/khóa/hàng đợi sau seed + nâng tồn: không để cache catalog cũ (tồn trước khi nâng) sót lại.
  log("làm sạch Redis DB 7");
  await flushRedis();

  log("chạy Playwright");
  const pw = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, E2E_PUBLISHABLE_KEY: key },
    stdio: "inherit",
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => pw.kill(sig));
  const code = await new Promise((resolve) => pw.on("exit", (c, s) => resolve(c ?? (s ? 1 : 0))));
  process.exit(code);
}

main().catch((e) => {
  console.error(`[e2e] LỖI: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
