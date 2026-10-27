import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FixedWindowLimiter } from "../rate-limit";

/**
 * T-093 (RFC 6585 §4, BE-REL-003): 429 của chính ta luôn kèm `Retry-After`. Hàng rào tĩnh: mọi chỗ trả 429 trực tiếp
 * (`.status(429)`, `deny(res, 429, …)`) trong src phải đặt `Retry-After` trong 3 dòng ngay trước. 429 qua CheckoutError
 * (`sendProblem`) và handler toàn cục có test riêng.
 */
const SRC = join(__dirname, "..", "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" || name === "migrations" ? [] : walk(p);
    return p.endsWith(".ts") && !p.endsWith(".d.ts") ? [p] : [];
  });
}

describe("hàng rào: 429 trực tiếp luôn kèm Retry-After", () => {
  it("mọi `.status(429)` / `deny(res, 429` có setHeader Retry-After ngay trước", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\.status\(\s*429\s*\)|deny\(\s*res\s*,\s*429\b/.test(line)) return;
        sites += 1;
        const before = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        if (!/setHeader\(\s*["']Retry-After["']/.test(before))
          offenders.push(`${relative(SRC, file)}:${i + 1}`);
      });
    }
    expect(sites).toBeGreaterThanOrEqual(3); // ipn, ghn callback, admin guard — hàng rào không quét rỗng
    expect(offenders).toEqual([]);
  });
});

describe("FixedWindowLimiter.retryAfterSeconds", () => {
  it("giây còn lại tới hết cửa sổ, làm tròn lên, ≥ 1; khoá lạ → 1", () => {
    const l = new FixedWindowLimiter(1, 10_000);
    expect(l.allow("ip", 1_000)).toBe(true);
    expect(l.allow("ip", 1_500)).toBe(false);
    expect(l.retryAfterSeconds("ip", 1_500)).toBe(10); // 9,5 s → 10
    expect(l.retryAfterSeconds("ip", 10_999)).toBe(1);
    expect(l.retryAfterSeconds("ip", 11_000)).toBe(1); // cửa sổ đã hết: không trả 0
    expect(l.retryAfterSeconds("khác", 1_500)).toBe(1);
  });

  it("đồng thời: nhiều khoá bị chặn cùng lúc có giá trị độc lập theo cửa sổ của từng khoá", () => {
    const l = new FixedWindowLimiter(1, 10_000);
    l.allow("a", 0);
    l.allow("b", 4_000);
    l.allow("a", 5_000);
    l.allow("b", 5_000);
    expect([l.retryAfterSeconds("a", 5_000), l.retryAfterSeconds("b", 5_000)]).toEqual([5, 9]);
  });
});
