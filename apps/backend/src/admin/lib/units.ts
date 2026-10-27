/**
 * Hằng/hàm đơn vị tập trung (XC-UNITS-009): không "số ma thuật" (`* 1000`, `/ 1024`) ngoài file này.
 * Thời gian: mili-giây là đơn vị nội bộ (`_ms`); giây (`_s`/`Seconds`) chỉ ở biên (HTTP `Retry-After`, Redis TTL, JWT `iat`/`exp`).
 * Dung lượng: nhị phân (1 KiB = 1024 byte) — đúng với giới hạn upload/body của hệ thống.
 * BẢN SAO của `packages/domain/src/units.ts` (bundle Admin không nạp được `@x-shop/domain`: index kéo `node:fs`,
 * `node:crypto`); `__tests__/units.unit.spec.ts` khoá hai bản giống nhau.
 */

export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
export const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;
export const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
export const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;
export const MS_PER_DAY = SECONDS_PER_DAY * MS_PER_SECOND;

export const BYTES_PER_KIB = 1024;
export const BYTES_PER_MIB = BYTES_PER_KIB * 1024;
export const BYTES_PER_GIB = BYTES_PER_MIB * 1024;

/** giây → mili-giây (giữ nguyên NaN/Infinity). */
export const secondsToMs = (seconds: number): number => seconds * MS_PER_SECOND;
export const minutesToMs = (minutes: number): number => minutes * MS_PER_MINUTE;
export const hoursToMs = (hours: number): number => hours * MS_PER_HOUR;
export const daysToMs = (days: number): number => days * MS_PER_DAY;

/** mili-giây → giây, không làm tròn (có thể ra số lẻ). */
export const msToSeconds = (ms: number): number => ms / MS_PER_SECOND;
/** mili-giây → giây, làm tròn lên (HTTP `Retry-After`, TTL: không bao giờ ngắn hơn thực tế). */
export const msToSecondsCeil = (ms: number): number => Math.ceil(ms / MS_PER_SECOND);
/** mili-giây → giây, làm tròn xuống (mốc `iat`/`exp` kiểu epoch giây). */
export const msToSecondsFloor = (ms: number): number => Math.floor(ms / MS_PER_SECOND);

export const kibToBytes = (kib: number): number => kib * BYTES_PER_KIB;
export const mibToBytes = (mib: number): number => mib * BYTES_PER_MIB;
/** byte → KiB / MiB, không làm tròn. */
export const bytesToKib = (bytes: number): number => bytes / BYTES_PER_KIB;
export const bytesToMib = (bytes: number): number => bytes / BYTES_PER_MIB;
