import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compare, docKeys, main, schemaKeys } from "./check-env-doc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const quiet = () => {
  const out = { log: [], error: [] };
  return { out, io: { log: (m) => out.log.push(m), error: (m) => out.error.push(m) } };
};

const BACKEND = `const x = 1;
const baseSchema = z.object({
  NODE_ENV: z.string(),
  // COMMENTED_KEY: z.string(),
  DATABASE_URL: z.string(),
});
const other = z.object({
  NOT_IN_SCHEMA: z.string(),
});
`;
const STORE_OK = `export const clientEnvSchema = z.object({
  NEXT_PUBLIC_SITE_URL: httpUrl,
});
export const serverEnvSchema = z.object({
  MEDUSA_BACKEND_URL: httpUrl,
  XS_MEDIA_URL: z.string().optional(),
});
`;
const DOC_OK = [
  "# Env",
  "```dotenv",
  "NODE_ENV=development",
  "DATABASE_URL=postgres://x",
  "# XS_MEDIA_URL=https://m.example",
  "NEXT_PUBLIC_SITE_URL=http://localhost:3000",
  "MEDUSA_BACKEND_URL=http://localhost:9000",
  "```",
  "",
].join("\n");

function fixture({ doc = DOC_OK, allowlist, backend = BACKEND, storefront = STORE_OK } = {}) {
  const root = mkdtempSync(join(tmpdir(), "env-doc-"));
  for (const [rel, text] of [
    ["apps/backend/src/lib/env/index.ts", backend],
    ["apps/storefront/src/lib/env/index.ts", storefront],
    ["docs/ops/ENV.md", doc],
  ]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  if (allowlist !== undefined) {
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/env-doc-allowlist.json"), JSON.stringify(allowlist));
  }
  return root;
}

test("schemaKeys: chỉ lấy khoá của khối được chọn, bỏ chú thích", () => {
  const { keys, missing } = schemaKeys(BACKEND, ["baseSchema"]);
  assert.deepEqual([...keys].sort(), ["DATABASE_URL", "NODE_ENV"]);
  assert.deepEqual(missing, []);
  assert.deepEqual(schemaKeys(BACKEND, ["noSuch"]).missing, ["noSuch"]);
});

test("docKeys: chỉ khối dotenv; nhận cả dòng chú thích `# KEY=`", () => {
  const md =
    "```bash\nXS_TEST=1\n```\n```dotenv\nA_B=1\n# C_D=2   # ghi chú\n# prose line = x\nlower=1\n```\nE_F=3\n";
  assert.deepEqual([...docKeys(md)].sort(), ["A_B", "C_D"]);
  assert.equal(docKeys("").size, 0);
});

test("compare: khớp → không lỗi; thiếu doc / thừa doc → lỗi nêu tên khoá", () => {
  const s = new Set(["A", "B"]);
  assert.deepEqual(compare({ schema: s, doc: new Set(["A", "B"]) }), []);
  assert.match(compare({ schema: s, doc: new Set(["A"]) })[0], /^B: .*thiếu ở docs/);
  assert.match(compare({ schema: s, doc: new Set(["A", "B", "Z"]) })[0], /^Z: .*không có ở schema/);
});

test("compare: allowlist cho phép thừa doc / thiếu doc; thiếu lý do hoặc mục mục nát → lỗi", () => {
  const s = new Set(["A"]);
  assert.deepEqual(
    compare({ schema: s, doc: new Set(["A", "Z"]), allowlist: { doc: { Z: "biến của Next" } } }),
    [],
  );
  assert.deepEqual(compare({ schema: s, doc: new Set(), allowlist: { schema: { A: "nội bộ" } } }), []);
  assert.match(
    compare({ schema: s, doc: new Set(["A", "Z"]), allowlist: { doc: { Z: " " } } })[0],
    /thiếu lý do/,
  );
  assert.match(
    compare({ schema: s, doc: new Set(["A"]), allowlist: { doc: { Z: "x" } } })[0],
    /không còn ở doc/,
  );
  assert.match(
    compare({ schema: s, doc: new Set(["A"]), allowlist: { doc: { A: "x" } } })[0],
    /đã có ở schema/,
  );
  assert.match(
    compare({ schema: s, doc: new Set(["A"]), allowlist: { schema: { A: "x" } } })[0],
    /đã có ở doc/,
  );
  assert.match(
    compare({ schema: s, doc: new Set(["A"]), allowlist: { schema: { Q: "x" } } })[0],
    /không còn ở schema/,
  );
});

test("main: khớp → 0", () => {
  const { io, out } = quiet();
  assert.equal(main(["--root", fixture()], io), 0);
  assert.match(out.log[0], /OK/);
});

test("main: schema có khoá thiếu ở doc → 1", () => {
  const { io, out } = quiet();
  const doc = DOC_OK.replace("DATABASE_URL=postgres://x\n", "");
  assert.equal(main(["--root", fixture({ doc })], io), 1);
  assert.ok(out.error.some((l) => l.includes("DATABASE_URL")));
});

test("main: doc thừa khoá không có ở schema → 1; allowlist có lý do → 0", () => {
  const doc = DOC_OK.replace("```\n", "PORT=9000\n```\n");
  const a = quiet();
  assert.equal(main(["--root", fixture({ doc })], a.io), 1);
  assert.ok(a.out.error.some((l) => l.includes("PORT")));
  const b = quiet();
  assert.equal(main(["--root", fixture({ doc, allowlist: { doc: { PORT: "Medusa đọc PORT" } } })], b.io), 0);
});

test("main: đầu vào hỏng (thiếu doc / thiếu khối schema / doc rỗng) → 2", () => {
  const quietIo = quiet().io;
  assert.equal(main(["--root", join(tmpdir(), "env-doc-khong-ton-tai")], quietIo), 2);
  assert.equal(main(["--root", fixture({ storefront: "export const a = 1;\n" })], quietIo), 2);
  assert.equal(main(["--root", fixture({ doc: "# trống\n" })], quietIo), 2);
});

test("main: repo thật khớp (BASE-CFG-003)", () => {
  const { io, out } = quiet();
  assert.equal(main(["--root", join(here, "..")], io), 0, out.error.join("\n"));
});
