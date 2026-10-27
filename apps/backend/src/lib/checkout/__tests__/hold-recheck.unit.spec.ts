import { HOLD_RECHECK_POLICY, holdRecheckAt, holdRecheckDelayMs } from "../hold-recheck";

const MIN = 60_000;

describe("holdRecheckDelayMs (T-164 — backoff kiểm lại đơn quá hạn chưa rõ)", () => {
  it("hàm mũ cơ số 2 từ 1 phút, trần 60 phút", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => holdRecheckDelayMs(n) / MIN)).toEqual([
      1, 2, 4, 8, 16, 32, 60, 60, 60,
    ]);
  });

  it("ca biên: 0, âm, NaN, Infinity, số lẻ → không ném, kết quả trong [base, max]", () => {
    expect(holdRecheckDelayMs(0)).toBe(MIN);
    expect(holdRecheckDelayMs(-3)).toBe(MIN);
    expect(holdRecheckDelayMs(Number.NaN)).toBe(MIN);
    expect(holdRecheckDelayMs(Number.POSITIVE_INFINITY)).toBe(MIN);
    expect(holdRecheckDelayMs(2.9)).toBe(2 * MIN);
    // Số rất lớn (cột integer tràn dần qua nhiều năm) → không ra Infinity/NaN.
    expect(holdRecheckDelayMs(2_147_483_647)).toBe(HOLD_RECHECK_POLICY.maxMs);
  });

  it("chính sách tiêm được; luôn là số nguyên ms an toàn", () => {
    expect(holdRecheckDelayMs(3, { baseMs: 1_000, maxMs: 3_000 })).toBe(3_000);
    for (let n = 1; n < 100; n++) expect(Number.isSafeInteger(holdRecheckDelayMs(n))).toBe(true);
  });
});

describe("holdRecheckAt (dung sai lịch)", () => {
  const now = new Date("2026-10-27T23:59:30.000Z");
  it("mốc = now + delay − 5 s (qua nửa đêm UTC vẫn đúng mốc tuyệt đối)", () => {
    expect(holdRecheckAt(now, MIN).toISOString()).toBe("2026-10-28T00:00:25.000Z");
    expect(holdRecheckAt(now, 60 * MIN).getTime() - now.getTime()).toBe(60 * MIN - 5_000);
  });
  it("delay ≤ dung sai → vẫn sau now ít nhất 1 ms (không hẹn vào quá khứ)", () => {
    expect(holdRecheckAt(now, 0).getTime()).toBe(now.getTime() + 1);
    expect(holdRecheckAt(now, 5_000).getTime()).toBe(now.getTime() + 1);
  });
  it("chính sách mặc định: delay nhỏ nhất (base, defer) lớn hơn dung sai", () => {
    expect(HOLD_RECHECK_POLICY.baseMs).toBeGreaterThan(HOLD_RECHECK_POLICY.slackMs);
    expect(HOLD_RECHECK_POLICY.deferMs).toBeGreaterThan(HOLD_RECHECK_POLICY.slackMs);
  });
});
