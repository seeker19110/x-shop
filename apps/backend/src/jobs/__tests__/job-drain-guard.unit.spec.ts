import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * T-171/D-081: rào tĩnh — mọi job trong `src/jobs/*.ts` phải chốt `isDraining()` ở đầu hàm mặc định, hoặc nằm trong
 * danh sách ngoại lệ kèm lý do. Job mới quên chốt → đỏ; mục ngoại lệ thừa (file không còn / đã có chốt) → đỏ.
 */

/** tên file (không đuôi) → lý do job cần chạy cả khi đang tắt. */
const DRAIN_EXEMPT: Record<string, string> = {};

const JOBS_DIR = join(__dirname, "..");
const files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
const name = (f: string) => f.replace(/\.ts$/, "");
const GUARD = /^if \(isDraining\(\)\) return;?$/;

/** Câu lệnh đầu tiên trong thân hàm mặc định (bỏ khoảng trắng và comment); null nếu không có hàm mặc định. */
function firstStatement(src: string): string | null {
  const m = /export default (?:async )?function\s*\w*\s*\([^)]*\)[^{]*\{/.exec(src);
  if (!m) return null;
  const body = src.slice(m.index + m[0].length);
  const stripped = body.replace(/^(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return (stripped.split("\n")[0] ?? "").trim();
}

describe("rào tĩnh: job định kỳ kiểm isDraining() lúc bắt đầu", () => {
  it("có job để kiểm (không quét rỗng)", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files.map((f) => [f]))("%s: isDraining() ở đầu hàm mặc định hoặc nằm trong ngoại lệ", (f) => {
    if (name(f) in DRAIN_EXEMPT) return;
    const src = readFileSync(join(JOBS_DIR, f), "utf8");
    expect(src).toMatch(/import \{[^}]*\bisDraining\b[^}]*\} from "\.\.\/lib\/lifecycle\/shutdown"/);
    expect(firstStatement(src)).toMatch(GUARD);
  });

  it("ngoại lệ không thừa: có lý do, file tồn tại và thực sự không có chốt", () => {
    for (const [n, reason] of Object.entries(DRAIN_EXEMPT)) {
      expect(reason.trim()).not.toBe("");
      const f = files.find((x) => name(x) === n);
      expect(f).toBeDefined();
      expect(firstStatement(readFileSync(join(JOBS_DIR, f!), "utf8"))).not.toMatch(GUARD);
    }
  });
});
