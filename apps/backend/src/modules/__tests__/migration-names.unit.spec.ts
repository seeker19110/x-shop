import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Hàng rào (T-091): Medusa ghi migration đã chạy vào MỘT bảng `mikro_orm_migrations` dùng chung mọi module (cả module
 * native của Medusa) theo TÊN — hai migration trùng tên → cái thứ hai bị coi là đã chạy và bỏ qua âm thầm (bản đầu của
 * migration audit T-091 trùng tên với module fashion: cột `outcome` không được tạo, test tích hợp đỏ "column does not
 * exist"). Kiểm: tên lớp = tên file, duy nhất giữa các module của dự án, không trùng migration native trong node_modules.
 *
 * Tập file giống cách MikroORM nạp (`migrations/` — mẫu `!(*.d).{js,ts,cjs}`): mọi `.ts/.js/.cjs` trừ `.d.ts`.
 */
const MODULES = join(__dirname, "..");
const LOADED = /^(?!.*\.d\.[cm]?[jt]s$).+\.(js|ts|cjs)$/;
const nameOf = (file: string) => file.replace(/\.(js|ts|cjs)$/, "");

interface Found {
  module: string;
  file: string;
  klass: string | null;
}

function projectMigrations(): Found[] {
  const out: Found[] = [];
  for (const mod of readdirSync(MODULES, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const dir = join(MODULES, mod.name, "migrations");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => LOADED.test(f))) {
      const klass = /export class (\w+) extends Migration/.exec(readFileSync(join(dir, file), "utf8"));
      out.push({ module: mod.name, file, klass: klass?.[1] ?? null });
    }
  }
  return out;
}

/** Migration native của các gói `@medusajs/*` (pnpm gom symlink mọi gói ở `node_modules/.pnpm/node_modules`). */
function nativeMigrationNames(): Map<string, string> {
  const roots = [
    join(__dirname, "../../../../../node_modules/.pnpm/node_modules/@medusajs"),
    join(__dirname, "../../../node_modules/@medusajs"),
  ].filter((d) => existsSync(d));
  const names = new Map<string, string>();
  for (const root of roots) {
    for (const pkg of readdirSync(root)) {
      const dir = join(root, pkg, "dist", "migrations");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => LOADED.test(x) && !x.endsWith(".map"))) {
        names.set(nameOf(f), `@medusajs/${pkg}`);
      }
    }
  }
  return names;
}

describe("tên migration (bảng mikro_orm_migrations dùng chung)", () => {
  const all = projectMigrations();
  const native = nativeMigrationNames();

  it("có migration để kiểm (đường dẫn đúng) — dự án và native", () => {
    expect(all.length).toBeGreaterThan(5);
    expect(native.size).toBeGreaterThan(20);
  });

  it("tên lớp = tên file", () => {
    for (const m of all) expect({ ...m, klass: m.klass }).toEqual({ ...m, klass: nameOf(m.file) });
  });

  it("tên duy nhất giữa các module của dự án và không trùng migration native của Medusa", () => {
    const seen = new Map<string, string>(native);
    const dup: string[] = [];
    for (const m of all) {
      const name = nameOf(m.file);
      const prev = seen.get(name);
      if (prev !== undefined) dup.push(`${name}: ${prev} + ${m.module}`);
      seen.set(name, m.module);
    }
    expect(dup).toEqual([]);
  });
});
