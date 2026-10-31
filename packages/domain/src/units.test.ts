import { describe, expect, it } from "vitest";
import {
  BYTES_PER_GIB,
  BYTES_PER_KIB,
  BYTES_PER_MIB,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  bytesToKib,
  bytesToMib,
  daysToMs,
  hoursToMs,
  kibToBytes,
  mibToBytes,
  minutesToMs,
  msToSeconds,
  msToSecondsCeil,
  msToSecondsFloor,
  secondsToMs,
} from "./units.js";

describe("units — hằng khoá giá trị cũ (không đổi hành vi so với số viết tay)", () => {
  it("thời gian", () => {
    expect(MS_PER_SECOND).toBe(1000);
    expect(MS_PER_MINUTE).toBe(60 * 1000);
    expect(MS_PER_HOUR).toBe(3600 * 1000);
    expect(MS_PER_DAY).toBe(24 * 3600 * 1000);
    expect(SECONDS_PER_HOUR).toBe(3600);
    expect(SECONDS_PER_DAY).toBe(86_400);
  });
  it("dung lượng nhị phân", () => {
    expect(BYTES_PER_KIB).toBe(1024);
    expect(BYTES_PER_MIB).toBe(1024 * 1024);
    expect(BYTES_PER_GIB).toBe(1024 * 1024 * 1024);
  });
  it("giá trị cấu hình quan trọng bằng đúng số cũ", () => {
    expect(minutesToMs(10)).toBe(10 * 60 * 1000); // TTL cache region storefront
    expect(mibToBytes(5)).toBe(5 * 1024 * 1024); // upload: maxFileBytes
    expect(mibToBytes(20)).toBe(20 * 1024 * 1024); // upload: maxRequestBytes
    expect(mibToBytes(2)).toBe(2_097_152); // import catalog
    expect(mibToBytes(1)).toBe(1_048_576); // file đối soát
    expect(kibToBytes(64)).toBe(65_536);
    expect(kibToBytes(8)).toBe(8192);
    expect(secondsToMs(60)).toBe(60_000); // cửa sổ rate limit mặc định
    expect(secondsToMs(900)).toBe(900_000);
  });
});

describe("units — hàm chuyển đổi", () => {
  it("giây/giờ/ngày → ms", () => {
    expect(secondsToMs(1.5)).toBe(1500);
    expect(hoursToMs(2)).toBe(7_200_000);
    expect(daysToMs(1)).toBe(86_400_000);
  });
  it("ca biên 0, âm, NaN, Infinity", () => {
    expect(secondsToMs(0)).toBe(0);
    expect(msToSecondsCeil(0)).toBe(0);
    expect(msToSecondsFloor(-1)).toBe(-1); // floor về phía -∞ như Math.floor cũ
    expect(msToSecondsCeil(-999)).toBe(-0);
    expect(secondsToMs(Number.NaN)).toBeNaN();
    expect(secondsToMs(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
  it("ms → giây: làm tròn đúng chiều", () => {
    expect(msToSeconds(1500)).toBe(1.5);
    expect(msToSecondsCeil(1)).toBe(1);
    expect(msToSecondsCeil(1000)).toBe(1);
    expect(msToSecondsCeil(1001)).toBe(2);
    expect(msToSecondsFloor(1999)).toBe(1);
    expect(msToSecondsFloor(2000)).toBe(2);
  });
  it("byte ↔ KiB/MiB", () => {
    expect(bytesToKib(1536)).toBe(1.5);
    expect(bytesToMib(2 * 1024 * 1024)).toBe(2);
    expect(Math.round(bytesToMib(mibToBytes(2)))).toBe(2);
    expect(mibToBytes(0)).toBe(0);
  });
});
