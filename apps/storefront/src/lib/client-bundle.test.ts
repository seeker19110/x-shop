// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hàng rào ngân sách JS (đặc tả §10.2): `@x-shop/domain` kéo ~139 KiB gzip (mã crypto của provider) nếu một client
 * component import GIÁ TRỊ từ nó. Quét mọi file "use client" và các file nó import tương đối (dừng ở ranh giới "use server"): chỉ cho `import type`.
 * Ngoại lệ duy nhất (Q-03, FE-FORM-001): subpath thuần `@x-shop/domain/validation` — schema form dùng chung với server;
 * đồ thị import của nó chỉ được gồm chính thư mục `validation/` và `zod/mini` (kiểm ở dưới).
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const e of ["", ...EXTS]) {
    try {
      const p = base + e;
      if (statSync(p).isFile()) return p;
    } catch {
      // thử đuôi kế tiếp
    }
  }
  return null;
}

const VALUE_IMPORT_FROM_DOMAIN =
  /import\s+(?!type\s)[^;]*?from\s+["']@x-shop\/domain(?!\/validation["'])[^"']*["']/;
const DOMAIN_VALIDATION = resolve(SRC, "../../../packages/domain/src/validation");
const BARE_IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^."'][^"']*)["']/g;

function clientGraph(): Set<string> {
  const roots = walk(SRC).filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // Server Actions ("use server") là ranh giới: client chỉ nhận stub RPC, không nhận mã bên trong (Next thay thế).
    if (/^\s*["']use server["']/.test(src)) continue;
    for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.[^"']*)["']/g)) {
      const dep = resolveImport(file, m[1]!);
      if (dep !== null) stack.push(dep);
    }
  }
  return seen;
}

describe("client bundle không kéo @x-shop/domain (catalog)", () => {
  const graph = clientGraph();

  it("quét được các client component (không rỗng)", () => {
    expect(graph.size).toBeGreaterThan(10);
  });

  it("không file nào trong đồ thị client import giá trị từ @x-shop/domain", () => {
    const offenders = [...graph].filter((f) => VALUE_IMPORT_FROM_DOMAIN.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.replace(SRC, "src"))).toEqual([]);
  });

  it("bộ nhận diện bắt đúng ca vi phạm và bỏ qua import type", () => {
    expect(VALUE_IMPORT_FROM_DOMAIN.test('import { formatVnd } from "@x-shop/domain";')).toBe(true);
    expect(VALUE_IMPORT_FROM_DOMAIN.test('import { a, type B } from "@x-shop/domain";')).toBe(true);
    expect(VALUE_IMPORT_FROM_DOMAIN.test('import type { B } from "@x-shop/domain";')).toBe(false);
    // Subpath: chỉ `validation` được phép; subpath khác (kể cả tiền tố giống) vẫn là vi phạm.
    expect(VALUE_IMPORT_FROM_DOMAIN.test('import { a } from "@x-shop/domain/validation";')).toBe(false);
    expect(VALUE_IMPORT_FROM_DOMAIN.test('import { a } from "@x-shop/domain/ledger";')).toBe(true);
    expect(VALUE_IMPORT_FROM_DOMAIN.test('import { a } from "@x-shop/domain/validation2";')).toBe(true);
    expect(VALUE_IMPORT_FROM_DOMAIN.test('import { a } from "@x-shop/domain/validation/x";')).toBe(true);
  });
});

describe("client bundle chỉ kéo @x-shop/domain/validation (FE-FORM-001, Q-03)", () => {
  const graph = clientGraph();

  it("form checkout (client) import giá trị từ đúng module schema mà route backend dùng", () => {
    const users = [...graph].filter((f) =>
      /import\s+(?!type\s)[^;]*?from\s+["']@x-shop\/domain\/validation["']/.test(readFileSync(f, "utf8")),
    );
    expect(users.map((f) => f.replace(SRC, "src"))).toContain("src/lib/checkout/validate.ts");
    const backendRoutes = ["quote", "submit"].map((r) =>
      readFileSync(resolve(SRC, `../../backend/src/api/store/x/checkout/${r}/route.ts`), "utf8"),
    );
    for (const route of backendRoutes) expect(route).toMatch(/from "@x-shop\/domain\/validation"/);
  });

  it("đồ thị import của subpath validation: chỉ file trong validation/ và `zod/mini` (không tiền/sổ cái/trạng thái/node:*)", () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const unresolved: string[] = [];
    const stack = [resolve(DOMAIN_VALIDATION, "index.ts")];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:import|export)\s[^;]*?from\s+["'](\.[^"']*)["']/g)) {
        const dep = resolveImport(file, m[1]!.replace(/\.js$/, ""));
        if (dep === null) unresolved.push(`${file} → ${m[1]}`);
        else stack.push(dep);
      }
      for (const m of src.matchAll(BARE_IMPORT)) bare.add(m[1]!);
    }
    expect(unresolved).toEqual([]);
    expect([...seen].filter((f) => dirname(f) !== DOMAIN_VALIDATION)).toEqual([]);
    expect([...bare]).toEqual(["zod/mini"]);
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("package.json của domain trỏ subpath ./validation vào đúng thư mục (Next đọc dist, test đọc src)", () => {
    const pkg = JSON.parse(readFileSync(resolve(DOMAIN_VALIDATION, "../../package.json"), "utf8")) as {
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.exports["./validation"]).toMatchObject({
      "@x-shop/source": "./src/validation/index.ts",
      default: "./dist/validation/index.js",
    });
  });
});
