import { MedusaError } from "@medusajs/framework/utils";
import { CheckoutError } from "../../checkout/errors";
import { classify } from "../../checkout/submit";
import { toHttpProblem } from "../../errors/error-handler";
import {
  INVENTORY_CONFLICT_RETRY,
  INVENTORY_DRIFT_CONSTRAINT,
  INVENTORY_GUARD_CONSTRAINT,
  inventoryGuardKind,
  isInventoryGuardViolation,
} from "../guard";

/** Hình lỗi `pg` thật (đã quan sát ở test tích hợp inventory-guard: module gọi trực tiếp). */
const pgError = (constraint = INVENTORY_GUARD_CONSTRAINT) =>
  Object.assign(
    new Error(
      `COMMIT; - ${constraint}: inventory_level ilev_1 stocked_quantity=0 reserved_quantity=1 (cần 0 <= reserved <= stocked)`,
    ),
    {
      name: "error",
      severity: "ERROR",
      code: "23514",
      constraint,
      table: undefined,
      routine: "exec_stmt_raise",
    },
  );

describe("isInventoryGuardViolation / inventoryGuardKind (T-185)", () => {
  it("lỗi pg gốc (code 23514 + constraint) → stock / drift theo tên vế", () => {
    expect(isInventoryGuardViolation(pgError())).toBe(true);
    expect(inventoryGuardKind(pgError())).toBe("stock");
    expect(inventoryGuardKind(pgError(INVENTORY_DRIFT_CONSTRAINT))).toBe("drift");
  });

  it("lỗi đã tuần tự hoá qua workflow (object thường, giữ thuộc tính) → true", () => {
    const e = pgError();
    const serialized = { message: e.message, name: e.name, code: e.code, constraint: e.constraint };
    expect(isInventoryGuardViolation(serialized)).toBe(true);
  });

  it("mất `constraint` nhưng còn code 23514 + thông điệp do trigger soạn → nhận; lồng trong cause/previous/errors[] → nhận", () => {
    const bare = { code: "23514", message: pgError().message };
    expect(inventoryGuardKind(bare)).toBe("stock");
    expect(inventoryGuardKind({ code: "23514", message: pgError(INVENTORY_DRIFT_CONSTRAINT).message })).toBe(
      "drift",
    );
    expect(isInventoryGuardViolation(new Error("bọc", { cause: pgError() }))).toBe(true);
    expect(isInventoryGuardViolation({ previous: bare })).toBe(true);
    expect(isInventoryGuardViolation({ errors: [{ error: bare }] })).toBe(true);
  });

  it("chỉ nhận khi có code 23514: thông điệp chứa tên vế mà không có code (vd 404 chép id người gửi, RV-3) → false", () => {
    expect(isInventoryGuardViolation({ message: pgError().message })).toBe(false);
    const notFound = new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Product with id: ${INVENTORY_GUARD_CONSTRAINT}: was not found`,
    );
    expect(isInventoryGuardViolation(notFound)).toBe(false);
    expect(toHttpProblem(notFound, "t")).toMatchObject({ status: 404 });
  });

  it("23514 của ràng buộc khác, constraint trùng tên nhưng code khác, thông điệp chỉ nhắc tên không có dấu `:` → false", () => {
    expect(isInventoryGuardViolation({ code: "23514", constraint: "payment_ledger_state_check" })).toBe(
      false,
    );
    expect(isInventoryGuardViolation({ code: "23505", constraint: INVENTORY_GUARD_CONSTRAINT })).toBe(false);
    expect(
      isInventoryGuardViolation({ code: "23514", message: `ràng buộc ${INVENTORY_GUARD_CONSTRAINT} đã gỡ` }),
    ).toBe(false);
  });

  it("ca biên: null/undefined/0/chuỗi/mảng rỗng/cấu trúc vòng/lồng quá sâu → false, không treo", () => {
    for (const v of [null, undefined, 0, "", pgError().message, [], {}])
      expect(isInventoryGuardViolation(v)).toBe(false);
    const cyclic: Record<string, unknown> = { message: "x" };
    cyclic.cause = cyclic;
    expect(isInventoryGuardViolation(cyclic)).toBe(false);
    let deep: unknown = pgError();
    for (let i = 0; i < 20; i++) deep = { cause: deep };
    expect(isInventoryGuardViolation(deep)).toBe(false);
  });
});

describe("ánh xạ vi phạm hàng rào tồn → lỗi nghiệp vụ (T-185)", () => {
  it("checkout classify: stock → INSUFFICIENT_STOCK (409); drift → BUSY_RETRY (409, thử lại cùng khóa); không INTERNAL", () => {
    const c = classify(pgError());
    expect(c).toBeInstanceOf(CheckoutError);
    expect({ code: c.code, status: c.status }).toEqual({ code: "INSUFFICIENT_STOCK", status: 409 });
    const d = classify(pgError(INVENTORY_DRIFT_CONSTRAINT));
    expect({ code: d.code, status: d.status }).toEqual({ code: "BUSY_RETRY", status: 409 });
    // Đối chứng: 23514 khác vẫn là lỗi hệ thống.
    expect(classify({ code: "23514", constraint: "khac" }).code).toBe("INTERNAL");
  });

  it("handler toàn cục: stock → 409 INSUFFICIENT_STOCK; drift → 409 INVENTORY_CONFLICT_RETRY; không lộ id/số lượng/tên ràng buộc", () => {
    const p = toHttpProblem(pgError(), "trace-1");
    expect(p.status).toBe(409);
    expect(p.body.code).toBe("INSUFFICIENT_STOCK");
    expect(JSON.stringify(p.body)).not.toMatch(/ilev_|stocked_quantity|reserved_quantity|x_inventory|COMMIT/);
    const d = toHttpProblem(pgError(INVENTORY_DRIFT_CONSTRAINT), "trace-2");
    expect({ status: d.status, code: d.body.code }).toEqual({ status: 409, code: INVENTORY_CONFLICT_RETRY });
    expect(JSON.stringify(d.body)).not.toMatch(/ilev_|reserved_quantity|x_inventory|COMMIT/);
    // Đối chứng: lỗi Postgres khác vẫn 500 chung.
    expect(toHttpProblem({ code: "23514", constraint: "khac", severity: "ERROR" }, "t").status).toBe(500);
  });
});
