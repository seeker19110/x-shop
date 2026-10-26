import { sanitizeChanges } from "../../audit/sanitize";
import type { ImportJobView } from "../import";
import { groupedHash, importAuditChanges } from "../import-audit";

const job = (over: Partial<ImportJobView> = {}): ImportJobView => ({
  import_id: "cimp_1",
  status: "previewed",
  // Băm có dãy "0" + 9 chữ số — trông như số điện thoại nếu để liền.
  file_hash: `ab0912345678cd${"e".repeat(50)}`,
  file_name: "khach-an-0912345678@example.vn.csv",
  summary: {
    rows_total: 3,
    rows_valid: 1,
    products_new: 1,
    products_existing: 0,
    variants_new: 1,
    variants_existing: 0,
  },
  errors: [
    { line: 2, column: "sku", message: "Thiếu SKU" },
    { line: 3, column: "title", message: 'Ô "=HYPERLINK(0912345678)" bắt đầu bằng =' },
    { line: 4, column: "sku", message: "SKU trùng" },
  ],
  result: null,
  previewed_by: "user_1",
  committed_by: null,
  committed_at: null,
  ...over,
});

describe("importAuditChanges (audit nhập CSV, che PII)", () => {
  it("chỉ số đếm + cột lỗi + băm file; không tên file, không thông điệp lỗi/giá trị ô", () => {
    const changes = sanitizeChanges(importAuditChanges(job()));
    expect(changes).toEqual({
      status: "previewed",
      file_sha256: groupedHash(job().file_hash),
      summary: job().summary,
      errors_count: 3,
      error_columns: ["sku", "title"],
    });
    const raw = JSON.stringify(changes);
    expect(raw).not.toContain("khach-an");
    expect(raw).not.toContain("HYPERLINK");
    expect(raw).not.toContain("@example.vn");
  });

  it("băm file đi qua bộ che PII nguyên vẹn (nhóm 8 ký tự), ghép lại đúng băm gốc", () => {
    const hash = job().file_hash;
    const masked = sanitizeChanges({ note: hash }).note as string;
    expect(masked).not.toBe(hash); // để liền thì bị che hỏng
    const grouped = sanitizeChanges({ file_sha256: groupedHash(hash) }).file_sha256 as string;
    expect(grouped.replace(/:/g, "")).toBe(hash);
    expect(groupedHash("")).toBe("");
  });

  it("commit: kết quả chỉ còn số đếm; lỗi truyền riêng (kiểm lại lúc commit) thay cho lỗi lúc preview", () => {
    const committed = job({
      status: "committed",
      errors: [],
      result: {
        products_created: ["prod_1", "prod_2"],
        products_updated: [],
        price_changes: [{ sku: "A", before: 1, after: 2 }],
        stock_changes: [],
      },
    });
    expect(importAuditChanges(committed)).toMatchObject({
      errors_count: 0,
      error_columns: [],
      result: { products_created: 2, products_updated: 0, price_changes: 1, stock_changes: 0 },
    });
    expect(
      importAuditChanges(job(), [{ line: 9, column: "category", message: "Không có danh mục" }]),
    ).toMatchObject({ errors_count: 1, error_columns: ["category"] });
    // Tối đa 20 cột.
    const many = Array.from({ length: 30 }, (_, i) => ({ line: i, column: `c${i}`, message: "x" }));
    expect(importAuditChanges(job(), many).error_columns).toHaveLength(20);
  });
});
