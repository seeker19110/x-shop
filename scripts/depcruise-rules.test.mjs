// Khoá luật của .dependency-cruiser.cjs: dựng cây tạm giống cấu trúc repo, chạy depcruise thật và kiểm luật bắt đúng.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "node_modules/.bin/depcruise");
const config = join(root, ".dependency-cruiser.cjs");
const M = "apps/backend/src/modules";

/** Chạy depcruise trên cây tạm; trả danh sách "luật: nguồn → đích" vi phạm. */
function cruise(files) {
  const dir = mkdtempSync(join(tmpdir(), "depcruise-"));
  for (const [f, body] of Object.entries(files)) {
    const p = join(dir, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  const r = spawnSync(bin, ["apps", "--config", config, "--output-type", "json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.ok(r.stdout, r.stderr);
  const out = JSON.parse(r.stdout);
  return out.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();
}

test("không vi phạm: import trong cùng module, từ ngoài vào index/service/constants, ngoại lệ đã khai", () => {
  const v = cruise({
    [`${M}/a/index.ts`]: 'import "./service";\nimport "./models/m";\nexport {};',
    [`${M}/a/service.ts`]: "export {};",
    [`${M}/a/constants.ts`]: "export {};",
    [`${M}/a/models/m.ts`]: "export {};",
    [`${M}/b/index.ts`]: 'import "../a";\nimport "../a/service";\nexport {};',
    [`${M}/fashion/validators.ts`]: "export {};",
    "apps/backend/src/lib/x.ts":
      'import "../modules/a";\nimport "../modules/a/constants";\nimport "../modules/fashion/validators";\nexport {};',
    "apps/backend/src/modules/a/__tests__/t.spec.ts": 'import "../models/m";\nexport {};',
  });
  assert.deepEqual(v, []);
});

test("module A import nội bộ của module B bị chặn (ARC-MOD-005)", () => {
  const v = cruise({
    [`${M}/a/index.ts`]: 'import "../b/models/secret";\nexport {};',
    [`${M}/b/models/secret.ts`]: "export {};",
  });
  assert.deepEqual(v, [`module-no-cross-module-internals: ${M}/a/index.ts -> ${M}/b/models/secret.ts`]);
});

test("code ngoài modules/ import nội bộ module bị chặn (ARC-MOD-005)", () => {
  const v = cruise({
    "apps/backend/src/api/r.ts":
      'import "../modules/a/migrations/Migration1";\nimport "../modules/a/helper";\nexport {};',
    [`${M}/a/migrations/Migration1.ts`]: "export {};",
    [`${M}/a/helper.ts`]: "export {};",
  });
  assert.deepEqual(v, [
    `outside-module-internals: apps/backend/src/api/r.ts -> ${M}/a/helper.ts`,
    `outside-module-internals: apps/backend/src/api/r.ts -> ${M}/a/migrations/Migration1.ts`,
  ]);
});

test("test tích hợp được nạp migration nhưng không được nạp helper nội bộ", () => {
  const v = cruise({
    "apps/backend/integration-tests/t.spec.ts":
      'import "../src/modules/a/migrations/Migration20260101000000";\nimport "../src/modules/a/helper";\nexport {};',
    [`${M}/a/migrations/Migration20260101000000.ts`]: "export {};",
    [`${M}/a/helper.ts`]: "export {};",
  });
  assert.deepEqual(v, [
    `tests-module-internals: apps/backend/integration-tests/t.spec.ts -> ${M}/a/helper.ts`,
  ]);
});

test("vòng phụ thuộc bị chặn (ARC-MOD-004), kể cả vòng dài; vòng giữa model DML cùng module được miễn", () => {
  const cyc = cruise({
    "apps/backend/src/lib/p.ts": 'import "./q";\nexport {};',
    "apps/backend/src/lib/q.ts": 'import "./r";\nexport {};',
    "apps/backend/src/lib/r.ts": 'import "./p";\nexport {};',
  });
  assert.ok(cyc.length >= 1 && cyc.every((x) => x.startsWith("no-circular:")), cyc.join("\n"));

  const dml = cruise({
    [`${M}/a/models/x.ts`]: 'import "./y";\nexport {};',
    [`${M}/a/models/y.ts`]: 'import "./x";\nexport {};',
  });
  assert.deepEqual(dml, []);
});

test("vòng chỉ-kiểu (import type) vẫn bị tính", () => {
  const v = cruise({
    "apps/backend/src/lib/p.ts": 'import type { Q } from "./q";\nexport type P = Q;',
    "apps/backend/src/lib/q.ts": 'import type { P } from "./p";\nexport type Q = P;',
  });
  assert.ok(
    v.some((x) => x.startsWith("no-circular:")),
    v.join("\n"),
  );
});
