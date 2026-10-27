/**
 * Backoff kiểm lại theo đơn của job `expire-holds` (T-164 — nghẽn đầu hàng, review T-161 REPRO-B).
 *
 * Đơn quá hạn giữ hàng mà querydr chưa cho kết quả rõ (`unknown`: mã 91, chữ ký sai, hết giờ, lỗi mạng…) hoặc lượt xử
 * lý ném lỗi → hẹn `next_check_at = now + holdRecheckDelayMs(n)` với `n` = số lần liên tiếp (1, 2, 3…): 1 → 2 → 4 → 8 →
 * 16 → 32 → 60 → 60… phút. Đơn bị breaker hoãn (không gọi querydr) KHÔNG tăng `n`, chỉ lùi `holdRecheckDeferMs` để
 * nhường chỗ cho đơn khác trong lượt sau và được hỏi lại ngay khi breaker đóng.
 */
export const HOLD_RECHECK_POLICY = {
  /** Lần chưa rõ đầu tiên → kiểm lại sau 1 phút (= chu kỳ job). */
  baseMs: 60_000,
  /** Trần: đơn chưa rõ lâu vẫn được hỏi ít nhất mỗi giờ (IPN đến lúc nào cũng xử lý ngay, không chờ mốc này). */
  maxMs: 60 * 60_000,
  /** Đơn bị breaker hoãn: xếp lại cuối hàng, xét lại sau 1 phút. */
  deferMs: 60_000,
} as const;

/**
 * Khoảng chờ trước lần kiểm thứ `attempt + 1` sau `attempt` lần chưa rõ/lỗi liên tiếp (attempt ≥ 1; < 1 hoặc không
 * phải số nguyên hữu hạn → coi như 1). Không tràn: số mũ kẹp trước khi lũy thừa.
 */
export function holdRecheckDelayMs(
  attempt: number,
  policy: { baseMs: number; maxMs: number } = HOLD_RECHECK_POLICY,
): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const exp = Math.min(n - 1, 40);
  return Math.min(policy.baseMs * 2 ** exp, policy.maxMs);
}
