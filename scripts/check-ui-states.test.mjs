// Test cho scripts/check-ui-states.mjs (T-206) — chạy trên cây tạm.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { check, COMPONENTS_DIR, isDataComponent, statesIn } from "./check-ui-states.mjs";

const COMP = `"use client";\nexport function A() { fetch("/x"); return null; }\n`;
const full = (names = ["loading", "empty", "error", "success"]) =>
  names.map((n) => `it("${n}: hiển thị", () => {});`).join("\n");

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "uistates-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}
const C = COMPONENTS_DIR;

test("đủ 4 ca (cạnh file) → 0", () => {
  const root = tree({ [`${C}/a/A.tsx`]: COMP, [`${C}/a/A.states.test.tsx`]: full() });
  try {
    assert.equal(check(root).code, 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("đủ 4 ca trong __tests__ → 0", () => {
  const root = tree({ [`${C}/a/A.tsx`]: COMP, [`${C}/a/__tests__/A.states.test.tsx`]: full() });
  try {
    assert.equal(check(root).code, 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("thiếu ca → 1 và nêu ca thiếu", () => {
  const root = tree({
    [`${C}/a/A.tsx`]: COMP,
    [`${C}/a/A.states.test.tsx`]: full(["loading", "success"]) + `\nit.skip("error: bỏ", () => {});`,
  });
  try {
    const r = check(root);
    assert.equal(r.code, 1);
    assert.match(r.lines[0], /thiếu ca empty\/error/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("thiếu file test → 1", () => {
  const root = tree({ [`${C}/a/A.tsx`]: COMP });
  try {
    assert.equal(check(root).code, 1);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("allowlist có lý do → 0; không lý do/lý do ngắn → 2", () => {
  const f = `${C}/a/A.tsx`;
  const ok = tree({
    [f]: COMP,
    "scripts/ui-states-allowlist.json": JSON.stringify([
      { file: f, reason: "Thành phần tạm, sẽ xóa ở T-999 sau đợt này" },
    ]),
  });
  const bad = tree({ [f]: COMP, "scripts/ui-states-allowlist.json": JSON.stringify([{ file: f }]) });
  const short = tree({
    [f]: COMP,
    "scripts/ui-states-allowlist.json": JSON.stringify([{ file: f, reason: "tạm" }]),
  });
  try {
    assert.equal(check(ok).code, 0);
    assert.equal(check(bad).code, 2);
    assert.equal(check(short).code, 2);
  } finally {
    for (const r of [ok, bad, short]) rmSync(r, { recursive: true });
  }
});

test("allowlist trỏ file không còn là component dữ liệu → 1; JSON hỏng → 2; thiếu thư mục → 2", () => {
  const stale = tree({
    [`${C}/a/B.tsx`]: `export const B = () => null;`,
    "scripts/ui-states-allowlist.json": JSON.stringify([{ file: `${C}/a/B.tsx`, reason: "x".repeat(25) }]),
  });
  const broken = tree({ [`${C}/a/B.tsx`]: "", "scripts/ui-states-allowlist.json": "{" });
  const empty = tree({ "README.md": "" });
  try {
    assert.equal(check(stale).code, 1);
    assert.equal(check(broken).code, 2);
    assert.equal(check(empty).code, 2);
  } finally {
    for (const r of [stale, broken, empty]) rmSync(r, { recursive: true });
  }
});

test("isDataComponent: chặt — server component, chú thích, tên chứa 'fetch' không tính", () => {
  assert.equal(isDataComponent(COMP), true);
  assert.equal(isDataComponent(`"use client";\nawait fetchWithRetry("/x")`), true);
  assert.equal(isDataComponent(`export function A() { fetch("/x") }`), false); // không "use client"
  assert.equal(isDataComponent(`"use client";\n// fetch("/x")\n/* fetch("/y") */\nconst a = 1;`), false);
  assert.equal(
    isDataComponent(`"use client";\nprefetch("/x"); router.fetch("/y"); const refetch = () => refetch(1);`),
    false,
  );
  assert.equal(isDataComponent(`"use client";\nconst a = 1;`), false);
});

test("statesIn: nhận diện nguyên từ, bỏ qua skip/todo, không phân biệt hoa thường", () => {
  const s = statesIn(
    `it("Loading", ()=>{}); test('empty list', ()=>{}); it.todo("error"); it("unloading", ()=>{});`,
  );
  assert.deepEqual([...s].sort(), ["empty", "loading"]);
  assert.deepEqual([...statesIn("")], []);
});
