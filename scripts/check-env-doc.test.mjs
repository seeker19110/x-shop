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
  NESTED: z.object({
    INNER_KEY: z.string(),
  }),
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
  "## Backend (`apps/backend/.env`)",
  "```dotenv",
  "NODE_ENV=development",
  "DATABASE_URL=postgres://x",
  "# NESTED=1",
  "```",
  "## Storefront (`apps/storefront/.env`)",
  "```dotenv",
  "NEXT_PUBLIC_SITE_URL=http://localhost:3000",
  "MEDUSA_BACKEND_URL=http://localhost:9000",
  "# XS_MEDIA_URL=https://m.example",
  "```",
  "## Khác",
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

const run = (opts) => {
  const { io, out } = quiet();
  const code = main(["--root", fixture(opts)], io);
  return { code, out };
};

test("schemaKeys: chỉ khoá thụt 2 ô của khối được chọn; bỏ chú thích và z.object lồng", () => {
  const { keys, missing } = schemaKeys(BACKEND, ["baseSchema"]);
  assert.deepEqual([...keys].sort(), ["DATABASE_URL", "NESTED", "NODE_ENV"]);
  assert.deepEqual(missing, []);
  assert.deepEqual(schemaKeys(BACKEND, ["noSuch"]).missing, ["noSuch"]);
});

test("schemaKeys: spread, khoá có nháy, .extend/.merge/.pick/.omit → ném lỗi (không đoán)", () => {
  const spread = BACKEND.replace("  DATABASE_URL: z.string(),", "  ...common.shape,");
  assert.throws(() => schemaKeys(spread, ["baseSchema"]), /spread/);
  const quoted = BACKEND.replace("  DATABASE_URL:", '  "DATABASE_URL":');
  assert.throws(() => schemaKeys(quoted, ["baseSchema"]), /nháy/);
  for (const m of ["extend", "merge", "pick", "omit"])
    assert.throws(
      () =>
        schemaKeys(`${BACKEND}\nexport const full = baseSchema.${m}({ X_Y: z.string() });\n`, ["baseSchema"]),
      /phân tích tĩnh/,
      m,
    );
});

test("docKeys: chỉ khối dotenv, nhóm theo mục Backend/Storefront; nhận `# KEY=`", () => {
  const md = [
    "```dotenv\nTOP_LEVEL=1\n```",
    "## Backend (x)",
    "```bash\nXS_TEST=1\n```",
    "```dotenv\nA_B=1\n# C_D=2   # ghi chú\n# prose line = x\nlower=1\n```",
    "E_F=3",
    "## Storefront",
    "```dotenv\nG_H=1\n```",
    "",
  ].join("\n");
  const d = docKeys(md);
  assert.deepEqual([...d.backend].sort(), ["A_B", "C_D"]);
  assert.deepEqual([...d.storefront], ["G_H"]);
  assert.deepEqual([...d.other], ["TOP_LEVEL"]);
  assert.equal(docKeys("").backend.size, 0);
});

test("compare: khớp → không lỗi; thiếu doc / thừa doc → lỗi nêu tên khoá", () => {
  const s = new Set(["A", "B"]);
  assert.deepEqual(compare({ schema: s, doc: new Set(["A", "B"]) }), []);
  assert.match(compare({ schema: s, doc: new Set(["A"]) })[0], /B: .*thiếu ở mục/);
  assert.match(compare({ schema: s, doc: new Set(["A", "B", "Z"]) })[0], /Z: .*không có ở schema/);
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
  const { code, out } = run({});
  assert.equal(code, 0);
  assert.match(out.log[0], /OK/);
});

test("main: schema có khoá thiếu ở doc → 1", () => {
  const { code, out } = run({ doc: DOC_OK.replace("DATABASE_URL=postgres://x\n", "") });
  assert.equal(code, 1);
  assert.ok(out.error.some((l) => l.includes("DATABASE_URL")));
});

test("main: doc thừa khoá không có ở schema → 1; allowlist có lý do → 0", () => {
  const doc = DOC_OK.replace("# NESTED=1\n", "# NESTED=1\nPORT=9000\n");
  const a = run({ doc });
  assert.equal(a.code, 1);
  assert.ok(a.out.error.some((l) => l.includes("PORT")));
  const b = run({ doc, allowlist: { backend: { doc: { PORT: "Medusa đọc PORT" } } } });
  assert.equal(b.code, 0);
});

test("main: so theo TỪNG app — xoá MEDUSA_BACKEND_URL khỏi mục Backend/Storefront thì đỏ dù app kia còn khoá", () => {
  const both = BACKEND.replace(
    "  DATABASE_URL: z.string(),",
    "  DATABASE_URL: z.string(),\n  MEDUSA_BACKEND_URL: z.string(),",
  );
  const doc = DOC_OK.replace("# NESTED=1\n", "# NESTED=1\nMEDUSA_BACKEND_URL=http://b\n");
  assert.equal(run({ backend: both, doc }).code, 0);
  const noBackend = run({ backend: both, doc: doc.replace("MEDUSA_BACKEND_URL=http://b\n", "") });
  assert.equal(noBackend.code, 1);
  assert.ok(noBackend.out.error.some((l) => l.includes("[backend] MEDUSA_BACKEND_URL")));
  const noStore = run({ backend: both, doc: doc.replace("MEDUSA_BACKEND_URL=http://localhost:9000\n", "") });
  assert.equal(noStore.code, 1);
  assert.ok(noStore.out.error.some((l) => l.includes("[storefront] MEDUSA_BACKEND_URL")));
});

test("main: khối dotenv ngoài mục Backend/Storefront → 1", () => {
  const { code, out } = run({ doc: `${DOC_OK}\`\`\`dotenv\nSTRAY=1\n\`\`\`\n` });
  assert.equal(code, 1);
  assert.ok(out.error.some((l) => l.includes("STRAY")));
});

test("main: schema dùng spread / nháy / .extend → 2 (không im lặng bỏ sót)", () => {
  assert.equal(
    run({ backend: BACKEND.replace("  DATABASE_URL: z.string(),", "  ...common.shape,") }).code,
    2,
  );
  assert.equal(run({ backend: BACKEND.replace("  DATABASE_URL:", '  "DATABASE_URL":') }).code, 2);
  assert.equal(
    run({ backend: `${BACKEND}\nexport const s2 = baseSchema.extend({ A_B: z.string() });\n` }).code,
    2,
  );
});

test("main: --keys-json in khoá schema theo app", () => {
  const { io, out } = quiet();
  assert.equal(main(["--root", fixture(), "--keys-json"], io), 0);
  const j = JSON.parse(out.log[0]);
  assert.deepEqual(j.backend, ["DATABASE_URL", "NESTED", "NODE_ENV"]);
  assert.deepEqual(j.storefront, ["MEDUSA_BACKEND_URL", "NEXT_PUBLIC_SITE_URL", "XS_MEDIA_URL"]);
});

test("main: đầu vào hỏng (thiếu doc / thiếu khối schema / mục doc rỗng) → 2", () => {
  const quietIo = quiet().io;
  assert.equal(main(["--root", join(tmpdir(), "env-doc-khong-ton-tai")], quietIo), 2);
  assert.equal(run({ storefront: "export const a = 1;\n" }).code, 2);
  assert.equal(run({ doc: "# trống\n" }).code, 2);
});

test("main: repo thật khớp (BASE-CFG-003)", () => {
  const { io, out } = quiet();
  assert.equal(main(["--root", join(here, "..")], io), 0, out.error.join("\n"));
});
