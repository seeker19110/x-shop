import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAdrDir, lintAdr, supersededBy } from "./check-adr.mjs";

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

test("thư mục: áp mọi số kể cả 0001; bắt tên sai, số trùng, ADR thiếu; Unicode trong nội dung ổn", () => {
  const d = mkdtempSync(join(tmpdir(), "adr-"));
  try {
    writeFileSync(join(d, "0001-stack.md"), "# cũ, không heading\n");
    writeFileSync(join(d, "0002-ok.md"), GOOD + "\nĐà Nẵng — Huế ✓\n");
    writeFileSync(join(d, "0003-bad.md"), "# thiếu\n");
    writeFileSync(join(d, "0003-dup.md"), GOOD);
    writeFileSync(join(d, "Bad_Name.md"), GOOD);
    const { problems, linted } = checkAdrDir(d);
    assert.deepEqual(linted, ["0001-stack.md", "0002-ok.md", "0003-bad.md", "0003-dup.md"]);
    assert.ok(problems.some((p) => p.startsWith("Bad_Name.md")));
    assert.ok(problems.some((p) => p.includes("trùng")));
    assert.ok(problems.some((p) => p.startsWith("0003-bad.md")));
    assert.ok(problems.some((p) => p.startsWith("0001-stack.md")));
    assert.ok(!problems.some((p) => p.startsWith("0002")));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("ADR superseded được miễn heading chỉ khi ADR đích thật sự thay lại và tự đạt", () => {
  const d = mkdtempSync(join(tmpdir(), "adr-"));
  const old = "# ADR-0001\n\n- Trạng thái: Superseded by ADR-0002 (Accepted)\n";
  const NEW = GOOD.replace("## Trạng thái\nAccepted", "## Trạng thái\nAccepted\n\nSupersedes ADR-0001");
  const run = (files) => {
    for (const f of readdirSync(d)) rmSync(join(d, f));
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
    return checkAdrDir(d);
  };
  try {
    const ok = run({ "0001-stack.md": old, "0002-new.md": NEW });
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.linted, ["0002-new.md"]);
    // trỏ tới số không có
    assert.ok(
      run({ "0001-stack.md": old.replace("ADR-0002", "ADR-0009"), "0002-new.md": NEW }).problems.some((p) =>
        p.includes("không có ADR số 0009"),
      ),
    );
    // trỏ vào chính mình / số nhỏ hơn
    assert.ok(
      run({ "0001-stack.md": old.replace("ADR-0002", "ADR-0001"), "0002-new.md": NEW }).problems.some((p) =>
        p.includes("số lớn hơn"),
      ),
    );
    // đích không tuyên bố supersedes ngược lại
    assert.ok(
      run({ "0001-stack.md": old, "0002-new.md": GOOD }).problems.some((p) =>
        p.includes('"Supersedes ADR-0001"'),
      ),
    );
    // đích thiếu heading → cả hai đỏ
    const bad = run({
      "0001-stack.md": old,
      "0002-new.md": "# thiếu\n\n## Trạng thái\nSupersedes ADR-0001\n",
    }).problems;
    assert.ok(bad.some((p) => p.startsWith("0002-new.md")) && bad.some((p) => p.includes("không đạt")));
    // lối lách: ADR mới chỉ có một dòng Status superseded, không heading
    const evade = run({
      "0001-stack.md": "# ADR-0001\n\n- Status: Accepted\n",
      "0005-evade.md": "# x\n\n- Status: Superseded by ADR-0002\n",
      "0002-new.md": NEW,
    });
    assert.ok(evade.problems.some((p) => p.startsWith("0005-evade.md")));
    // hai ADR trỏ superseded lẫn nhau
    const loop = run({
      "0001-stack.md": "# a\n\n- Status: Superseded by ADR-0002\nSupersedes ADR-0002\n",
      "0002-new.md": "# b\n\n- Status: Superseded by ADR-0001\nSupersedes ADR-0001\n",
    });
    assert.ok(loop.problems.length >= 1);
    // chuỗi 0001 -> 0002 -> 0003 hợp lệ
    const chain = run({
      "0001-stack.md": old,
      "0002-new.md": GOOD.replace(
        "## Trạng thái\nAccepted",
        "## Trạng thái\nSuperseded by ADR-0003\n\nSupersedes ADR-0001",
      ),
      "0003-c.md": GOOD.replace("## Trạng thái\nAccepted", "## Trạng thái\nAccepted\n\nThay ADR-0002"),
    });
    assert.deepEqual(chain.problems, []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("supersededBy: chỉ đọc trong mục Status, không đọc thân bài; null/rỗng ổn", () => {
  assert.equal(supersededBy("## Trạng thái\nSuperseded by ADR-0007\n"), "0007");
  assert.equal(supersededBy("---\nstatus: superseded by ADR-0012\n---\n# x"), "0012");
  assert.equal(
    supersededBy("## Trạng thái\nAccepted\n\n## Bối cảnh\nThay vì Superseded by ADR-0003 ..."),
    null,
  );
  // chỉ khối Status ĐẦU TIÊN được tính
  assert.equal(
    supersededBy("## Trạng thái\nAccepted\n\n## Bối cảnh\n\n## Status\nSuperseded by ADR-0003\n"),
    null,
  );
  assert.equal(supersededBy(""), null);
  assert.equal(supersededBy(null), null);
});
