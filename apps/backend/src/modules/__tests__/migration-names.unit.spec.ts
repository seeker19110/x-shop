import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Hàng rào (T-091): Medusa ghi migration đã chạy theo TÊN lớp, không theo module. Hai module có migration trùng tên →
 * migration thứ hai bị coi là đã chạy và bỏ qua âm thầm (bản đầu của migration audit T-091 trùng tên với module fashion:
 * cột `outcome` không được tạo, test tích hợp đỏ "column does not exist"). Tên file và tên lớp phải khớp nhau và duy nhất.
 */
const MODULES = join(__dirname, "..");

function migrations(): { module: string; file: string; klass: string | null }[] {
  const out: { module: string; file: string; klass: string | null }[] = [];
  for (const mod of readdirSync(MODULES, { withFileTypes: true })) {
    if (!mod.isDirectory()) continue;
    const dir = join(MODULES, mod.name, "migrations");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => /^Migration\d+\.ts$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      const klass = /export class (Migration\d+) extends Migration/.exec(
        readFileSync(join(dir, file), "utf8"),
      );
      out.push({ module: mod.name, file, klass: klass?.[1] ?? null });
    }
  }
  return out;
}

describe("tên migration của các module", () => {
  const all = migrations();

  it("có migration để kiểm (đường dẫn đúng)", () => {
    expect(all.length).toBeGreaterThan(5);
  });

  it("tên lớp = tên file", () => {
    for (const m of all)
      expect({ ...m, klass: m.klass }).toEqual({ ...m, klass: m.file.replace(/\.ts$/, "") });
  });

  it("tên duy nhất trên mọi module", () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    for (const m of all) {
      const name = m.file.replace(/\.ts$/, "");
      const prev = seen.get(name);
      if (prev !== undefined) dup.push(`${name}: ${prev} + ${m.module}`);
      seen.set(name, m.module);
    }
    expect(dup).toEqual([]);
  });
});
