import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DISCREPANCY_KIND_LABELS } from "../../../admin/lib/labels";
import { OPS_EXCEPTION_KINDS } from "../../../modules/checkout/models/constants";
import { EXCEPTION_OWNER_ROLE } from "../../../modules/settlement/constants";
import { CATALOG_COMPENSATION_FAILED_KIND } from "../../../workflows/fashion/set-product-fashion";

/**
 * Hàng rào (T-156): danh sách kind ngoại lệ vận hành có bốn nơi phải khớp — `OPS_EXCEPTION_KINDS` (model/kiểu),
 * CHECK `ops_exception_kind_check` của migration MỚI NHẤT dựng lại nó (DB thật chặn kind lạ), owner mặc định
 * (`EXCEPTION_OWNER_ROLE`, dashboard "có owner") và nhãn admin. CHECK đã từng lệch một lần; thêm kind mà quên một nơi
 * là đỏ ở đây (bản DB thật: test `catalog-model` đọc `pg_constraint`).
 */
const modulesDir = path.resolve(__dirname, "../../../modules");

/** Tập giá trị của `add constraint "ops_exception_kind_check" check("kind" in (...))` đầu tiên (= `up()`) trong file. */
function checkKindsOf(source: string): string[] | null {
  const m = /add constraint "ops_exception_kind_check" check\("kind" in \(([^)]*)\)\)/.exec(source);
  if (m === null) return null;
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

function latestKindCheck(): { file: string; kinds: string[] } {
  const files = readdirSync(modulesDir).flatMap((mod) => {
    const dir = path.join(modulesDir, mod, "migrations");
    try {
      return readdirSync(dir)
        .filter((f) => /^Migration\d+\.ts$/.test(f))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  });
  const withCheck = files
    .map((file) => ({ file, kinds: checkKindsOf(readFileSync(file, "utf8")) }))
    .filter((x): x is { file: string; kinds: string[] } => x.kinds !== null)
    .sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
  const last = withCheck.at(-1);
  if (last === undefined) throw new Error("không thấy migration nào dựng ops_exception_kind_check");
  return last;
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("kind ngoại lệ vận hành khớp ở mọi nơi (hàng rào T-156)", () => {
  it("OPS_EXCEPTION_KINDS = CHECK của migration mới nhất (không thiếu, không thừa, không trùng)", () => {
    const { file, kinds } = latestKindCheck();
    expect({ file: path.basename(file), kinds: sorted(kinds) }).toEqual({
      file: path.basename(file),
      kinds: sorted(OPS_EXCEPTION_KINDS),
    });
    expect(new Set(OPS_EXCEPTION_KINDS).size).toBe(OPS_EXCEPTION_KINDS.length);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("mỗi kind có owner mặc định và nhãn admin tiếng Việt (không hiện mã thô)", () => {
    const blank = (v: string | undefined) => (v ?? "").trim() === "";
    expect(OPS_EXCEPTION_KINDS.filter((k) => blank(EXCEPTION_OWNER_ROLE[k]))).toEqual([]);
    expect(OPS_EXCEPTION_KINDS.filter((k) => blank(DISCREPANCY_KIND_LABELS[k]))).toEqual([]);
  });

  it("kind workflow catalog dùng nằm trong danh sách", () => {
    expect(OPS_EXCEPTION_KINDS).toContain(CATALOG_COMPENSATION_FAILED_KIND);
  });

  it("bộ đọc CHECK: lấy đúng up() (lần xuất hiện đầu), file không có CHECK → null", () => {
    const src = `add constraint "ops_exception_kind_check" check("kind" in ('a', 'b'));
      add constraint "ops_exception_kind_check" check("kind" in ('a'));`;
    expect(checkKindsOf(src)).toEqual(["a", "b"]);
    expect(checkKindsOf("alter table x add column y text;")).toBeNull();
  });
});
