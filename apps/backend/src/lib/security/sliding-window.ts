/**
 * Xấp xỉ cửa sổ trượt cho mọi rate limit (T-055, D-034) — hàm thuần, không I/O, không đọc đồng hồ.
 *
 * Bộ đếm vẫn lưu theo cửa sổ CỐ ĐỊNH theo đồng hồ (`window_start = floor(now / windowMs) · windowMs`), nhưng quyết định
 * dựa trên số HIỆU DỤNG:
 *
 *   hiệu_dụng = count(cửa sổ hiện tại) + count(cửa sổ trước) · (windowMs − (now − window_start)) / windowMs
 *
 * — phần đóng góp của cửa sổ trước giảm tuyến tính về 0 khi cửa sổ hiện tại trôi hết. Cửa sổ cố định thuần cho phép tới
 * 2× hạn mức quanh ranh giới (đếm về 0 ngay sau ranh giới, T-050); số hiệu dụng liên tục qua ranh giới nên chuỗi vắt qua
 * ranh giới vẫn bị chặn đúng ngưỡng.
 *
 * `now` được tiêm MỘT lần, vào bộ đếm (`hitRateCounter(bucket, windowMs, now)`…); mẫu trả về mang luôn `elapsedMs` của
 * chính thời điểm đó — quyết định và `Retry-After` không đọc lại đồng hồ, nên không thể lệch mốc với lúc đếm (và test tiêm
 * đồng hồ ở bộ đếm là đủ).
 *
 * Mọi so sánh làm trên số NGUYÊN đã nhân `windowMs` (`current·M + previous·(M − e)`) — không có lỗi làm tròn số thực ở
 * đúng ngưỡng. Với hạn mức/cửa sổ của dự án (≤ vài trăm lượt, ≤ 1 giờ) giá trị nằm xa `Number.MAX_SAFE_INTEGER`.
 */

/** Số đếm thô của cửa sổ chứa thời điểm đếm và cửa sổ liền trước, cùng số ms đã trôi trong cửa sổ hiện tại lúc đó. */
export interface WindowSample {
  current: number;
  previous: number;
  /** `now − window_start` lúc đếm/đọc: 0 ≤ elapsedMs < windowMs. */
  elapsedMs: number;
}

/**
 * Luật cho qua request kế tiếp: `(current + add)·M + previous·(M − e) ≤ limit·M` — tức "trong cửa sổ trượt có tối đa
 * `limit` lượt được đếm, kể cả lượt này nếu nó được đếm".
 *  - `add = 1` (`NEXT_HIT`): request kế tiếp sẽ (hoặc có thể) được ĐẾM — `hit` rồi so, hay đếm lần bị từ chối.
 *  - `add = 0` (`PEEK_OVER`): request kế tiếp không tốn lượt (giá trị đã thấy của `consumeDistinct`).
 */
export interface NextRequestRule {
  add: 0 | 1;
}

export const NEXT_HIT: NextRequestRule = { add: 1 };
export const PEEK_OVER: NextRequestRule = { add: 0 };

function assertWindow(windowMs: number): void {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError(`windowMs phải là số nguyên dương (nhận ${windowMs})`);
  }
}

/** Mốc đầu (ms epoch) của cửa sổ cố định chứa `nowMs`. */
export function windowStartMs(windowMs: number, nowMs: number): number {
  assertWindow(windowMs);
  return Math.floor(nowMs / windowMs) * windowMs;
}

/** Ghép số đếm thô với thời điểm đếm `now` thành mẫu (tính `elapsedMs`). */
export function sampleAt(
  counts: { current: number; previous: number },
  windowMs: number,
  now: Date,
): WindowSample {
  const nowMs = now.getTime();
  return {
    current: counts.current,
    previous: counts.previous,
    elapsedMs: nowMs - windowStartMs(windowMs, nowMs),
  };
}

/** Số hiệu dụng × windowMs (số nguyên). */
function scaled(sample: WindowSample, windowMs: number, add: number): number {
  assertWindow(windowMs);
  const e = sample.elapsedMs;
  if (!Number.isSafeInteger(e) || e < 0 || e >= windowMs) {
    throw new RangeError(`elapsedMs phải trong [0, windowMs) (nhận ${e})`);
  }
  return (sample.current + add) * windowMs + sample.previous * (windowMs - e);
}

/** Số hiệu dụng (số thực — để hiển thị/test; quyết định dùng `exceedsLimit`/`wouldExceedLimit`). */
export function effectiveCount(sample: WindowSample, windowMs: number): number {
  return scaled(sample, windowMs, 0) / windowMs;
}

/** Hiệu dụng > hạn mức — dùng sau khi đã đếm request hiện tại (`hit` rồi so). */
export function exceedsLimit(sample: WindowSample, limit: number, windowMs: number): boolean {
  return scaled(sample, windowMs, 0) > limit * windowMs;
}

/**
 * Hiệu dụng + 1 > hạn mức — chỉ đọc, request hiện tại CHƯA được đếm nhưng sẽ được đếm nếu thất bại (đếm lần bị từ chối:
 * `assertNotBlocked` + `recordDenied`). Tổng quát hoá đúng của `count ≥ limit` cửa sổ cố định: với số đếm nguyên hai
 * cách như nhau; với phần lẻ của cửa sổ trước (vd 19,99 ngay sau ranh giới) `≥` sẽ cho lọt thêm một lượt dò.
 */
export function wouldExceedLimit(sample: WindowSample, limit: number, windowMs: number): boolean {
  return scaled(sample, windowMs, 1) > limit * windowMs;
}

/**
 * Ms sớm nhất trong một cửa sổ (tính từ đầu cửa sổ, từ ms thứ `fromElapsed`) mà `a·M + b·(M − e) ≤ cap`; `null` nếu
 * không có trong cửa sổ đó.
 */
function earliestIn(a: number, b: number, fromElapsed: number, windowMs: number, cap: number): number | null {
  const room = cap - a * windowMs;
  if (room < 0) return null;
  if (b <= 0) return fromElapsed;
  // b·(M − e) ≤ room  ⇔  M − e ≤ ⌊room / b⌋ (e, M nguyên)  ⇔  e ≥ M − ⌊room / b⌋
  const e = Math.max(fromElapsed, windowMs - Math.floor(room / b));
  return e <= windowMs - 1 ? e : null;
}

/**
 * Số ms (≥ 0) từ thời điểm của mẫu tới lúc request kế tiếp được cho qua theo `rule`, GIẢ ĐỊNH không có thêm lượt đếm nào
 * từ giờ tới đó: trong cửa sổ hiện tại (cửa sổ trước nhạt dần) → cửa sổ kế (hiện tại thành "trước") → cửa sổ sau nữa
 * (cả hai đã trôi khỏi tầm). Có thể dài hơn 1 cửa sổ: xấp xỉ tuyến tính giữ phần đóng góp của đợt dồn dập lâu hơn cửa sổ
 * trượt chính xác — chọn chặt (an toàn) thay vì hứa một mốc mà lượt thử lại vẫn bị chặn (và bị đếm thêm). Sau mốc này
 * request vẫn được qua (hiệu dụng không tăng khi không có lượt đếm mới).
 */
export function retryDelayMs(
  sample: WindowSample,
  limit: number,
  windowMs: number,
  rule: NextRequestRule,
): number {
  scaled(sample, windowMs, 0); // kiểm tham số
  const e0 = sample.elapsedMs;
  const cap = limit * windowMs;
  const inCurrent = earliestIn(sample.current + rule.add, sample.previous, e0, windowMs, cap);
  if (inCurrent !== null) return inCurrent - e0;
  const inNext = earliestIn(rule.add, sample.current, 0, windowMs, cap);
  if (inNext !== null) return windowMs - e0 + inNext;
  return 2 * windowMs - e0;
}

/** Giá trị `Retry-After` (giây, làm tròn lên, ≥ 1) cho request kế tiếp theo `rule`. */
export function slidingRetryAfterSeconds(
  sample: WindowSample,
  limit: number,
  windowMs: number,
  rule: NextRequestRule,
): number {
  return Math.max(1, Math.ceil(retryDelayMs(sample, limit, windowMs, rule) / 1000));
}
