import { err, ok, type Result } from "@x-shop/domain";

// Backend là CommonJS, @x-shop/domain là ESM: kiểm import được (jest nạp src qua điều kiện @x-shop/source;
// runtime Node >= 22.12 nạp dist/index.js bằng require(esm); TypeScript >= 5.8 cho phép với module "nodenext").
describe("@x-shop/domain dùng được từ backend", () => {
  it("ok/err trả Result đúng hình", () => {
    const good: Result<number> = ok(0);
    const bad: Result<never, "VALIDATION"> = err("VALIDATION", "Thiếu số điện thoại", "phone");
    expect(good).toEqual({ ok: true, value: 0 });
    expect(bad).toEqual({ ok: false, code: "VALIDATION", message: "Thiếu số điện thoại", field: "phone" });
  });
});
