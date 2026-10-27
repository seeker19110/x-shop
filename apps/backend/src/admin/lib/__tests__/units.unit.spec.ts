import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as domain from "@x-shop/domain";
import * as local from "../units";

const DOMAIN_UNITS_SRC = resolve(__dirname, "../../../../../../packages/domain/src/units.ts");
const domainNames = [...readFileSync(DOMAIN_UNITS_SRC, "utf8").matchAll(/^export const (\w+)/gm)]
  .map((m) => m[1] as string)
  .sort();

// Bản sao Admin (bundle trình duyệt không nạp được @x-shop/domain) phải giống hệt bản domain.
describe("admin/lib/units — bản sao của packages/domain/src/units.ts", () => {
  it("tập tên export bằng đúng tập tên của domain (hai chiều)", () => {
    expect(domainNames.length).toBeGreaterThan(10);
    expect(Object.keys(local).sort()).toEqual(domainNames);
  });

  it("cùng giá trị và cùng kết quả hàm", () => {
    for (const n of domainNames) {
      const a = (local as Record<string, unknown>)[n];
      const b = (domain as Record<string, unknown>)[n];
      expect(typeof b).toBe(typeof a);
      if (typeof a === "number") expect(b).toBe(a);
      else if (typeof a === "function") {
        for (const x of [0, 1, 999, 1000, 1001, 1536, 86_400_000, -1, 2 * 1024 * 1024]) {
          expect((b as (v: number) => number)(x)).toBe((a as (v: number) => number)(x));
        }
      }
    }
  });
});
