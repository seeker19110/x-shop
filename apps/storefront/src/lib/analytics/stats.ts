const LOG_EVERY = 100;

const counts = new Map<string, number>();
let seen = 0;
let rejected = 0;

/** Chỉ tổng hợp (đếm theo sự kiện) — không log nội dung từng yêu cầu. `null` = bị từ chối. */
export function recordEvent(event: string | null): void {
  seen += 1;
  if (event) counts.set(event, (counts.get(event) ?? 0) + 1);
  else rejected += 1;
  // eslint-disable-next-line no-console -- bộ đếm thống kê định kỳ có chủ đích, không phải log debug
  if (seen % LOG_EVERY === 0) console.info("[analytics]", JSON.stringify(analyticsStats()));
}

export function analyticsStats() {
  return { seen, rejected, byEvent: Object.fromEntries(counts) };
}

/** Chỉ cho test. */
export function resetAnalyticsStats(): void {
  counts.clear();
  seen = 0;
  rejected = 0;
}
