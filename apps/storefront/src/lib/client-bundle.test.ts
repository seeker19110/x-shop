// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Hàng rào ngân sách JS (đặc tả §10.2): `@x-shop/domain` kéo ~139 KiB gzip (mã crypto của provider) nếu một client
 * component import GIÁ TRỊ từ nó. Quét mọi file "use client" và các file nó import tương đối (dừng ở ranh giới "use server"): chỉ cho `import type`.
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

const VALUE_IMPORT_FROM_DOMAIN = /import\s+(?!type\s)[^;]*?from\s+["']@x-shop\/domain["']/;

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
  });
});
