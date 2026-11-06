import { currentLogContext, runWithLogContext } from "../../src/lib/log/logger";

/** Số lời gọi tách theo việc có nằm trong ngữ cảnh của phép đo đang chạy hay không. */
export interface ScopedCounts {
  /** Lời gọi nằm trong ngữ cảnh (request HTTP / `measureInProcess`) của phép đo đang chạy. */
  inRequest: number;
  /** Mọi lời gọi còn lại: job nền, code của test, hoặc lúc không đo. */
  outside: number;
}

export interface ScopedCounter {
  counter: ScopedCounts;
  spy: jest.SpyInstance;
}

/**
 * Đếm lời gọi hàm chỉ tính phần thuộc request đang đo (T-229).
 *
 * Spy gắn trên service/`node:crypto` dùng chung cả tiến trình: job nền (outbox-dispatch mỗi 10 s đọc
 * `listOrderFinances({ order_id })` + `hitRateCounter("breaker.budget:…")` cho sự kiện `order.placed_pending` của
 * chính đơn vừa đặt, catalog-index-drain đọc `query.graph`) chạy chồng lên request thì đếm lẫn → CI 24d227c nhận
 * `find: 2`. Chỉ đếm lời gọi nằm TRONG ngữ cảnh của request đang đo: middleware `requestLogContext` mở
 * AsyncLocalStorage với `trace_id` = `x-request-id` (lib/log/http.ts); lời gọi ngoài request (job, test) không mang
 * `trace_id` đó. Ngữ cảnh mất → đếm 0 → `find: 1` đỏ.
 * Giới hạn: việc của request mà chạy trong ngữ cảnh tạo NGOÀI request (worker/queue/singleflight dùng chung) sẽ bị
 * tính vào `outside` → rò kiểu đó lọt. Đường tra cứu hiện không có mẫu này; đưa vào thì phải đổi cách đo.
 *
 * Dùng: một `createCountScope` mỗi phép đo; `counter(...)` trước, rồi bọc request trong `measure(traceId, fn)` với
 * header `x-request-id: traceId`, hoặc gọi code trong tiến trình bằng `measureInProcess(fn)`. Một scope chỉ đo một
 * phép tại một thời điểm (không lồng/song song). Nhớ `jest.restoreAllMocks()` sau test.
 */
export function createCountScope(prefix = "scoped") {
  let seq = 0;
  let measuring: string | null = null;
  const counters: ScopedCounter[] = [];

  const counter = <T extends object>(target: T, method: keyof T & string): ScopedCounter => {
    const host = target as unknown as Record<string, (...args: unknown[]) => unknown>;
    // Hàm đã bị spy (spec tự giả lỗi trước) thì xếp lớp đếm lên cài đặt đang chạy: `spyOn` lần hai trả CHÍNH spy cũ,
    // lấy nó làm "hàm gốc" sẽ gọi đệ quy vô hạn. `mockRestore` của spy cũ vẫn trả hàm thật.
    const existing = jest.isMockFunction(host[method]) ? (host[method] as jest.Mock) : undefined;
    const original: (...args: unknown[]) => unknown = existing?.getMockImplementation() ?? host[method]!;
    const counts: ScopedCounts = { inRequest: 0, outside: 0 };
    const spy = jest.spyOn(host, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (measuring !== null && currentLogContext()?.trace_id === measuring) counts.inRequest += 1;
      else counts.outside += 1;
      return original.apply(this, args);
    });
    const entry = { counter: counts, spy };
    counters.push(entry);
    return entry;
  };

  const nextTraceId = (): string => `${prefix}-${process.pid}-${++seq}`;

  /** Đặt các bộ đếm về 0 (gọi đầu mỗi phép đo). */
  const reset = (): void => {
    for (const { counter: c } of counters) Object.assign(c, { inRequest: 0, outside: 0 });
  };

  /** Chạy `fn` (gửi request mang `x-request-id: traceId`) với phép đo bật; luôn tắt khi xong, kể cả khi ném lỗi. */
  const measure = async <R>(traceId: string, fn: () => Promise<R>): Promise<R> => {
    reset();
    measuring = traceId;
    try {
      return await fn();
    } finally {
      measuring = null;
    }
  };

  /** Như `measure` nhưng cho code gọi thẳng trong tiến trình: tự mở ngữ cảnh log mang trace id của phép đo. */
  const measureInProcess = <R>(fn: () => Promise<R>): Promise<R> => {
    const traceId = nextTraceId();
    return measure(traceId, () => runWithLogContext({ trace_id: traceId }, fn));
  };

  const outsideCalls = (): number => counters.reduce((n, x) => n + x.counter.outside, 0);

  return { counter, nextTraceId, reset, measure, measureInProcess, outsideCalls };
}

export type CountScope = ReturnType<typeof createCountScope>;
