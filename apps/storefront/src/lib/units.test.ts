// @vitest-environment node
import * as domain from "@x-shop/domain";
import { describe, expect, it } from "vitest";
import * as local from "./units";

describe("units (bản sao storefront)", () => {
  it("giống hệt packages/domain/src/units.ts: cùng tên export, cùng giá trị, cùng kết quả hàm", () => {
    const names = Object.keys(local).sort();
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) {
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
