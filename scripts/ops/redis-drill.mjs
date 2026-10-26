#!/usr/bin/env node
// Thao tác Redis cho diễn tập mất Redis (restore-drill.sh) — CHỈ trên DB index riêng của diễn tập, không FLUSHALL.
// Dùng ioredis của apps/backend (máy CI không chắc có redis-cli).
//   node scripts/ops/redis-drill.mjs url <db>            in REDIS_URL trỏ DB index <db> (giữ host/cổng/mật khẩu)
//   node scripts/ops/redis-drill.mjs dbsize <db>         in số khoá
//   node scripts/ops/redis-drill.mjs seed <db> <id>...   đặt khoá "công việc/khoá đang giữ" giả cho từng id
//   node scripts/ops/redis-drill.mjs wipe <db>           xoá MỌI khoá của DB index <db> (SCAN + UNLINK) — mô phỏng mất Redis
// Đọc REDIS_URL (mặc định redis://localhost:6379). Không in mật khẩu.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../apps/backend/package.json"));
const Redis = require("ioredis");

const [cmd, dbArg, ...rest] = process.argv.slice(2);
const db = Number(dbArg);
if (!Number.isInteger(db) || db < 1 || db > 15) {
  // DB 0 là DB mặc định của dev/test/CI — diễn tập không bao giờ đụng tới.
  console.error("DB index diễn tập phải là số nguyên 1..15");
  process.exit(2);
}
const url = new URL(process.env.REDIS_URL || "redis://localhost:6379");
url.pathname = `/${db}`;

if (cmd === "url") {
  process.stdout.write(`${url.toString()}\n`);
  process.exit(0);
}

const redis = new Redis(url.toString(), { maxRetriesPerRequest: 2, lazyConnect: true });
try {
  await redis.connect();
  if (cmd === "dbsize") {
    process.stdout.write(`${await redis.dbsize()}\n`);
  } else if (cmd === "seed") {
    for (const id of rest) {
      // Dạng khoá giống công việc/khóa thật: workflow đang chạy + khóa giỏ giữ bởi tiến trình submit đã chết.
      await redis.set(
        `xs-drill:workflow:${id}`,
        JSON.stringify({ id, step: "reserve-inventory" }),
        "EX",
        3600,
      );
      await redis.set(`xs-drill:lock:cart:${id}`, "owner:dead-submit", "EX", 3600);
    }
    process.stdout.write(`${await redis.dbsize()}\n`);
  } else if (cmd === "wipe") {
    let cursor = "0";
    let removed = 0;
    do {
      const [next, keys] = await redis.scan(cursor, "COUNT", 500);
      cursor = next;
      if (keys.length > 0) removed += await redis.unlink(...keys);
    } while (cursor !== "0");
    process.stdout.write(`${removed}\n`);
  } else {
    console.error(`lệnh lạ: ${cmd ?? "(trống)"}`);
    process.exitCode = 2;
  }
} finally {
  redis.disconnect();
}
