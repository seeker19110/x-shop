import { CheckoutError } from "../../checkout/errors";
import { classify } from "../../checkout/submit";
import { toHttpProblem } from "../../errors/error-handler";
import { INVENTORY_GUARD_CONSTRAINT, isInventoryGuardViolation } from "../guard";

/** Hình lỗi `pg` thật (đã quan sát ở test tích hợp inventory-guard: module gọi trực tiếp). */
const pgError = () =>
  Object.assign(
    new Error(
      `COMMIT; - ${INVENTORY_GUARD_CONSTRAINT}: inventory_level ilev_1 stocked_quantity=0 reserved_quantity=1 (cần 0 <= reserved <= stocked)`,
    ),
    {
      name: "error",
      severity: "ERROR",
      code: "23514",
      constraint: INVENTORY_GUARD_CONSTRAINT,
      table: undefined,
      routine: "exec_stmt_raise",
    },
  );

describe("isInventoryGuardViolation (T-185)", () => {
  it("lỗi pg gốc (code 23514 + constraint) → true", () => {
    expect(isInventoryGuardViolation(pgError())).toBe(true);
  });

  it("lỗi đã tuần tự hoá qua workflow (object thường, giữ thuộc tính) → true", () => {
    const e = pgError();
    const serialized = { message: e.message, name: e.name, code: e.code, constraint: e.constraint };
    expect(isInventoryGuardViolation(serialized)).toBe(true);
  });

  it("mất `constraint`, còn thông điệp do trigger soạn → true; lồng trong cause/previous/errors[] → true", () => {
    const bare = { message: pgError().message };
    expect(isInventoryGuardViolation(bare)).toBe(true);
    expect(isInventoryGuardViolation(new Error("bọc", { cause: pgError() }))).toBe(true);
    expect(isInventoryGuardViolation({ previous: bare })).toBe(true);
    expect(isInventoryGuardViolation({ errors: [{ error: bare }] })).toBe(true);
  });

  it("23514 của ràng buộc khác, constraint trùng tên nhưng code khác, thông điệp chỉ nhắc tên không có dấu `:` → false", () => {
    expect(isInventoryGuardViolation({ code: "23514", constraint: "payment_ledger_state_check" })).toBe(
      false,
    );
    expect(isInventoryGuardViolation({ code: "23505", constraint: INVENTORY_GUARD_CONSTRAINT })).toBe(false);
    expect(isInventoryGuardViolation({ message: `ràng buộc ${INVENTORY_GUARD_CONSTRAINT} đã gỡ` })).toBe(
      false,
    );
  });

  it("ca biên: null/undefined/0/chuỗi/mảng rỗng/cấu trúc vòng/lồng quá sâu → false, không treo", () => {
    for (const v of [null, undefined, 0, "", pgError().message, [], {}])
      expect(isInventoryGuardViolation(v)).toBe(false);
    const cyclic: Record<string, unknown> = { message: "x" };
    cyclic.cause = cyclic;
    expect(isInventoryGuardViolation(cyclic)).toBe(false);
    let deep: Record<string, unknown> = { message: pgError().message };
    for (let i = 0; i < 20; i++) deep = { cause: deep };
    expect(isInventoryGuardViolation(deep)).toBe(false);
  });
});

describe("ánh xạ vi phạm hàng rào tồn → lỗi nghiệp vụ (T-185)", () => {
  it("checkout classify → INSUFFICIENT_STOCK (409), không INTERNAL", () => {
    const c = classify(pgError());
    expect(c).toBeInstanceOf(CheckoutError);
    expect({ code: c.code, status: c.status }).toEqual({ code: "INSUFFICIENT_STOCK", status: 409 });
    // Đối chứng: 23514 khác vẫn là lỗi hệ thống.
    expect(classify({ code: "23514", constraint: "khac" }).code).toBe("INTERNAL");
  });

  it("handler toàn cục → 409 INSUFFICIENT_STOCK, không lộ id/số lượng/tên ràng buộc", () => {
    const p = toHttpProblem(pgError(), "trace-1");
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("INSUFFICIENT_STOCK");
    expect(JSON.stringify(p.body)).not.toMatch(/ilev_|stocked_quantity|reserved_quantity|x_inventory|COMMIT/);
    // Đối chứng: lỗi Postgres khác vẫn 500 chung.
    expect(toHttpProblem({ code: "23514", constraint: "khac", severity: "ERROR" }, "t").status).toBe(500);
  });
});
