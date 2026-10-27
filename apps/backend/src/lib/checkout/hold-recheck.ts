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
  /** Đơn bị breaker hoãn / lỗi ở pha chốt hủy: xét lại sau 1 phút, không tăng số mũ. */
  deferMs: 60_000,
  /**
   * Dung sai lịch: hẹn sớm hơn `slackMs` so với `now + delay`. Lượt kế tiếp của cron 1 phút có thể bắt đầu sớm hơn vài
   * trăm ms so với 60 s sau lượt trước (`now` lấy lúc bắt đầu lượt) — không trừ thì bước 1 phút thành 2 phút.
   */
  slackMs: 5_000,
  /** Số đơn quá hạn chưa rõ (đã hỏi ≥ 1 lần, còn chờ) từ mức này → log WARN mỗi lượt (RUNBOOK §1). */
  backlogWarnAt: 50,
} as const;

/** Mốc kiểm lại: `now + delay − slackMs` (delay > slack theo chính sách nên luôn sau `now`). */
export function holdRecheckAt(
  now: Date,
  delayMs: number,
  policy: { slackMs: number } = HOLD_RECHECK_POLICY,
): Date {
  return new Date(now.getTime() + Math.max(delayMs - policy.slackMs, 1));
}

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
