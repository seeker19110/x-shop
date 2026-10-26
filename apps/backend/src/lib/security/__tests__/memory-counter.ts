import type { RateCounter } from "../rate-limit";
import { sampleAt, windowStartMs, type WindowSample } from "../sliding-window";

/**
 * Bộ đếm trong bộ nhớ, cùng ngữ nghĩa với `hitRateCounter`/`peekRateCounter` (Postgres): lưu theo cửa sổ cố định theo
 * đồng hồ; `hit` tăng cửa sổ hiện tại rồi trả số SAU khi tăng + số của cửa sổ liền trước (một bước, không xen kẽ).
 */
export class MemoryCounter implements RateCounter {
  readonly data = new Map<string, number>();
  private key(bucket: string, windowMs: number, startMs: number) {
    return `${bucket}@${startMs / windowMs}`;
  }
  private sample(bucket: string, windowMs: number, now: Date): WindowSample {
    const start = windowStartMs(windowMs, now.getTime());
    const counts = {
      current: this.data.get(this.key(bucket, windowMs, start)) ?? 0,
      previous: this.data.get(this.key(bucket, windowMs, start - windowMs)) ?? 0,
    };
    return sampleAt(counts, windowMs, now);
  }
  async hit(bucket: string, windowMs: number, now: Date): Promise<WindowSample> {
    await Promise.resolve(); // nhường lượt như I/O thật — lộ race nếu bên gọi "đọc rồi tăng"
    const k = this.key(bucket, windowMs, windowStartMs(windowMs, now.getTime()));
    this.data.set(k, (this.data.get(k) ?? 0) + 1);
    return this.sample(bucket, windowMs, now);
  }
  async peek(bucket: string, windowMs: number, now: Date): Promise<WindowSample> {
    return this.sample(bucket, windowMs, now);
  }
}
