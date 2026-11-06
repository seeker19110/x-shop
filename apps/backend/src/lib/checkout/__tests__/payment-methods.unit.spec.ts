import { readFileSync } from "node:fs";
import path from "node:path";
import { CHECKOUT_PAYMENT_METHODS, checkoutSubmitRequestSchema } from "@x-shop/domain/validation";
import { PAYMENT_METHODS } from "../../../modules/checkout/models/constants";

/**
 * Hàng rào (T-188): phương thức thanh toán có ba nơi phải khớp — schema form chung (`@x-shop/domain/validation`, client
 * + route), hằng của module checkout (model DSL) và lược đồ DB đã migrate. Hằng module LẤY từ domain (một nguồn). DB
 * đối chiếu qua `.snapshot-checkout.json` (MikroORM ghi lại sau MỖI migration — trạng thái cuối, không phải văn bản
 * migration cũ vốn không sửa được): thêm phương thức mà quên migration → snapshot lệch → đỏ.
 */
const SNAPSHOT = path.resolve(__dirname, "../../../modules/checkout/migrations/.snapshot-checkout.json");
const PAYMENT_TABLES = ["checkout_attempt", "checkout_quote", "order_finance"];

interface Snapshot {
  tables: Array<{ name: string; columns: Record<string, { enumItems?: string[] }> }>;
}

/** Bảng → `enumItems` của cột `payment_method` (bảng không có cột → không xuất hiện). */
function paymentEnumsOf(snapshot: Snapshot): Record<string, string[] | undefined> {
  return Object.fromEntries(
    snapshot.tables
      .filter((t) => t.columns.payment_method !== undefined)
      .map((t) => [t.name, t.columns.payment_method!.enumItems]),
  );
}

describe("PAYMENT_METHODS: một nguồn với schema chung", () => {
  it("hằng module checkout chính là CHECKOUT_PAYMENT_METHODS của domain", () => {
    expect(PAYMENT_METHODS).toBe(CHECKOUT_PAYMENT_METHODS);
    expect([...PAYMENT_METHODS]).toEqual(["cod", "vnpay"]);
  });

  it("schema submit chấp nhận đúng các phương thức đó, từ chối giá trị lạ", () => {
    const shape = checkoutSubmitRequestSchema.def.shape.payment_method;
    for (const m of PAYMENT_METHODS) expect(shape.safeParse(m).success).toBe(true);
    for (const bad of ["momo", "COD", "", null]) expect(shape.safeParse(bad).success).toBe(false);
  });

  it("snapshot DB của module checkout: cột payment_method ở cả 3 bảng có enumItems = PAYMENT_METHODS", () => {
    const enums = paymentEnumsOf(JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot);
    expect(Object.keys(enums).sort()).toEqual(PAYMENT_TABLES);
    for (const table of PAYMENT_TABLES) {
      expect({ table, items: enums[table] }).toEqual({ table, items: [...PAYMENT_METHODS] });
    }
  });

  it("bộ đọc snapshot bắt lệch: thiếu/thừa phương thức hoặc thiếu enumItems ở một bảng", () => {
    const snap = (items: Array<string[] | undefined>): Snapshot => ({
      tables: PAYMENT_TABLES.map((name, i) => ({
        name,
        columns: { id: {}, payment_method: items[i] === undefined ? {} : { enumItems: items[i] } },
      })),
    });
    const ok = paymentEnumsOf(
      snap([
        ["cod", "vnpay"],
        ["cod", "vnpay"],
        ["cod", "vnpay"],
      ]),
    );
    expect(PAYMENT_TABLES.map((t) => ok[t])).toEqual(PAYMENT_TABLES.map(() => [...PAYMENT_METHODS]));
    const bad = paymentEnumsOf(snap([["cod"], ["cod", "vnpay", "momo"], undefined]));
    expect(
      PAYMENT_TABLES.filter((t) => JSON.stringify(bad[t]) === JSON.stringify([...PAYMENT_METHODS])),
    ).toEqual([]);
  });
});
