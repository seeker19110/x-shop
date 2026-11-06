/**
 * EXPLAIN (ANALYZE, BUFFERS) cho truy vấn đường nóng (DB-PERF-001, T-074) — FAIL nếu kế hoạch có `Seq Scan` trên bảng
 * lớn (`LARGE_TABLES` trong hot-paths.mjs) mà mục đó không khai `allowSeqScan` kèm lý do.
 *
 *   EXPLAIN_DATABASE_URL=postgres://xshop:xshop@localhost:5432/xshop_perf node scripts/ops/explain-hot-paths.mjs [--write] [--only <tên>]
 *
 * Chạy trên DB đo đạc dựng bằng `node scripts/ops/perf-dataset.mjs` (50k SKU + 200k đơn tổng hợp): trên DB nhỏ, planner
 * chọn Seq Scan một cách hợp lý → script từ chối (exit 2) khi bảng lớn ít dòng hơn ngưỡng. Mỗi truy vấn chạy trong giao
 * dịch ROLLBACK (kể cả UPDATE của claim outbox) — một lần làm ấm, một lần FORMAT JSON (kiểm), một lần dạng chữ (ghi).
 * `--write`: ghi `docs/db/explain/<tên>.txt` + `docs/db/explain/summary.md`. Không bao giờ chạy trên DB có dữ liệu thật.
 *
 * Exit: 0 đạt · 1 có Seq Scan trên bảng lớn không được phép · 2 lỗi cấu hình/dữ liệu.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hotPaths, LARGE_TABLES, loadCatalogQuery } from "./hot-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(root, "docs/db/explain");

/**
 * Đổi placeholder `?` kiểu knex sang `$n` của PostgreSQL, bỏ qua `?` trong chuỗi '…', định danh "…" và chú thích `--`.
 * Số placeholder phải bằng số tham số (lệch → ném lỗi, tránh EXPLAIN một câu khác câu thật).
 */
export function toPgPlaceholders(sql, bindingCount) {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const end = closingQuote(sql, i, ch);
      out += sql.slice(i, end + 1);
      i = end;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length - 1 : nl;
      out += sql.slice(i, end + 1);
      i = end;
    } else if (ch === "?") {
      if (sql[i + 1] === "?") throw new Error("placeholder định danh `??` không được hỗ trợ");
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  if (n !== bindingCount) throw new Error(`số placeholder (${n}) khác số tham số (${bindingCount})`);
  return out;
}

function closingQuote(sql, start, q) {
  for (let j = start + 1; j < sql.length; j++) {
    if (sql[j] === q) {
      if (sql[j + 1] === q)
        j++; // '' hoặc "" thoát trong chuỗi
      else return j;
    }
  }
  throw new Error(`chuỗi ${q} không đóng từ vị trí ${start}`);
}

/** Tên bảng của mọi nút Seq Scan (kể cả song song, InitPlan, SubPlan, CTE) trong kế hoạch EXPLAIN FORMAT JSON. */
export function seqScans(explainJson) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) found.push(node["Relation Name"]);
    for (const child of node.Plans ?? []) walk(child);
  };
  for (const top of Array.isArray(explainJson) ? explainJson : [explainJson]) walk(top?.Plan);
  return found;
}

/** Bảng lớn bị quét tuần tự mà mục không cho phép (mỗi bảng một lần). */
export function violations(entry, scans, large = LARGE_TABLES) {
  const allowed = entry.allowSeqScan ?? {};
  return [...new Set(scans)].filter((t) => Object.hasOwn(large, t) && !Object.hasOwn(allowed, t));
}

/** Bảng lớn có ít dòng hơn ngưỡng (kết quả EXPLAIN vô nghĩa) → [{ table, rows, min }]. */
export function tooSmall(counts, large = LARGE_TABLES) {
  return Object.entries(large)
    .filter(([t, min]) => !(Number(counts[t]) >= min))
    .map(([t, min]) => ({ table: t, rows: Number(counts[t] ?? 0), min }));
}

/** Kiểm danh sách truy vấn: tên duy nhất, an toàn làm tên file; lý do cho phép không rỗng, chỉ cho bảng lớn. */
export function validateHotPaths(list, large = LARGE_TABLES) {
  const errors = [];
  const seen = new Set();
  for (const e of list) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.name ?? "")) errors.push(`tên không hợp lệ: ${e.name}`);
    if (seen.has(e.name)) errors.push(`tên trùng: ${e.name}`);
    seen.add(e.name);
    if (!e.source) errors.push(`${e.name}: thiếu source`);
    if (typeof e.build !== "function") errors.push(`${e.name}: thiếu build()`);
    for (const [t, why] of Object.entries(e.allowSeqScan ?? {})) {
      if (!Object.hasOwn(large, t))
        errors.push(`${e.name}: allowSeqScan cho bảng không thuộc LARGE_TABLES: ${t}`);
      if (typeof why !== "string" || why.trim().length < 20)
        errors.push(`${e.name}: lý do allowSeqScan quá ngắn (${t})`);
    }
  }
  return errors;
}

/** Bảng tóm tắt markdown (docs/db/explain/summary.md). */
export function renderSummary(results, meta) {
  const rows = results.map((r) => {
    const verdict = r.bad.length
      ? `**FAIL** Seq Scan: ${r.bad.join(", ")}`
      : r.allowed.length
        ? `đạt (cho phép Seq Scan: ${r.allowed.join(", ")})`
        : "đạt";
    return `| [${r.name}](${r.name}.txt) | ${r.execMs.toFixed(2)} | ${r.buffers} | ${verdict} |`;
  });
  const counts = Object.entries(meta.counts)
    .map(([t, n]) => `${t} ${Number(n).toLocaleString("vi-VN")}`)
    .join(" · ");
  return [
    "# Tóm tắt EXPLAIN đường nóng (sinh tự động — không sửa tay)",
    "",
    `Sinh bởi \`node scripts/ops/explain-hot-paths.mjs --write\` lúc ${meta.date} trên DB \`${meta.db}\` (PostgreSQL ${meta.pg}). Số dòng: ${counts}.`,
    "Thời gian = `Execution Time` của lần EXPLAIN dạng chữ (cache ấm, một người dùng, máy dùng chung — chỉ để so tương đối); Buffers = shared hit + read của nút gốc.",
    "",
    "| Truy vấn | Thực thi (ms) | Buffers | Kết luận |",
    "|---|---:|---:|---|",
    ...rows,
    "",
  ].join("\n");
}

const fromRoot = createRequire(path.join(root, "package.json"));

async function explainOne(db, entry, ctx) {
  const { sql, bindings } = entry.build(ctx);
  const text = toPgPlaceholders(sql, bindings.length);
  const inTx = async (q) => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL statement_timeout = '120s'");
      return await db.query(q, bindings);
    } finally {
      await db.query("ROLLBACK");
    }
  };
  await inTx(text); // làm ấm cache
  const json = (await inTx(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`)).rows[0]["QUERY PLAN"];
  const plain = (await inTx(`EXPLAIN (ANALYZE, BUFFERS) ${text}`)).rows
    .map((r) => r["QUERY PLAN"])
    .join("\n");
  const scans = seqScans(json);
  const top = json[0];
  return {
    name: entry.name,
    source: entry.source,
    sql: text,
    bindings,
    plain,
    scans,
    bad: violations(entry, scans),
    allowed: [...new Set(scans)].filter((t) => Object.hasOwn(entry.allowSeqScan ?? {}, t)),
    allowSeqScan: entry.allowSeqScan ?? {},
    execMs: Number(/Execution Time: ([\d.]+) ms/.exec(plain)?.[1] ?? top["Execution Time"] ?? 0),
    buffers: Number(top.Plan["Shared Hit Blocks"] ?? 0) + Number(top.Plan["Shared Read Blocks"] ?? 0),
  };
}

function planFile(r, meta) {
  const allow = Object.entries(r.allowSeqScan).map(([t, why]) => `--   cho phép Seq Scan ${t}: ${why}`);
  return [
    `-- ${r.name}`,
    `-- Nguồn: ${r.source}`,
    `-- Sinh: node scripts/ops/explain-hot-paths.mjs --write · ${meta.date} · DB ${meta.db} · PostgreSQL ${meta.pg}`,
    `-- Kết luận: ${r.bad.length ? `FAIL — Seq Scan trên bảng lớn: ${r.bad.join(", ")}` : "đạt"}`,
    ...allow,
    `-- Tham số: ${JSON.stringify(r.bindings)}`,
    "",
    r.sql.replace(/^\s+/gm, "  ").trim() + ";",
    "",
    r.plain,
    "",
  ].join("\n");
}

async function main(argv) {
  const url = process.env.EXPLAIN_DATABASE_URL;
  if (!url) {
    console.error("[explain] thiếu EXPLAIN_DATABASE_URL (DB đo đạc dựng bằng scripts/ops/perf-dataset.mjs)");
    return 2;
  }
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const list = hotPaths(await loadCatalogQuery(root));
  const errors = validateHotPaths(list);
  if (errors.length) {
    for (const e of errors) console.error(`[explain] danh sách lỗi: ${e}`);
    return 2;
  }
  const { Client } = fromRoot("pg");
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const countSql = Object.keys(LARGE_TABLES)
      .map((t) => `(SELECT count(*) FROM "${t}")::bigint AS "${t}"`)
      .join(", ");
    const counts = (await db.query(`SELECT ${countSql}`)).rows[0];
    const small = tooSmall(counts);
    if (small.length) {
      for (const s of small)
        console.error(`[explain] ${s.table}: ${s.rows} dòng < ${s.min} — dữ liệu quá nhỏ, EXPLAIN vô nghĩa`);
      return 2;
    }
    const channels = await db.query("SELECT id FROM sales_channel WHERE deleted_at IS NULL ORDER BY id");
    const ctx = {
      channelIds: channels.rows.map((r) => r.id),
      now: new Date(),
      ref: (i) => String(i).padStart(7, "0"),
    };
    const meta = {
      date: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
      db: (await db.query("SELECT current_database() AS d")).rows[0].d,
      pg: String((await db.query("SHOW server_version")).rows[0].server_version).split(" ")[0],
      counts,
    };
    const results = [];
    for (const entry of list) {
      if (only && entry.name !== only) continue;
      const r = await explainOne(db, entry, ctx);
      results.push(r);
      const scanNote = r.scans.length ? ` · Seq Scan: ${[...new Set(r.scans)].join(", ")}` : "";
      console.log(
        `[explain] ${r.bad.length ? "FAIL" : "ok  "} ${r.name} ${r.execMs.toFixed(2)} ms, ${r.buffers} buffers${scanNote}`,
      );
    }
    if (only && results.length === 0) {
      console.error(`[explain] không có truy vấn tên ${only}`);
      return 2;
    }
    if (argv.includes("--write")) {
      mkdirSync(OUT_DIR, { recursive: true });
      for (const r of results) writeFileSync(path.join(OUT_DIR, `${r.name}.txt`), planFile(r, meta));
      if (!only) {
        // Định dạng bằng prettier của repo để `pnpm format:check` xanh ngay sau khi sinh lại.
        const file = path.join(OUT_DIR, "summary.md");
        const prettier = fromRoot("prettier");
        const options = (await prettier.resolveConfig(file)) ?? {};
        writeFileSync(
          file,
          await prettier.format(renderSummary(results, meta), { ...options, filepath: file }),
        );
      }
      console.log(`[explain] đã ghi ${results.length} plan vào docs/db/explain/`);
    }
    const failed = results.filter((r) => r.bad.length);
    console.log(`[explain] ${results.length - failed.length}/${results.length} đạt`);
    return failed.length ? 1 : 0;
  } finally {
    await db.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[explain] LỖI: ${e.message}`);
      process.exit(2);
    },
  );
}
