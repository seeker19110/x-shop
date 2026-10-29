import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CHECKOUT_PAYMENT_METHODS, checkoutSubmitRequestSchema } from "@x-shop/domain/validation";
import { PAYMENT_METHODS } from "../../../modules/checkout/models/constants";

/**
 * Hàng rào (T-188): phương thức thanh toán có ba nơi phải khớp — schema form chung (`@x-shop/domain/validation`, client
 * + route), hằng của module checkout (model DSL) và CHECK `payment_method` trong migration (DB thật chặn giá trị lạ).
 * Hằng module LẤY từ domain (một nguồn); CHECK của migration là văn bản cố định nên đối chiếu ở đây.
 */
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

  it("mọi CHECK payment_method trong migration checkout = cùng tập giá trị", () => {
    const dir = path.resolve(__dirname, "../../../modules/checkout/migrations");
    const checks = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .flatMap((f) => [
        ...readFileSync(path.join(dir, f), "utf8").matchAll(/check \("payment_method" in \(([^)]*)\)\)/g),
      ])
      .map((m) => [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort());
    expect(checks.length).toBeGreaterThan(0);
    for (const values of checks) expect(values).toEqual([...PAYMENT_METHODS].sort());
  });
});
