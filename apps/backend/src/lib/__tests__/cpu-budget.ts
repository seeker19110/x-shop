/**
 * Hàng rào ReDoS chống nhiễu cho test đơn vị. CPU của tiến trình gồm cả GC nên lúc cổng tải nặng một lần đo từng lên
 * 108–168 ms dù chạy riêng chỉ ~3 ms. Nhiễu đó CỘNG gần như cố định vào mọi lần đo, còn backtracking thảm hoạ tăng ít
 * nhất bậc hai theo độ dài → đo xen kẽ n và n/4 (min 5 lần), chỉ đỏ khi vượt trần VÀ T(n)/T(n/4) ≥ 8 (tuyến tính ≈ 4,
 * bậc hai ≈ 16). Trần cứng 2 s bắt mọi trường hợp thảm hoạ dù nhiễu cỡ nào.
 */
export function expectLinearOrUnder(budgetMs: number, input: string, run: (s: string) => void): void {
  const cpuMs = (s: string) => {
    const t0 = process.cpuUsage();
    run(s);
    const d = process.cpuUsage(t0);
    return (d.user + d.system) / 1000;
  };
  run(input.slice(0, 100)); // làm nóng regex
  const quarterInput = input.slice(0, Math.ceil(input.length / 4));
  let full = Infinity;
  let quarter = Infinity;
  for (let i = 0; i < 5; i++) {
    quarter = Math.min(quarter, cpuMs(quarterInput));
    full = Math.min(full, cpuMs(input));
  }
  if (full >= budgetMs) expect(full / Math.max(quarter, 0.5)).toBeLessThan(8);
  expect(full).toBeLessThan(2_000);
}
