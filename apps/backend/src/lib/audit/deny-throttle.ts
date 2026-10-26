import { createHash } from "node:crypto";

/**
 * Giới hạn tần suất ghi audit cho lần bị từ chối (RBAC deny) — chống ngập audit log khi một actor (lỗi client, script,
 * kẻ dò quyền) bắn liên tục vào route không được phép. Gộp theo nhóm (actor, route, lý do) trong cửa sổ cố định:
 * ghi lần thứ 1, 10, 100, 1000… của nhóm trong cửa sổ (số ghi ≤ 1 + log10(n)), mỗi dòng mang `occurrence` = số lần đã
 * gặp tới lúc đó → vẫn ước được độ lớn đợt dồn dập.
 *
 * "Route" là LỚP route (method + quyền yêu cầu, hoặc lý do từ chối khi route không khai báo) — không phải đường dẫn cụ
 * thể: nếu gộp theo đường dẫn, đổi id/đường dẫn rác mỗi lần là lách được giới hạn. Dòng audit vẫn ghi đường dẫn cụ thể
 * của lần được ghi.
 *
 * Bộ đếm phải nguyên tử và dùng chung giữa các instance (Postgres `rate_limit_counter`). Bộ đếm lỗi → vẫn ghi audit
 * (mất dấu vết bảo mật tệ hơn thêm dòng).
 */
export const DENY_AUDIT_THROTTLE = { windowMs: 60_000 } as const;

export interface DenyGroup {
  actorType: string;
  actorId: string | null;
  method: string;
  /** Lớp route: vd `perm:refund.execute` hoặc `deny:UNDECLARED_ROUTE`. */
  routeClass: string;
  reason: string;
}

/** Bộ đếm cửa sổ cố định: tăng rồi trả số đếm sau khi tăng (≥ 1). */
export type WindowCounter = (bucket: string, windowMs: number, now: Date) => Promise<number>;

export function denyBucket(g: DenyGroup): string {
  const key = [g.actorType, g.actorId ?? "", g.method, g.routeClass, g.reason].join("\u0000");
  return `audit.rbac_denied:${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 40)}`;
}

/** Ghi ở lần 1, 10, 100, 1000…; số đếm bất thường (≤ 0, không nguyên) → ghi (an toàn). */
export function isRecordedOccurrence(n: number): boolean {
  if (!Number.isSafeInteger(n) || n <= 1) return true;
  let x = n;
  while (x % 10 === 0) x /= 10;
  return x === 1;
}

export type DenyThrottleDecision =
  { record: true; occurrence: number | null; window_seconds: number } | { record: false; occurrence: number };

export async function decideDenyAudit(
  counter: WindowCounter,
  group: DenyGroup,
  now: Date = new Date(),
  onCounterError?: (e: unknown) => void,
): Promise<DenyThrottleDecision> {
  const windowSeconds = DENY_AUDIT_THROTTLE.windowMs / 1000;
  let n: number;
  try {
    n = await counter(denyBucket(group), DENY_AUDIT_THROTTLE.windowMs, now);
  } catch (e) {
    onCounterError?.(e);
    return { record: true, occurrence: null, window_seconds: windowSeconds };
  }
  return isRecordedOccurrence(n)
    ? { record: true, occurrence: n, window_seconds: windowSeconds }
    : { record: false, occurrence: n };
}
