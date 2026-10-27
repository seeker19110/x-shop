// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as domain from "@x-shop/domain";
import { describe, expect, it } from "vitest";
import * as local from "./units";

const DOMAIN_UNITS_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/domain/src/units.ts",
);
const domainNames = [...readFileSync(DOMAIN_UNITS_SRC, "utf8").matchAll(/^export const (\w+)/gm)]
  .map((m) => m[1]!)
  .sort();

describe("units (bản sao storefront)", () => {
  it("tập tên export bằng đúng tập tên của packages/domain/src/units.ts (hai chiều)", () => {
    expect(domainNames.length).toBeGreaterThan(10);
    expect(Object.keys(local).sort()).toEqual(domainNames);
  });
  it("cùng giá trị, cùng kết quả hàm với domain", () => {
    for (const n of domainNames) {
      const a = (local as Record<string, unknown>)[n];
      const b = (domain as Record<string, unknown>)[n];
      expect(typeof b, n).toBe(typeof a);
      if (typeof a === "number") expect(b, n).toBe(a);
      else if (typeof a === "function") {
        for (const x of [0, 1, 999, 1000, 1001, 1536, 86_400_000, -1]) {
          expect((b as (v: number) => number)(x), `${n}(${x})`).toBe((a as (v: number) => number)(x));
        }
      }
    }
  });
  it("giá trị cấu hình đã thay số ma thuật vẫn đúng số cũ", () => {
    expect(local.minutesToMs(10)).toBe(600_000); // REGION_TTL_MS
    expect(local.kibToBytes(8)).toBe(8192); // MAX_BODY_BYTES analytics
    expect(local.secondsToMs(2)).toBe(2000); // Retry-After: 2
    expect(local.SECONDS_PER_HOUR).toBe(3600); // maxAge cookie mặc định
    expect(local.SECONDS_PER_MINUTE).toBe(60); // maxAge cookie tối thiểu
    expect(local.msToSecondsFloor(61_999)).toBe(61);
  });
});
