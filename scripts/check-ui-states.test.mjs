// Test cho scripts/check-ui-states.mjs (T-206) — chạy trên cây tạm.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { check, COMPONENTS_DIR, isDataComponent, statesIn, stripComments } from "./check-ui-states.mjs";

const COMP = `"use client";\nexport function A() { fetch("/x"); return null; }\n`;
const full = (names = ["loading", "empty", "error", "success"]) =>
  names.map((n) => `it("${n}: hiển thị", () => { expect(1).toBe(1); });`).join("\n");

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
  const b = "() => { expect(a).toBe(1); }";
  const s = statesIn(
    `it("Loading", ${b}); test('empty list', ${b}); it.todo("error"); it("unloading", ${b}); it.skip("success", ${b});`,
  );
  assert.deepEqual([...s].sort(), ["empty", "loading"]);
  assert.deepEqual([...statesIn("")], []);
});

test("statesIn: ca lách — thân rỗng / không expect / expect không matcher / expect nằm trong chú thích không tính", () => {
  const s = statesIn(
    [
      `it("loading", () => {});`,
      `it("empty", () => { doSomething(); });`,
      `it("error", () => { expect(a); });`,
      `it("success", () => { // expect(a).toBe(1)\n });`,
    ].join("\n"),
  );
  assert.deepEqual([...s], []);
});

test("statesIn: it.only/it.concurrent/it.each/test.* và thân async có dấu ngoặc lồng đều tính", () => {
  const s = statesIn(
    [
      `it.only("loading", async () => { expect(f(g(1))).toBe(1); });`,
      `it.concurrent("empty", () => { expect(a).toEqual({ x: [1] }); });`,
      `it.each([1, 2])("error %s", (n) => { expect(n).toBeTruthy(); });`,
      `test.sequential("success", () => { expect(a).toHaveLength(2); });`,
    ].join("\n"),
  );
  assert.deepEqual([...s].sort(), ["empty", "error", "loading", "success"]);
});

test("stripComments: regex literal chứa // không bị cắt dòng; // trong chuỗi giữ nguyên", () => {
  const src = `"use client";\nconst re = /https?:\\/\\//;\nfetch("/x"); const u = "http://a"; // chú thích`;
  const out = stripComments(src);
  assert.match(out, /fetch\("\/x"\)/);
  assert.match(out, /"http:\/\/a"/);
  assert.doesNotMatch(out, /chú thích/);
  assert.equal(isDataComponent(src), true);
});

test("isDataComponent: tiêu chí mở rộng — globalThis/window.fetch, import actions/retry, useActionState, use(", () => {
  assert.equal(isDataComponent(`"use client";\nglobalThis.fetch("/x")`), true);
  assert.equal(isDataComponent(`"use client";\nawait window.fetch("/x")`), true);
  assert.equal(isDataComponent(`"use client";\nimport { a } from "../../lib/cart/actions";`), true);
  assert.equal(isDataComponent(`"use client";\nimport { f } from "../../lib/http/retry";`), true);
  assert.equal(isDataComponent(`"use client";\nconst [s] = useActionState(a, 1);`), true);
  assert.equal(isDataComponent(`"use client";\nconst d = use(promise);`), true);
  assert.equal(
    isDataComponent(`"use client";\nimport { a } from "../../lib/format-vnd";\nreuse(1); focus(2);`),
    false,
  );
  // "use client" sau chú thích vẫn là chỉ thị; thiếu chỉ thị → không phải
  assert.equal(isDataComponent(`// ghi chú\n/* khối */\n"use client";\nfetch("/x")`), true);
  assert.equal(isDataComponent(`import x from "y";\n"use client";\nfetch("/x")`), false);
});

test("ca lách ở mức cây: tên đủ 4 từ khoá nhưng thân rỗng → 1", () => {
  const root = tree({
    [`${C}/a/A.tsx`]: COMP,
    [`${C}/a/A.states.test.tsx`]: ["loading", "empty", "error", "success"]
      .map((n) => `it("${n}", () => {});`)
      .join("\n"),
  });
  try {
    const r = check(root);
    assert.equal(r.code, 1);
    assert.match(
      r.lines[0],
      /thiếu ca empty\/error\/loading\/success|thiếu ca loading\/empty\/error\/success/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("hai vị trí test cùng tồn tại → hợp cả hai (đọc mọi file ứng viên)", () => {
  const root = tree({
    [`${C}/a/A.tsx`]: COMP,
    [`${C}/a/A.states.test.tsx`]: full(["loading", "empty"]),
    [`${C}/a/__tests__/A.states.test.tsx`]: full(["error", "success"]),
  });
  const partial = tree({
    [`${C}/a/A.tsx`]: COMP,
    [`${C}/a/A.states.test.tsx`]: full(["loading", "empty"]),
    [`${C}/a/__tests__/A.states.test.tsx`]: full(["error"]),
  });
  try {
    assert.equal(check(root).code, 0);
    const r = check(partial);
    assert.equal(r.code, 1);
    assert.match(r.lines[0], /thiếu ca success/);
  } finally {
    rmSync(root, { recursive: true });
    rmSync(partial, { recursive: true });
  }
});

test("component lọt vào nhờ tiêu chí mở rộng (import actions) cũng bị yêu cầu test", () => {
  const root = tree({
    [`${C}/o/Form.tsx`]: `"use client";\nimport { go } from "../../lib/orders/actions";\nexport const F = () => null;`,
  });
  try {
    const r = check(root);
    assert.equal(r.code, 1);
    assert.match(r.lines[0], /Form\.tsx: thiếu Form\.states\.test\.tsx/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
