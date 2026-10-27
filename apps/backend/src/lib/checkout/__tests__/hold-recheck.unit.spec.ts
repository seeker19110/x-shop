import { HOLD_RECHECK_POLICY, holdRecheckDelayMs } from "../hold-recheck";

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
