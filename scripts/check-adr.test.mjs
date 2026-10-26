import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAdrDir, lintAdr } from "./check-adr.mjs";

const GOOD = `# ADR-0002 — Tiêu đề

## Trạng thái
Accepted

## Ngày
2026-10-26

## Bối cảnh
Vì sao.

## Phương án đã cân nhắc
1. A — loại
2. B — chọn

## Quyết định
B.

## Hệ quả
Tốt.

## Điều kiện đọc lại
Khi tải tăng.
`;

test("ADR đủ heading: không lỗi", () => {
  assert.deepEqual(lintAdr(GOOD), []);
});

test("chấp nhận heading tiếng Anh (MADR) và dấu hai chấm cuối", () => {
  const en = GOOD.replace("Trạng thái", "Status:").replace("Phương án đã cân nhắc", "Considered Options");
  assert.deepEqual(lintAdr(en), []);
});

test("thiếu heading và rỗng được báo", () => {
  const e = lintAdr(GOOD.replace("## Hệ quả\nTốt.\n\n", "").replace("Khi tải tăng.", ""));
  assert.ok(e.some((x) => x.includes("Consequences")));
  assert.ok(e.some((x) => x.includes("Điều kiện đọc lại") && x.includes("rỗng")));
});

test("Considered Options < 2 mục bị báo", () => {
  const e = lintAdr(GOOD.replace("2. B — chọn\n", ""));
  assert.ok(e.some((x) => x.includes(">= 2")));
});

test("đầu vào rỗng/null: báo đủ thiếu, không ném lỗi", () => {
  assert.ok(lintAdr("").length >= 7);
  assert.ok(lintAdr(null).length >= 7);
});

test("thư mục: bỏ qua 0001, bắt tên sai, số trùng, ADR thiếu; Unicode trong nội dung ổn", () => {
  const d = mkdtempSync(join(tmpdir(), "adr-"));
  try {
    writeFileSync(join(d, "0001-stack.md"), "# cũ, không heading\n");
    writeFileSync(join(d, "0002-ok.md"), GOOD + "\nĐà Nẵng — Huế ✓\n");
    writeFileSync(join(d, "0003-bad.md"), "# thiếu\n");
    writeFileSync(join(d, "0003-dup.md"), GOOD);
    writeFileSync(join(d, "Bad_Name.md"), GOOD);
    const { problems, linted } = checkAdrDir(d);
    assert.deepEqual(linted, ["0002-ok.md", "0003-bad.md", "0003-dup.md"]);
    assert.ok(problems.some((p) => p.startsWith("Bad_Name.md")));
    assert.ok(problems.some((p) => p.includes("trùng")));
    assert.ok(problems.some((p) => p.startsWith("0003-bad.md")));
    assert.ok(!problems.some((p) => p.startsWith("0001") || p.startsWith("0002")));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
