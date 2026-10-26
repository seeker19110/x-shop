import { AUTH_RATE_LIMITS } from "../../admin-security/config";
import { registerAttempt, registerRefund, registerSuccess } from "../../admin-security/rate-limit";
import { MemoryStore } from "../../admin-security/store";
import { consume, consumeDistinct, STORE_RATE_LIMITS } from "../rate-limit";
import {
  effectiveCount,
  exceedsLimit,
  NEXT_HIT,
  PEEK_OVER,
  retryDelayMs,
  sampleAt,
  slidingRetryAfterSeconds,
  windowStartMs,
  wouldExceedLimit,
  type NextRequestRule,
} from "../sliding-window";
import { MemoryCounter } from "./memory-counter";

/**
 * T-055 (D-034): rate limit xấp xỉ cửa sổ trượt. Mọi thời điểm đều tiêm (`now`) — không phụ thuộc đồng hồ thật.
 */

// Ranh giới cửa sổ của mọi chính sách (bội của 1 giờ ⇒ bội của 1 phút, 10 phút, 15 phút).
const W = new Date("2026-10-25T03:00:00.000Z").getTime();
const at = (ms: number) => new Date(W + ms);
type Counts = { current: number; previous: number };
/** Mẫu của bộ đếm tại thời điểm tiêm `now` (như hitRateCounter/peekRateCounter trả về). */
const S = (c: Counts, M: number, now: Date) => sampleAt(c, M, now);

describe("số hiệu dụng", () => {
  const M = 60_000;

  it("đầu cửa sổ (đúng ranh giới) cửa sổ trước tính đủ; giữa cửa sổ một nửa; cuối cửa sổ gần 0", () => {
    const s = { current: 3, previous: 10 };
    expect(effectiveCount(S(s, M, at(0)), M)).toBe(13);
    expect(effectiveCount(S(s, M, at(M / 2)), M)).toBe(8);
    expect(effectiveCount(S(s, M, at(M - 1)), M)).toBeCloseTo(3 + 10 / M, 10);
    // Sang cửa sổ kế: mốc khác ⇒ bên gọi đọc mẫu mới; cùng mẫu ở đúng ranh giới kế tiếp lại là "đầu cửa sổ".
    expect(windowStartMs(M, W + M)).toBe(W + M);
    expect(windowStartMs(M, W + M - 1)).toBe(W);
  });

  it("cửa sổ trước rỗng = đếm cửa sổ cố định", () => {
    for (const e of [0, 1, M / 2, M - 1]) {
      expect(effectiveCount(S({ current: 7, previous: 0 }, M, at(e)), M)).toBe(7);
    }
  });

  it("so sánh chính xác ở đúng ngưỡng (số nguyên, không lỗi làm tròn)", () => {
    // 1 + 3·(M − e)/M = 2 đúng khi e = 2M/3 — hiệu dụng = ngưỡng: không vượt; thêm một lượt thì vượt.
    const s = { current: 1, previous: 3 };
    const e = (2 * M) / 3;
    expect(exceedsLimit(S(s, M, at(e)), 2, M)).toBe(false);
    expect(exceedsLimit(S(s, M, at(e - 1)), 2, M)).toBe(true);
    expect(wouldExceedLimit(S(s, M, at(e)), 3, M)).toBe(false);
    expect(wouldExceedLimit(S(s, M, at(e - 1)), 3, M)).toBe(true);
    expect(wouldExceedLimit(S(s, M, at(M - 1)), 2, M)).toBe(true);
  });

  it("windowMs / elapsedMs không hợp lệ → lỗi rõ ràng (không chia cho 0, không mẫu lệch cửa sổ)", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => effectiveCount({ current: 1, previous: 0, elapsedMs: 0 }, bad)).toThrow(RangeError);
      expect(() => S({ current: 1, previous: 0 }, bad, at(0))).toThrow(RangeError);
    }
    for (const e of [-1, M, 1.5]) {
      expect(() => exceedsLimit({ current: 1, previous: 0, elapsedMs: e }, 1, M)).toThrow(RangeError);
    }
  });
});

describe("chặn đúng ngưỡng qua ranh giới (hồi quy T-050)", () => {
  const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;

  it("chuỗi vắt qua ranh giới: N lượt sát cuối cửa sổ → lượt N+1 ngay sau ranh giới bị chặn", async () => {
    const c = new MemoryCounter();
    for (let i = 0; i < limit; i++) expect((await consume(c, "searchIp", "ip", at(-1))).allowed).toBe(true);
    // Cửa sổ cố định thuần cho qua tới 2N ở đây; cửa sổ trượt: 1 + N·1 > N.
    expect((await consume(c, "searchIp", "ip", at(0))).allowed).toBe(false);
    expect((await consume(c, "searchIp", "ip", at(1_000))).allowed).toBe(false);
  });

  it("chia đôi hai bên ranh giới: tổng trong một cửa sổ trượt vẫn ≤ N", async () => {
    const c = new MemoryCounter();
    const half = limit / 2;
    for (let i = 0; i < half; i++) expect((await consume(c, "searchIp", "ip", at(-500))).allowed).toBe(true);
    for (let i = 0; i < half; i++) expect((await consume(c, "searchIp", "ip", at(500))).allowed).toBe(true);
    expect((await consume(c, "searchIp", "ip", at(600))).allowed).toBe(false);
  });

  it("nhịp đều dưới ngưỡng (≈ 90% hạn mức) nhiều cửa sổ liền không bao giờ bị chặn", async () => {
    const c = new MemoryCounter();
    const step = Math.ceil(windowMs / (limit * 0.9));
    for (let t = -3 * windowMs; t < 5 * windowMs; t += step) {
      expect((await consume(c, "searchIp", "ip", at(t))).allowed).toBe(true);
    }
  });

  it("nhịp đều trên ngưỡng (≈ 120%) bị chặn ở mọi cửa sổ sau cửa sổ đầu", async () => {
    const c = new MemoryCounter();
    const step = Math.floor(windowMs / (limit * 1.2));
    const deniedPerWindow = new Map<number, number>();
    for (let t = 0; t < 4 * windowMs; t += step) {
      if (!(await consume(c, "searchIp", "ip", at(t))).allowed) {
        const w = Math.floor(t / windowMs);
        deniedPerWindow.set(w, (deniedPerWindow.get(w) ?? 0) + 1);
      }
    }
    for (const w of [1, 2, 3]) expect(deniedPerWindow.get(w) ?? 0).toBeGreaterThan(0);
  });

  it("cửa sổ trước rỗng: đúng N lượt lọt, lượt N+1 chặn — cả đầu lẫn cuối cửa sổ", async () => {
    for (const e of [0, windowMs - limit - 1]) {
      const c = new MemoryCounter();
      for (let i = 0; i < limit; i++)
        expect((await consume(c, "searchIp", "ip", at(e + i))).allowed).toBe(true);
      expect((await consume(c, "searchIp", "ip", at(e + limit))).allowed).toBe(false);
    }
  });

  it("cuối cửa sổ kế tiếp: phần của cửa sổ trước gần như đã trôi hết → lại được thử", async () => {
    const c = new MemoryCounter();
    for (let i = 0; i < limit; i++) await consume(c, "searchIp", "ip", at(-1));
    expect((await consume(c, "searchIp", "ip", at(windowMs - 1))).allowed).toBe(true);
  });

  it("đồng thời sau ranh giới: số lượt lọt = N − phần còn lại của cửa sổ trước", async () => {
    const c = new MemoryCounter();
    for (let i = 0; i < 30; i++) await consume(c, "searchIp", "ip", at(-1));
    // Giữa cửa sổ: 30 · ½ = 15 ⇒ còn đúng 45 chỗ cho loạt song song.
    const results = await Promise.all(
      Array.from({ length: 60 }, () => consume(c, "searchIp", "ip", at(windowMs / 2))),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(limit - 15);
  });

  it("consumeDistinct (mã giảm giá): mã khác nhau vắt qua ranh giới vẫn chặn ở mã thứ N+1", async () => {
    const { limit: L, windowMs: M } = STORE_RATE_LIMITS.couponCart;
    const c = new MemoryCounter();
    for (let i = 0; i < L; i++) {
      expect((await consumeDistinct(c, "couponCart", "cart", `MA${i}`, at(-1))).allowed).toBe(true);
    }
    expect((await consumeDistinct(c, "couponCart", "cart", "MOI", at(0))).allowed).toBe(false);
    // Gần hết cửa sổ kế: phần cửa sổ trước ≈ 0 ⇒ mã mới lại được thử.
    expect((await consumeDistinct(c, "couponCart", "cart", "MOI2", at(M - 1))).allowed).toBe(true);
  });
});

/**
 * Mô phỏng tham chiếu: tại `tMs`, giả định không có lượt đếm mới sau `now`, request kế tiếp có được qua theo `rule`?
 * (Cửa sổ hiện tại → kế tiếp: hiện tại thành "trước" → sau nữa: cả hai trôi hết.)
 */
function referenceAllowed(
  s: Counts,
  limit: number,
  M: number,
  nowMs: number,
  tMs: number,
  rule: NextRequestRule,
): boolean {
  const start = windowStartMs(M, nowMs);
  const k = Math.floor((tMs - start) / M);
  const cur = k === 0 ? s.current : 0;
  const prev = k === 0 ? s.previous : k === 1 ? s.current : 0;
  const e = tMs - (start + k * M);
  return (cur + rule.add) * M + prev * (M - e) <= limit * M;
}

describe("Retry-After", () => {
  it("mốc trả về là mốc SỚM NHẤT được cho qua (đối chiếu mô phỏng, quét lưới trạng thái)", () => {
    const M = 1_000;
    const limit = 3;
    for (const rule of [NEXT_HIT, PEEK_OVER]) {
      for (let current = 0; current <= 8; current++) {
        for (let previous = 0; previous <= 8; previous++) {
          for (const e of [0, 1, 250, 499, 500, 999]) {
            const s = { current, previous };
            const nowMs = W + e;
            const t = nowMs + retryDelayMs(S(s, M, new Date(nowMs)), limit, M, rule);
            expect(t).toBeGreaterThanOrEqual(nowMs);
            expect(referenceAllowed(s, limit, M, nowMs, t, rule)).toBe(true);
            if (t > nowMs) expect(referenceAllowed(s, limit, M, nowMs, t - 1, rule)).toBe(false);
            // Đã được qua thì không bị chặn lại về sau (đơn điệu) — làm theo Retry-After là đủ.
            for (const later of [t + 1, t + M, t + 2 * M]) {
              expect(referenceAllowed(s, limit, M, nowMs, later, rule)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("làm tròn lên giây, tối thiểu 1; có thể vượt một cửa sổ sau đợt dồn dập (chặt, không hứa sớm)", () => {
    const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;
    // Đang được qua → 1.
    expect(
      slidingRetryAfterSeconds(S({ current: 1, previous: 0 }, windowMs, at(0)), limit, windowMs, NEXT_HIT),
    ).toBe(1);
    // 70 lượt dồn ở đầu cửa sổ (60/phút): lượt kế qua khi 1 + 70·(M − e)/M ≤ 60 ⇔ e ≥ 11/70·M ≈ 9,43 s sau ranh giới.
    const s = { current: 70, previous: 0 };
    const sec = slidingRetryAfterSeconds(S(s, windowMs, at(0)), limit, windowMs, NEXT_HIT);
    expect(sec).toBe(Math.ceil((windowMs + Math.ceil((11 * windowMs) / 70)) / 1000));
    expect(sec).toBeGreaterThan(windowMs / 1000);
    expect(sec).toBeLessThanOrEqual((2 * windowMs) / 1000);
    // Hạn mức 1, cửa sổ trước đầy: phải đợi hết cả cửa sổ sau.
    expect(
      slidingRetryAfterSeconds(S({ current: 2, previous: 0 }, windowMs, at(0)), 1, windowMs, NEXT_HIT),
    ).toBe((2 * windowMs) / 1000);
  });

  it("đếm lần bị từ chối (deniedIp): chặn khi thêm một lần từ chối sẽ vượt ngưỡng — kể cả phần lẻ sau ranh giới", () => {
    const M = 600_000;
    const s = { current: 0, previous: 20 };
    // 20 lần từ chối sát cuối cửa sổ trước; 10 ms sau ranh giới hiệu dụng 19,9997 — `≥ 20` sẽ cho lọt lượt dò thứ 21.
    expect(effectiveCount(S(s, M, at(10)), M)).toBeLessThan(20);
    expect(wouldExceedLimit(S(s, M, at(10)), 20, M)).toBe(true);
    // Qua khi 1 + 20·(M − e)/M ≤ 20 ⇔ e ≥ M/20 = 30 s.
    expect(slidingRetryAfterSeconds(S(s, M, at(10)), 20, M, NEXT_HIT)).toBe(30);
    const s2 = { current: 10, previous: 20 };
    // 11 + 20·(M − e)/M ≤ 20 ⇔ e ≥ 0,55·M.
    expect(retryDelayMs(S(s2, M, at(0)), 20, M, NEXT_HIT)).toBe(0.55 * M);
  });
});

describe("đăng nhập/MFA (kho Redis/bộ nhớ) — cửa sổ trượt với đồng hồ tiêm", () => {
  const M = AUTH_RATE_LIMITS.windowSeconds * 1000;
  const L = AUTH_RATE_LIMITS.mfa.perIdentityIp;

  it("N thất bại sát cuối cửa sổ → lần N+1 ngay sau ranh giới bị chặn; Retry-After hợp lý", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < L; i++) {
      expect((await registerAttempt(store, "mfa", "ai_1", "5.5.5.5", at(-1))).allowed).toBe(true);
    }
    const blocked = await registerAttempt(store, "mfa", "ai_1", "5.5.5.5", at(0));
    expect(blocked.allowed).toBe(false);
    const after = (blocked as { retryAfterSeconds: number }).retryAfterSeconds;
    // 1 (giữ chỗ lần này) + 5·1 = 6 > 5; lượt kế qua khi 1 + 1 + 5·(M − e)/M ≤ 5 ⇔ e ≥ 2M/5.
    expect(after).toBe(Math.ceil((2 * M) / 5 / 1000));
    expect((await registerAttempt(store, "mfa", "ai_1", "5.5.5.5", at(after * 1000))).allowed).toBe(true);
  });

  it("đồng thời qua ranh giới: loạt song song không vượt phần còn lại của ngưỡng", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 2; i++) await registerAttempt(store, "mfa", "ai_2", "6.6.6.6", at(-1));
    // Đúng ranh giới: 2 lượt cửa sổ trước tính đủ ⇒ còn 3.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => registerAttempt(store, "mfa", "ai_2", "6.6.6.6", at(0))),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(L - 2);
  });

  it("thành công xoá thất bại (định danh + IP) của CẢ cửa sổ trước; hoàn lại 5xx vào đúng cửa sổ đã giữ chỗ", async () => {
    const L = AUTH_RATE_LIMITS.login.perIdentityIp;
    const store = new MemoryStore();
    for (let i = 0; i < L - 1; i++) await registerAttempt(store, "login", "a@x.vn", "7.7.7.7", at(-1));
    expect((await registerAttempt(store, "login", "a@x.vn", "7.7.7.7", at(0))).allowed).toBe(true);
    await registerSuccess(store, "login", "a@x.vn", "7.7.7.7", at(0));
    for (let i = 0; i < L; i++) {
      expect((await registerAttempt(store, "login", "a@x.vn", "7.7.7.7", at(10 + i))).allowed).toBe(true);
    }
    expect((await registerAttempt(store, "login", "a@x.vn", "7.7.7.7", at(100))).allowed).toBe(false);

    // Giữ chỗ ở cửa sổ trước, phản hồi 5xx xong SAU ranh giới: hoàn lại theo mốc giữ chỗ.
    const s2 = new MemoryStore();
    for (let i = 0; i < L; i++) {
      await registerAttempt(s2, "login", "b@x.vn", "8.8.8.8", at(-1));
      await registerRefund(s2, "login", "b@x.vn", "8.8.8.8", at(-1));
    }
    for (let i = 0; i < L; i++) {
      expect((await registerAttempt(s2, "login", "b@x.vn", "8.8.8.8", at(i))).allowed).toBe(true);
    }
  });
});
