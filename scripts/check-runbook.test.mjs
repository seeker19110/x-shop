import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addMonths, checkRunbook, parseDate, parseSections, RUNBOOK_PATH } from "./check-runbook.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TODAY = parseDate("2026-10-30");
const doc = (...sections) => `# RUNBOOK\n\n## 0. Liên lạc\n\nkhông cần dòng\n\n${sections.join("\n")}`;
const run = (text, ...args) => checkRunbook(text, parseDate("2026-10-30"), ...args);

test("parseDate: ngày hợp lệ; từ chối ngày không tồn tại, sai định dạng, rỗng", () => {
  assert.equal(parseDate("2026-10-30")?.toISOString(), "2026-10-30T00:00:00.000Z");
  assert.equal(parseDate("2024-02-29") !== null, true);
  for (const bad of [
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "2026-00-10",
    "26-10-30",
    "2026-1-3",
    "",
    "hôm nay",
  ]) {
    assert.equal(parseDate(bad), null, bad);
  }
});

test("addMonths: kẹp cuối tháng, qua năm", () => {
  assert.equal(addMonths(parseDate("2026-08-31"), 6).toISOString().slice(0, 10), "2027-02-28");
  assert.equal(addMonths(parseDate("2026-10-30"), 6).toISOString().slice(0, 10), "2027-04-30");
  assert.equal(addMonths(parseDate("2026-12-15"), 6).toISOString().slice(0, 10), "2027-06-15");
});

test("mục có ngày hợp lệ, gần đây → không lỗi, không cảnh báo", () => {
  const r = run(doc("## 1. A\n\nlast_drilled: 2026-10-25\n"));
  assert.deepEqual(r, { errors: [], warnings: [], notices: [] });
});

test("mục 0 và tiêu đề ### / ## không số không bị đòi", () => {
  const r = run(doc("## 1. A\n\nlast_drilled: 2026-10-25\n\n### 1.1 con\n\n## Phụ lục\n\nvăn xuôi\n"));
  assert.deepEqual(r.errors, []);
});

test("thiếu dòng last_drilled → lỗi, nêu số mục", () => {
  const r = run(doc("## 1. A\n\nlast_drilled: 2026-10-25\n", "## 2. B\n\nkhông có gì\n"));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /§2 "B"/);
});

test("last_drilled nằm trong khối code hoặc không ở đầu dòng → không tính", () => {
  const r = run(
    doc("## 1. A\n\n```\nlast_drilled: 2026-10-25\n```\n", "## 2. B\n\n  last_drilled: 2026-10-25\n"),
  );
  assert.equal(r.errors.length, 2);
});

test("tiêu đề ## nằm trong khối code không mở mục mới", () => {
  const r = run(doc("## 1. A\n\nlast_drilled: 2026-10-25\n\n```md\n## 2. giả\n```\n"));
  assert.deepEqual(r.errors, []);
  assert.equal(parseSections(doc("## 1. A\n\n```\n## 2. giả\n```\n")).length, 1);
});

test("ngày tương lai, không tồn tại, sai định dạng → lỗi", () => {
  for (const v of ["2026-10-31", "2099-01-01", "2026-02-30", "30/10/2026", "2026-10", "sớm"]) {
    const r = run(doc(`## 1. A\n\nlast_drilled: ${v}\n`));
    assert.equal(r.errors.length, 1, v);
  }
  assert.deepEqual(run(doc("## 1. A\n\nlast_drilled:\n")).errors.length, 1);
});

test("hôm nay hợp lệ (biên: không phải tương lai)", () => {
  assert.deepEqual(run(doc("## 1. A\n\nlast_drilled: 2026-10-30\n")).errors, []);
});

test("quá 6 tháng → cảnh báo, không lỗi; đúng biên 6 tháng chưa cảnh báo", () => {
  const old = run(doc("## 1. A\n\nlast_drilled: 2026-04-29\n"));
  assert.deepEqual(old.errors, []);
  assert.equal(old.warnings.length, 1);
  assert.match(old.warnings[0], /quá 6 tháng/);
  assert.deepEqual(run(doc("## 1. A\n\nlast_drilled: 2026-04-30\n")).warnings, []);
});

test("chưa diễn tập + lý do → thông báo, không lỗi; thiếu lý do → lỗi", () => {
  for (const v of [
    "chưa diễn tập (chưa có staging)",
    "chưa diễn tập — chờ hạ tầng",
    "chưa diễn tập: x",
    "chưa diễn tập. Có lý do",
  ]) {
    const r = run(doc(`## 1. A\n\nlast_drilled: ${v}\n`));
    assert.deepEqual([r.errors.length, r.notices.length], [0, 1], v);
  }
  for (const v of ["chưa diễn tập", "chưa diễn tập —", "chưa diễn tập ()", "chưa diễn tậpxyz"]) {
    assert.equal(run(doc(`## 1. A\n\nlast_drilled: ${v}\n`)).errors.length, 1, v);
  }
});

test("file không có mục nào → lỗi (không pass rỗng)", () => {
  assert.equal(run("# RUNBOOK\n\n## 0. x\n").errors.length, 1);
  assert.equal(run("").errors.length, 1);
});

test("CRLF được chấp nhận", () => {
  const r = run(doc("## 1. A\r\n\r\nlast_drilled: 2026-10-25\r\n"));
  assert.deepEqual(r.errors, []);
});

test("CLI: RUNBOOK thật qua (exit 0); file hỏng exit 1; cảnh báo in ::warning:: vẫn exit 0", () => {
  const script = join(here, "check-runbook.mjs");
  const ok = spawnSync("node", [script, "--file", RUNBOOK_PATH], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const dir = mkdtempSync(join(tmpdir(), "runbook-"));
  try {
    const bad = join(dir, "bad.md");
    writeFileSync(bad, doc("## 1. A\n\nkhông có\n"));
    assert.equal(spawnSync("node", [script, "--file", bad], { encoding: "utf8" }).status, 1);
    const stale = join(dir, "stale.md");
    writeFileSync(stale, doc("## 1. A\n\nlast_drilled: 2025-01-01\n"));
    const w = spawnSync("node", [script, "--file", stale, "--today", "2026-10-30"], { encoding: "utf8" });
    assert.equal(w.status, 0);
    assert.match(w.stdout, /::warning::/);
    assert.equal(spawnSync("node", [script, "--file", join(dir, "none.md")], { encoding: "utf8" }).status, 1);
    assert.equal(spawnSync("node", [script, "--today", "2026-02-30"], { encoding: "utf8" }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TODAY hằng số dùng được (kiểm công cụ test)", () => {
  assert.equal(TODAY.getUTCFullYear(), 2026);
});

// --- Cổng backup của RUNBOOK §8.2 bước 0 (DB-MIG-011): trích khối shell THẬT giữa hai dấu rồi chạy với dữ liệu giả ---
const runbookText = readFileSync(RUNBOOK_PATH, "utf8");
const gateBlock = /^# >>> gate-backup.*\n([\s\S]*?)^# <<< gate-backup$/m.exec(runbookText)?.[1];

test("RUNBOOK: khối gate-backup tồn tại, nằm sau `set -euo pipefail` và trước db:migrate", () => {
  assert.ok(gateBlock, "mất khối gate-backup");
  const iSet = runbookText.indexOf("set -euo pipefail   #");
  const iGate = runbookText.indexOf("# >>> gate-backup");
  const iMigrate = runbookText.indexOf("cd apps/backend && npx medusa db:migrate\n", iGate);
  assert.ok(iSet >= 0 && iSet < iGate && iGate < iMigrate);
});

function runGate(setup, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    setup(dir);
    // Giữ nguyên ngữ nghĩa khối §8.2: `set -euo pipefail` đầu khối, thay migrate bằng echo.
    const script = `set -euo pipefail\n${gateBlock}\necho MIGRATED\n`;
    const r = spawnSync("bash", ["-c", script], {
      env: { PATH: process.env.PATH, BACKUP_DIR: dir, ...env },
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const isoAgo = (seconds) =>
  new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d+Z$/, ".000000Z");
const sha = (t) => createHash("sha256").update(t).digest("hex");
const writeBackup = (dir, { agoS = 60, content = "dump", metaSha = sha("dump"), mark = true } = {}) => {
  writeFileSync(join(dir, "a.dump"), content);
  const lines = [mark ? `snapshot_mark_utc=${isoAgo(agoS)}` : "", `sha256=${metaSha}`].filter(Boolean);
  writeFileSync(join(dir, "a.dump.meta"), `${lines.join("\n")}\n`);
};

test("gate-backup: bản mới + sha khớp → qua, chạy tiếp (MIGRATED)", () => {
  const r = runGate((d) => writeBackup(d));
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /OK: backup[\s\S]*MIGRATED/);
});

test("gate-backup: thư mục rỗng / bản cũ 30 giờ / sha lệch / .meta thiếu mốc → exit ≠ 0 và KHÔNG chạy migrate", () => {
  const bad = {
    "thư mục rỗng": () => {},
    "cũ 30 giờ": (d) => writeBackup(d, { agoS: 30 * 3600 }),
    "sha lệch": (d) => writeBackup(d, { content: "dump bị sửa" }),
    "thiếu snapshot_mark_utc": (d) => writeBackup(d, { mark: false }),
    "mốc ở tương lai": (d) => writeBackup(d, { agoS: -3600 }),
    "file dump không còn": (d) => {
      writeBackup(d);
      rmSync(join(d, "a.dump"));
    },
  };
  for (const [name, setup] of Object.entries(bad)) {
    const r = runGate(setup);
    assert.notEqual(r.status, 0, name);
    assert.doesNotMatch(r.out, /MIGRATED/, name);
    assert.match(r.err, /DỪNG/, name);
  }
});

test("gate-backup: so bằng giây, không làm tròn giờ (24 giờ + 30 phút bị chặn; N đổi bằng XS_BACKUP_MAX_AGE_HOURS)", () => {
  assert.notEqual(runGate((d) => writeBackup(d, { agoS: 24 * 3600 + 1800 })).status, 0);
  assert.equal(runGate((d) => writeBackup(d, { agoS: 24 * 3600 - 60 })).status, 0);
  assert.equal(
    runGate((d) => writeBackup(d, { agoS: 30 * 3600 }), { XS_BACKUP_MAX_AGE_HOURS: "48" }).status,
    0,
  );
  assert.notEqual(
    runGate((d) => writeBackup(d, { agoS: 2 * 3600 }), { XS_BACKUP_MAX_AGE_HOURS: "1" }).status,
    0,
  );
});
