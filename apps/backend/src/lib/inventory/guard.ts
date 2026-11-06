/**
 * Nhận dạng lỗi của hàng rào tồn kho phía DB (T-185, IND-ECOM-001): constraint trigger `DEFERRABLE INITIALLY DEFERRED`
 * trên `inventory_level` và `reservation_item` (migration checkout Migration20261028150000) từ chối lúc COMMIT với
 * SQLSTATE `23514`, `constraint` = tên vế và thông điệp bắt đầu bằng `<tên vế>:`. Hai vế, hai nghĩa:
 *  - `stock` (`x_inventory_level_stock_guard`): reserved/stocked âm, reserved > stocked, hoặc tổng reservation_item còn
 *    sống > stocked (D-134) — hết hàng/không đủ tồn: 409 nghiệp vụ, thử lại không đổi kết quả.
 *  - `drift` (`x_inventory_reserved_drift`): reserved_quantity khác tổng reservation_item còn sống — một ghi đồng thời không
 *    qua khóa đã ghi đè số giữ (lost-update); ghi bị hủy, thử lại sẽ đọc số mới: 409 "xung đột, thử lại".
 *
 * Lỗi tới tay mã ứng dụng ở nhiều hình: lỗi `pg` gốc, `DriverException` của MikroORM (chép thuộc tính của lỗi gốc), lỗi
 * workflow đã tuần tự hoá (serializeError giữ thuộc tính riêng, có thể lồng `cause`), mảng `errors`. Hàm dò theo chiều
 * sâu có trần (không vòng vô hạn với cấu trúc vòng). Chỉ nhận khi CHÍNH đối tượng đó mang `code` = 23514 (lỗi Postgres
 * thật) — thông điệp lỗi khác tình cờ chứa tên ràng buộc (vd 404 chép id người gửi) không bị nhận nhầm.
 *
 * Tên PHẢI khớp chuỗi trong migration (migration đã áp không đổi theo mã; đổi tên → migration MỚI).
 */
export const INVENTORY_GUARD_CONSTRAINT = "x_inventory_level_stock_guard";
export const INVENTORY_DRIFT_CONSTRAINT = "x_inventory_reserved_drift";
/** Mã 409 cho vế `drift` ở route không có mã "thử lại" riêng (handler toàn cục, điều chỉnh tồn). */
export const INVENTORY_CONFLICT_RETRY = "INVENTORY_CONFLICT_RETRY";

export type InventoryGuardKind = "stock" | "drift";

const CHECK_VIOLATION = "23514";
const MAX_DEPTH = 6;
const KINDS: ReadonlyArray<[InventoryGuardKind, string]> = [
  ["stock", INVENTORY_GUARD_CONSTRAINT],
  ["drift", INVENTORY_DRIFT_CONSTRAINT],
];

function kindOf(v: Record<string, unknown>): InventoryGuardKind | null {
  if (v.code !== CHECK_VIOLATION) return null;
  for (const [kind, name] of KINDS) {
    if (v.constraint === name) return kind;
    // Bọc lại (MikroORM/workflow) có thể mất `constraint` nhưng giữ `code` và thông điệp gốc do trigger soạn.
    if (typeof v.message === "string" && v.message.includes(`${name}:`)) return kind;
  }
  return null;
}

/** Vế hàng rào tồn kho phía DB mà `error` (hoặc lỗi lồng trong nó) vi phạm; không phải lỗi hàng rào → null. */
export function inventoryGuardKind(error: unknown): InventoryGuardKind | null {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): InventoryGuardKind | null => {
    if (depth > MAX_DEPTH || typeof value !== "object" || value === null || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const x of value) {
        const k = walk(x, depth + 1);
        if (k) return k;
      }
      return null;
    }
    const v = value as Record<string, unknown>;
    const own = kindOf(v);
    if (own) return own;
    for (const key of ["cause", "previous", "error", "errors", "originalError"]) {
      const k = walk(v[key], depth + 1);
      if (k) return k;
    }
    return null;
  };
  return walk(error, 0);
}

/** true nếu `error` (hoặc lỗi lồng trong nó) vi phạm một vế bất kỳ của hàng rào tồn kho phía DB. */
export function isInventoryGuardViolation(error: unknown): boolean {
  return inventoryGuardKind(error) !== null;
}
