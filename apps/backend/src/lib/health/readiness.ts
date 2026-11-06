import { secondsToMs } from "@x-shop/domain";

/**
 * Readiness (OPS-OBS-006, T-079): tiến trình có phục vụ được request phụ thuộc DB/Redis không. Khác liveness
 * (`/x/health`, không chạm phụ thuộc): readiness lỗi → bộ cân bằng tải ngừng gửi request tới instance, KHÔNG khởi động
 * lại tiến trình.
 *
 * - Mỗi phụ thuộc là một `probe` có hạn `READINESS_PROBE_TIMEOUT_MS`, chạy song song → tổng thời gian ≤ một hạn. Lệnh treo
 *   (pool DB cạn, ioredis xếp lệnh chờ khi mất kết nối) tính là hỏng; lời gọi gốc chạy tiếp ở nền nhưng đã gắn `catch`
 *   (không thành unhandledRejection).
 * - Kết quả chỉ có tên phụ thuộc hỏng (để ghi log phía server); thông điệp lỗi gốc (host, cổng, SQL) không đi ra ngoài.
 * - Gộp lời gọi đồng thời (`coalesce`): N request readiness cùng lúc chỉ chạy một lượt probe → endpoint công khai không
 *   thành đòn khuếch đại tải vào DB/Redis.
 */

/** Hạn mỗi probe. Probe của bộ điều phối (vd Kubernetes `timeoutSeconds`) nên ≥ 2 s để thấy được 503 thay vì timeout. */
export const READINESS_PROBE_TIMEOUT_MS = secondsToMs(1);

export type Probe = () => Promise<unknown>;

export interface ReadinessResult {
  ready: boolean;
  /** Tên phụ thuộc hỏng/quá hạn, theo thứ tự khai báo. */
  failed: string[];
}

/** true khi `probe` hoàn tất trong `ms`; lỗi (kể cả ném đồng bộ) hoặc quá hạn → false. Không bao giờ reject. */
export async function runProbe(probe: Probe, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  let attempt: Promise<boolean>;
  try {
    attempt = Promise.resolve(probe()).then(
      () => true,
      () => false,
    );
  } catch {
    attempt = Promise.resolve(false);
  }
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReadiness(
  probes: Readonly<Record<string, Probe>>,
  timeoutMs: number = READINESS_PROBE_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const names = Object.keys(probes);
  const results = await Promise.all(names.map((n) => runProbe(probes[n]!, timeoutMs)));
  const failed = names.filter((_, i) => results[i] !== true);
  return { ready: failed.length === 0, failed };
}

const inflight = new WeakMap<object, Promise<ReadinessResult>>();

/**
 * Lời gọi trùng `key` khi lượt trước chưa xong dùng chung kết quả lượt đó; xong (kể cả lỗi) thì lượt sau chạy mới — không
 * cache kết quả cũ (phụ thuộc hồi phục được thấy ngay ở lượt kế).
 */
export function coalesce(key: object, run: () => Promise<ReadinessResult>): Promise<ReadinessResult> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = run().finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
