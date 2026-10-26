#!/usr/bin/env node
/**
 * Dữ liệu E2E: seed demo chỉ có tồn 1–3/SKU, mỗi luồng E2E mua cùng loại hàng nên sẽ hết hàng giữa chừng. Script này
 * (chỉ chạy trên DB `xshop_e2e`) nâng tồn các SKU đang còn hàng lên 50 rồi dựng lại read model catalog để PDP/danh mục
 * thấy đúng tồn. SKU hết hàng (0) giữ nguyên. Chạy bởi run.mjs sau bước seed.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backendEnv, DATABASE_URL, E2E_DB_NAME, REDIS_URL } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { Client } = createRequire(path.join(root, "package.json"))("pg");

if (new URL(DATABASE_URL).pathname !== `/${E2E_DB_NAME}`) throw new Error("Chỉ chạy trên DB E2E");
const db = new Client({ connectionString: DATABASE_URL });
await db.connect();
try {
  // Medusa lưu số lượng ở cả cột số và cột `raw_*` (BigNumber) — phải cập nhật cả hai.
  const r = await db.query(
    `UPDATE inventory_level SET stocked_quantity = 50, raw_stocked_quantity = '{"value": "50", "precision": 20}'::jsonb
     WHERE stocked_quantity > 0`,
  );
  console.log(`[e2e] nâng tồn ${r.rowCount} dòng inventory_level lên 50`);
} finally {
  await db.end();
}

// SQL trực tiếp không phát sự kiện nên cache tồn (Redis) còn giá trị cũ → xóa trước khi dựng lại read model.
const { default: Redis } = createRequire(path.join(root, "apps/backend/package.json"))("ioredis");
const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
try {
  await redis.connect();
  await redis.flushdb();
} finally {
  redis.disconnect();
}

const child = spawn("pnpm", ["exec", "medusa", "exec", "./src/scripts/rebuild-catalog-index.ts"], {
  cwd: path.join(root, "apps/backend"),
  env: { ...process.env, ...backendEnv() },
  stdio: "inherit",
});
const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
process.exit(code);
