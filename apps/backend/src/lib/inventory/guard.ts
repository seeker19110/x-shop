/**
 * Nhận dạng lỗi của hàng rào tồn kho phía DB (T-185, IND-ECOM-001): constraint trigger `DEFERRABLE INITIALLY DEFERRED`
 * trên `inventory_level` (migration checkout Migration20261028150000) từ chối lúc COMMIT khi một dòng còn sống không giữ
 * `0 <= reserved_quantity <= stocked_quantity`, với SQLSTATE `23514`, `constraint` = tên dưới đây và thông điệp bắt đầu
 * bằng tên đó.
 *
 * Lỗi tới tay mã ứng dụng ở nhiều hình: lỗi `pg` gốc, `DriverException` của MikroORM (chép thuộc tính của lỗi gốc), lỗi
 * workflow đã tuần tự hoá (serializeError giữ thuộc tính riêng, có thể lồng `cause`), mảng `errors`. Hàm dò theo chiều
 * sâu có trần (không vòng vô hạn với cấu trúc vòng) — chỉ dựa vào tên ràng buộc, không dựa vào văn bản tiếng Anh.
 *
 * Tên PHẢI khớp chuỗi trong migration (migration đã áp không đổi theo mã; đổi tên → migration MỚI).
 */
export const INVENTORY_GUARD_CONSTRAINT = "x_inventory_level_stock_guard";
const CHECK_VIOLATION = "23514";
const MAX_DEPTH = 6;

const MESSAGE_MARK = `${INVENTORY_GUARD_CONSTRAINT}:`;

function matches(v: Record<string, unknown>): boolean {
  if (v.constraint === INVENTORY_GUARD_CONSTRAINT && (v.code === undefined || v.code === CHECK_VIOLATION))
    return true;
  // Bọc lại (MikroORM/workflow) có thể mất `constraint` nhưng giữ thông điệp gốc do trigger soạn.
  return typeof v.message === "string" && v.message.includes(MESSAGE_MARK);
}

/** true nếu `error` (hoặc lỗi lồng trong nó) là vi phạm hàng rào tồn kho phía DB. */
export function isInventoryGuardViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((x) => walk(x, depth + 1));
    const v = value as Record<string, unknown>;
    if (matches(v)) return true;
    return ["cause", "previous", "error", "errors", "originalError"].some((k) => walk(v[k], depth + 1));
  };
  return walk(error, 0);
}
