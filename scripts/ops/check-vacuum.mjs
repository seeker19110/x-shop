#!/usr/bin/env node
/**
 * Kiểm sức khoẻ vacuum (T-196, DB-PERF-008) trên DB đang chạy — chỉ ĐỌC catalog/thống kê, không ghi gì.
 *
 *   DATABASE_URL=postgres://… node scripts/ops/check-vacuum.mjs
 *
 * Kiểm (mỗi vấn đề một dòng `FAIL …`):
 *  - `autovacuum` của máy chủ phải `on` (tắt thì chỉ còn vacuum chống wraparound — bloat tích tụ);
 *  - tuổi XID `age(datfrozenxid)` của MỌI database trong cụm ≤ MAX_XID_AGE (wraparound dừng ghi cả cụm, không riêng DB
 *    này; `pg_database` đọc được với mọi vai trò);
 *  - mỗi bảng ghi nhiều (HOT_TABLES — bảng có tham số autovacuum riêng, migration checkout Migration20261031090000 và
 *    audit Migration20261031090100) phải có trong `pg_stat_user_tables` của DB và tỉ lệ `n_dead_tup / n_live_tup` ≤
 *    MAX_DEAD_RATIO — chỉ xét khi `n_dead_tup` ≥ MIN_DEAD_TUPLES (bảng nhỏ vài chục dòng chết không phải bloat).
 * `n_live_tup`/`n_dead_tup` là ƯỚC LƯỢNG của bộ thống kê (cập nhật khi vacuum/analyze và theo hoạt động ghi), đủ để báo
 * động, không phải số đếm chính xác.
 *
 * Nguồn ngưỡng (PostgreSQL 16, tra 2026-10-31):
 *  - postgresql.org/docs/16/runtime-config-autovacuum.html — autovacuum_freeze_max_age mặc định 200 triệu: tới đó
 *    autovacuum BẮT BUỘC vacuum bảng (kể cả khi autovacuum tắt); autovacuum_vacuum_scale_factor mặc định 0.2;
 *  - postgresql.org/docs/16/routine-vacuuming.html §25.1.5 — XID vòng ở 2^31 (~2,1 tỉ); máy chủ cảnh báo khi còn
 *    40 triệu, từ chối cấp XID mới khi còn 3 triệu; câu `SELECT datname, age(datfrozenxid) FROM pg_database`.
 * MAX_XID_AGE = 2 × autovacuum_freeze_max_age mặc định: vượt nghĩa là vacuum chống wraparound KHÔNG theo kịp (lẽ ra đã
 * kéo tuổi về dưới 200 triệu), còn ~1,7 tỉ XID trước mốc cảnh báo của máy chủ — đủ thời gian xử lý. Cụm đặt
 * autovacuum_freeze_max_age cao hơn mặc định thì nâng hằng số này theo (luôn > giá trị đó).
 * MAX_DEAD_RATIO = 0.2 = autovacuum_vacuum_scale_factor MẶC ĐỊNH; bốn bảng đã đặt 0.01–0.1 nên tới 0.2 là autovacuum
 * không chạy được/không dọn được (giao dịch dài giữ snapshot, slot replication, khoá) — không phải chưa tới lượt.
 *
 * Thoát: 0 ổn · 1 vượt ngưỡng (hoặc thiếu bảng — sai DB/chưa migrate) · 2 thiếu DATABASE_URL / lỗi kết nối hoặc truy vấn.
 * Không in DATABASE_URL (chứa mật khẩu).
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Tuổi XID tối đa của một database (giao dịch) — 2 × autovacuum_freeze_max_age mặc định (200 000 000). */
export const MAX_XID_AGE = 400_000_000;
/** Tỉ lệ dead/live tối đa của bảng ghi nhiều — bằng autovacuum_vacuum_scale_factor mặc định. */
export const MAX_DEAD_RATIO = 0.2;
/** Dưới số dòng chết này không xét tỉ lệ (bảng gần rỗng). */
export const MIN_DEAD_TUPLES = 1_000;
/** Bảng có tham số autovacuum riêng (T-196). */
export const HOT_TABLES = Object.freeze(["outbox_event", "rate_limit_counter", "webhook_inbox", "audit_log"]);
/** Giới hạn thời gian kết nối/truy vấn (ms) — script giám sát không được treo. */
const TIMEOUT_MS = 10_000;

export const THRESHOLDS = Object.freeze({
  maxXidAge: MAX_XID_AGE,
  maxDeadRatio: MAX_DEAD_RATIO,
  minDeadTuples: MIN_DEAD_TUPLES,
  tables: HOT_TABLES,
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fromRoot = createRequire(path.join(root, "package.json"));

/**
 * Số đếm không âm từ driver: `pg` trả bigint (n_live_tup/n_dead_tup) dạng chuỗi, int4 (age) dạng number. Giá trị khác
 * (null, âm, thập phân, vượt 2^53 − 1, chuỗi lạ) → RangeError: dữ liệu thống kê hỏng không được hiểu thành "ổn".
 */
export function toCount(value, label) {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${label}: giá trị không phải số đếm hợp lệ (${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Đánh giá thuần (không I/O). Đầu vào là các dòng truy vấn thô:
 *  - `autovacuum`: giá trị `SHOW autovacuum` ("on" | "off");
 *  - `databases`: [{ datname, xid_age }];
 *  - `tables`: [{ relname, n_live_tup, n_dead_tup }] (chỉ bảng tìm thấy; bảng vắng = vấn đề).
 * Trả { ok, problems: string[], lines: string[] } — `lines` là dòng báo cáo cho mọi mục đã xét (cả mục ổn).
 */
export function evaluateVacuum({ autovacuum, databases, tables }, thresholds = THRESHOLDS) {
  const problems = [];
  const lines = [];
  if (autovacuum === "on") lines.push("ok   autovacuum = on");
  else problems.push(`autovacuum = ${JSON.stringify(autovacuum ?? null)} (phải on)`);

  if (!Array.isArray(databases) || databases.length === 0) {
    throw new RangeError("pg_database không trả dòng nào — không đánh giá được tuổi XID");
  }
  // Cụm có thể có nhiều DB: in từng DB vượt ngưỡng, còn lại gộp một dòng (DB già nhất).
  let oldest = null;
  let okCount = 0;
  for (const db of databases) {
    const age = toCount(db.xid_age, `age(datfrozenxid) của ${db.datname}`);
    if (age > thresholds.maxXidAge) {
      problems.push(`database ${db.datname}: age(datfrozenxid) = ${age} (ngưỡng ${thresholds.maxXidAge})`);
      continue;
    }
    okCount += 1;
    if (oldest === null || age > oldest.age) oldest = { name: db.datname, age };
  }
  if (oldest) {
    lines.push(
      `ok   ${okCount} database: age(datfrozenxid) lớn nhất = ${oldest.age} (${oldest.name}, ngưỡng ${thresholds.maxXidAge})`,
    );
  }

  const byName = new Map((tables ?? []).map((t) => [t.relname, t]));
  for (const name of thresholds.tables) {
    const row = byName.get(name);
    if (!row) {
      problems.push(`bảng ${name}: không có trong pg_stat_user_tables (sai DB hoặc chưa migrate)`);
      continue;
    }
    const live = toCount(row.n_live_tup, `${name}.n_live_tup`);
    const dead = toCount(row.n_dead_tup, `${name}.n_dead_tup`);
    // live = 0 mà dead đủ nhiều: tỉ lệ vô hạn — toàn bảng là dòng chết.
    const ratio = live === 0 ? (dead === 0 ? 0 : Number.POSITIVE_INFINITY) : dead / live;
    const shown = Number.isFinite(ratio) ? ratio.toFixed(3) : "∞";
    const line = `bảng ${name}: n_dead_tup = ${dead}, n_live_tup = ${live}, tỉ lệ ${shown} (ngưỡng ${thresholds.maxDeadRatio} khi dead ≥ ${thresholds.minDeadTuples})`;
    if (dead >= thresholds.minDeadTuples && ratio > thresholds.maxDeadRatio) problems.push(line);
    else lines.push(`ok   ${line}`);
  }
  return { ok: problems.length === 0, problems, lines };
}

/** Đọc thống kê từ DB (một kết nối, chỉ SELECT/SHOW). */
async function collect(client, tables) {
  const autovacuum = (await client.query("SHOW autovacuum")).rows[0]?.autovacuum;
  const databases = (
    await client.query("SELECT datname, age(datfrozenxid) AS xid_age FROM pg_database ORDER BY datname")
  ).rows;
  const stats = (
    await client.query(
      `SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables
        WHERE schemaname = current_schema() AND relname = ANY($1::text[])`,
      [tables],
    )
  ).rows;
  return { autovacuum, databases, tables: stats };
}

export async function main(env = process.env) {
  const url = env.DATABASE_URL;
  if (!url) {
    console.error("[vacuum] thiếu DATABASE_URL");
    return 2;
  }
  const { Client } = fromRoot("pg");
  let client;
  let input;
  try {
    // Dựng Client trong try: URL sai cú pháp ném ngay ở constructor — cũng là lỗi kết nối (exit 2).
    client = new Client({
      connectionString: url,
      connectionTimeoutMillis: TIMEOUT_MS,
      statement_timeout: TIMEOUT_MS,
      // Phía client: mạng mất gói sau khi đã kết nối thì statement_timeout (server) không cứu được.
      query_timeout: TIMEOUT_MS,
      application_name: "x-shop check-vacuum",
    });
    await client.connect();
    input = await collect(client, [...THRESHOLDS.tables]);
  } catch (e) {
    // Thông điệp của pg không chứa mật khẩu; vẫn không in URL.
    console.error(`[vacuum] LỖI kết nối/truy vấn: ${e?.code ? `${e.code} ` : ""}${e?.message ?? e}`);
    return 2;
  } finally {
    // Đóng kết nối lỗi không đổi kết luận (đã có dữ liệu hoặc đã báo lỗi kết nối) — chỉ ghi lại.
    await client
      ?.end()
      .catch((e) => console.error(`[vacuum] cảnh báo: đóng kết nối lỗi: ${e?.message ?? e}`));
  }
  let result;
  try {
    result = evaluateVacuum(input);
  } catch (e) {
    console.error(`[vacuum] LỖI dữ liệu thống kê: ${e.message}`);
    return 2;
  }
  for (const l of result.lines) console.log(`[vacuum] ${l}`);
  for (const p of result.problems) console.error(`[vacuum] FAIL ${p}`);
  console.log(
    `[vacuum] ${result.ok ? "ổn" : `${result.problems.length} vấn đề — xử lý theo docs/ops/RUNBOOK.md §15`}`,
  );
  return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[vacuum] LỖI: ${e?.message ?? e}`);
      process.exit(2);
    },
  );
}
