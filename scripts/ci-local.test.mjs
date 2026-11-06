import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gateCheckCommands } from "./ci-local.mjs";

test("chỉ lấy lệnh kiểm một dòng của job gate, dừng ở job kế tiếp", () => {
  const yml = [
    "jobs:",
    "  gate:",
    "    steps:",
    "      - run: bash .xtemplates/scripts/dev-task.sh gate-par",
    "      - run: |",
    "          echo nhiều dòng",
    "      - run: pnpm check:openapi",
    "      - run: node scripts/check-adr.mjs",
    "      - run: node --test scripts/a.test.mjs",
    "      - run: pnpm depcruise",
    "  e2e:",
    "    steps:",
    "      - run: pnpm check:khong-lay",
  ].join("\n");
  assert.deepEqual(gateCheckCommands(yml), [
    "pnpm check:openapi",
    "node scripts/check-adr.mjs",
    "node --test scripts/a.test.mjs",
    "pnpm depcruise",
  ]);
});

test("không có job gate → rỗng", () => {
  assert.deepEqual(gateCheckCommands("jobs:\n  build:\n    steps: []\n"), []);
});

test("ci.yml thật: có check-fixtures, check:schema, depcruise", () => {
  const cmds = gateCheckCommands(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  for (const want of ["node scripts/check-fixtures.mjs", "pnpm check:schema", "pnpm depcruise"])
    assert.ok(cmds.includes(want), `thiếu ${want}`);
});
