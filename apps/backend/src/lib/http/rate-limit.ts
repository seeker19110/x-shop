/**
 * Giới hạn tần suất nhẹ trong bộ nhớ tiến trình (cửa sổ cố định theo khóa). Dùng cho webhook công khai để chặn dội
 * request rẻ tiền; không thay cho giới hạn ở edge/proxy. Mỗi instance đếm riêng.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** true = cho qua. */
  allow(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || now - cur.windowStart >= this.windowMs) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      this.hits.set(key, { windowStart: now, count: 1 });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (now - v.windowStart >= this.windowMs) this.hits.delete(k);
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}
