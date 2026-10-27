import { backoffDelayMs, type BackoffPolicy, type Random } from "./retry";

/**
 * Chính sách retry của outbox-dispatch (BE-JOB-003, ARC-RES-002): trần số lần, backoff mũ có trần + jitter. Lỗi vĩnh
 * viễn / payload sai không đi qua đây mà vào `dead` ngay (lib/checkout/jobs.ts `dispatchOutbox`).
 */
export const OUTBOX_POLICY = {
  maxAttempts: 8,
  baseDelayMs: 10_000,
  maxDelayMs: 3600_000,
  /** Equal jitter: chờ trong [exp/2, exp) — giãn các sự kiện hỏng cùng lúc mà vẫn giữ khoảng chờ tối thiểu (ARC-RES-002). */
  jitter: "equal",
  /** Thời gian một dispatcher giữ sự kiện đã nhận trước khi dispatcher khác được nhận lại. */
  claimLeaseMs: 60_000,
} as const satisfies BackoffPolicy & { maxAttempts: number; claimLeaseMs: number };

/**
 * Khoảng chờ sau lần hỏng thứ `failedAttempts`: mũ 10s, 20s, 40s… trần 1 giờ, rồi equal jitter (kết quả trong
 * [exp/2, exp), không vượt trần). `random` tiêm được để test tất định.
 */
export function outboxBackoffMs(failedAttempts: number, random: Random = Math.random): number {
  return backoffDelayMs(failedAttempts, OUTBOX_POLICY, random);
}

/** Hẹn lần thử kế tiếp: max(backoff có jitter, `Retry-After` bên kia yêu cầu), kẹp trần một lần chờ. */
export function outboxNextDelayMs(
  failedAttempts: number,
  retryAfterMs: number | null,
  random: Random = Math.random,
): number {
  return Math.min(
    Math.max(outboxBackoffMs(failedAttempts, random), retryAfterMs ?? 0),
    OUTBOX_POLICY.maxDelayMs,
  );
}
