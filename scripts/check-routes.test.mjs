import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverRoutes, main, parseRoutesDoc, validate } from "./check-routes.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function fixture(files, doc) {
  const root = mkdtempSync(join(tmpdir(), "routes-"));
  for (const f of files) {
    const p = join(root, "apps/storefront/src/app", f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "");
  }
  mkdirSync(join(root, "docs"), { recursive: true });
  if (doc !== null) writeFileSync(join(root, "docs/ROUTES.md"), doc);
  return root;
}
const row = (r, m = "stream động", why = "lý do") => `| \`${r}\` | f.tsx | ${m} | ${why} |\n`;

test("discoverRoutes: bỏ group, test, css; nhận route handler và metadata", () => {
  const root = fixture(
    [
      "page.tsx",
      "(shop)/gio-hang/page.tsx",
      "(shop)/a/[slug]/page.tsx",
      "api/x/route.ts",
      "robots.ts",
      "x.test.tsx",
      "g.css",
      "(shop)/a/a.test.tsx",
    ],
    "",
  );
  assert.deepEqual(discoverRoutes(join(root, "apps/storefront/src/app")), [
    "/",
    "/a/[slug]",
    "/api/x",
    "/gio-hang",
    "/robots.txt",
  ]);
});

test("parseRoutesDoc: đọc hàng, bỏ tiêu đề/dòng ngăn, hàng thiếu ô", () => {
  const rows = parseRoutesDoc(
    "| Route | Tệp | Chế độ | Lý do |\n| --- | --- | --- | --- |\n" +
      row("/a", "CSR", "vì sao") +
      "| `/b` | f |\n",
  );
  assert.deepEqual(rows, [
    { route: "/a", mode: "CSR", reason: "vì sao" },
    { route: "/b", mode: "", reason: "" },
  ]);
});

test("validate: khớp thì sạch", () => {
  assert.deepEqual(validate(["/a"], [{ route: "/a", mode: "tĩnh", reason: "x" }]), []);
});

test("validate: thiếu, thừa, trùng, chế độ sai, lý do rỗng", () => {
  const errs = validate(
    ["/a", "/b"],
    [
      { route: "/a", mode: "nhanh", reason: "" },
      { route: "/a", mode: "tĩnh", reason: "x" },
      { route: "/c", mode: "CSR", reason: "x" },
    ],
  );
  const all = errs.join("\n");
  assert.match(all, /trùng trong bảng: \/a/);
  assert.match(all, /\/a: chế độ "nhanh"/);
  assert.match(all, /\/a: thiếu lý do/);
  assert.match(all, /\/c: có trong bảng nhưng không có/);
  assert.match(all, /\/b: có trong app\/ nhưng thiếu/);
});

test("validate: tập rỗng cả hai phía là hợp lệ", () => {
  assert.deepEqual(validate([], []), []);
});

test("main: 0 khi khớp, 1 khi lệch, 2 khi thiếu tệp tài liệu", () => {
  assert.equal(main(fixture(["page.tsx"], row("/"))), 0);
  assert.equal(main(fixture(["page.tsx", "x/page.tsx"], row("/"))), 1);
  assert.equal(main(fixture(["page.tsx"], null)), 2);
});

test("main: lý do Unicode vẫn đọc đúng", () => {
  assert.equal(
    main(fixture(["(shop)/giao-hang/page.tsx"], row("/giao-hang", "stream động", "Chính sách — đã kiểm"))),
    0,
  );
});

test("repo thật: docs/ROUTES.md khớp cây app/ (exit 0)", () => {
  const r = spawnSync("node", [join(here, "check-routes.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
