import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkImmutable, immutablePart, isFinal } from "./check-adr-immutable.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-adr-immutable.mjs");

const ADR = (status, extra = "") => `# ADR-0002 — Tiêu đề

## Trạng thái

${status}

## Bối cảnh

Đà Nẵng — Huế ✓
${extra}
## Quyết định

B.
`;

const BULLET = (status) => `# ADR-0001 — Cũ

- Trạng thái: ${status}
- Bối cảnh: x

## Quyết định
A.
`;

function repo() {
  const d = mkdtempSync(join(tmpdir(), "adr-imm-"));
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "pipe", encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(d, "docs/adr"), { recursive: true });
  return {
    d,
    g,
    write: (f, t) => writeFileSync(join(d, "docs/adr", f), t),
    commit: (m) => {
      g("add", "-A");
      g("commit", "-q", "-m", m);
    },
    done: () => rmSync(d, { recursive: true, force: true }),
  };
}

/** Dựng repo: base có 0001 (bullet, accepted) + 0002 (accepted) + 0003 (proposed); trả về r. */
function baseRepo() {
  const r = repo();
  r.write("0001-a.md", BULLET("Accepted (2026-10-24)"));
  r.write("0002-b.md", ADR("Accepted"));
  r.write("0003-c.md", ADR("Proposed"));
  r.commit("base");
  r.g("branch", "base");
  return r;
}

test("isFinal / immutablePart: nhận dạng Status ở ba kiểu, bỏ đúng phần được đổi", () => {
  assert.equal(isFinal(ADR("Accepted")), true);
  assert.equal(isFinal(ADR("Proposed")), false);
  assert.equal(isFinal(BULLET("Superseded by ADR-0004")), true);
  assert.equal(isFinal("---\nstatus: accepted\n---\n# x"), true);
  assert.equal(isFinal(""), false);
  assert.equal(isFinal(null), false);
  assert.equal(immutablePart(ADR("Accepted")), immutablePart(ADR("Superseded by ADR-0009")));
  assert.equal(immutablePart(ADR("Accepted").replace(/\n/g, "\r\n")), immutablePart(ADR("Accepted")));
  assert.notEqual(immutablePart(ADR("Accepted")), immutablePart(ADR("Accepted", "thêm\n")));
});

test("không đổi gì / chỉ đổi dòng Status và liên kết: đạt; chỉ ADR đã chốt được kiểm", () => {
  const r = baseRepo();
  try {
    r.write("0001-a.md", BULLET("Superseded by ADR-0004 (Accepted, 2026-10-24)"));
    r.write(
      "0002-b.md",
      ADR("Superseded by ADR-0004\n\nLinks: ADR-0004").replace(
        "## Bối cảnh",
        "- Links: ADR-0004\n\n## Bối cảnh",
      ),
    );
    r.write("0003-c.md", ADR("Proposed", "đổi tự do khi còn proposed\n"));
    r.commit("status");
    const { problems, checked } = checkImmutable({ cwd: r.d, base: "base" });
    assert.deepEqual(problems, []);
    assert.deepEqual(checked, ["docs/adr/0001-a.md", "docs/adr/0002-b.md"]);
  } finally {
    r.done();
  }
});

test("sửa nội dung ADR accepted (kể cả 1 ký tự Unicode): vi phạm", () => {
  const r = baseRepo();
  try {
    r.write("0002-b.md", ADR("Accepted").replace("Huế", "Hue"));
    r.commit("sửa");
    const { problems } = checkImmutable({ cwd: r.d, base: "base" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /0002-b\.md.*ngoài dòng Status/);
  } finally {
    r.done();
  }
});

test("xoá hoặc đổi tên ADR accepted: vi phạm", () => {
  const r = baseRepo();
  try {
    unlinkSync(join(r.d, "docs/adr/0002-b.md"));
    r.write("0002-renamed.md", ADR("Accepted"));
    r.commit("xoá");
    const { problems } = checkImmutable({ cwd: r.d, base: "base" });
    assert.ok(problems.some((p) => p.includes("0002-b.md") && p.includes("xoá")));
  } finally {
    r.done();
  }
});

test("gỡ Accepted về Proposed để sửa nội dung: vi phạm", () => {
  const r = baseRepo();
  try {
    r.write("0002-b.md", ADR("Proposed", "lách\n"));
    r.commit("lách");
    const { problems } = checkImmutable({ cwd: r.d, base: "base" });
    assert.ok(problems.some((p) => p.includes("không còn ở trạng thái đã chốt")));
    assert.ok(problems.some((p) => p.includes("ngoài dòng Status")));
  } finally {
    r.done();
  }
});

test("ADR mới được thêm: đạt", () => {
  const r = baseRepo();
  try {
    r.write("0004-new.md", ADR("Accepted").replace("0002", "0004"));
    r.commit("mới");
    assert.deepEqual(checkImmutable({ cwd: r.d, base: "base" }).problems, []);
  } finally {
    r.done();
  }
});

test("ref gốc không tồn tại: báo lỗi rõ; thư mục ADR rỗng ở base: đạt", () => {
  const r = repo();
  try {
    r.write("0001-a.md", ADR("Accepted"));
    r.commit("c1");
    const miss = checkImmutable({ cwd: r.d, base: "origin/nope" });
    assert.match(miss.problems[0], /không có trong repo/);
    unlinkSync(join(r.d, "docs/adr/0001-a.md"));
    r.write("x.txt", "x");
    r.commit("c2");
    assert.deepEqual(checkImmutable({ cwd: r.d, base: "HEAD" }), { problems: [], checked: [] });
  } finally {
    r.done();
  }
});

test("CLI: exit 1 khi vi phạm, 0 khi đạt; nhận --base và biến ADR_BASE_REF", () => {
  const r = baseRepo();
  try {
    const run = (args, env = {}) =>
      spawnSync("node", [SCRIPT, ...args], {
        cwd: r.d,
        encoding: "utf8",
        env: { ...process.env, ADR_BASE_REF: "", ...env },
      });
    assert.equal(run(["--base", "base"]).status, 0);
    r.write("0001-a.md", BULLET("Accepted").replace("A.", "B."));
    r.commit("sửa");
    const bad = run(["--base", "base"]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /0001-a\.md/);
    assert.equal(run([], { ADR_BASE_REF: "base" }).status, 1);
    assert.equal(run([]).status, 1); // mặc định origin/master không có → lỗi, không im lặng
  } finally {
    r.done();
  }
});
