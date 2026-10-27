import { MemoryCounter } from "../../security/__tests__/memory-counter";
import {
  consumeWebhookRate,
  WEBHOOK_RATE_LIMITS,
  webhookRateBucket,
  type WebhookRateDecision,
  type WindowHit,
} from "../webhook-rate-limit";

/**
 * T-095 (ARC-RES-005): giới hạn webhook đếm ở kho DÙNG CHUNG — hai "bản sao" (hai bộ gọi độc lập) cùng một bộ đếm thì
 * hạn mức là tổng chung, không phải mỗi bản một hạn mức. MemoryCounter có cùng ngữ nghĩa với `hitRateCounter` (Postgres).
 * Đồng hồ tiêm — không phụ thuộc giờ thật.
 */
const { limit } = WEBHOOK_RATE_LIMITS.ghnCallbackIp;
// Ranh giới cửa sổ 10 s.
const W = new Date("2026-10-27T03:00:00.000Z").getTime();
const at = (ms: number) => new Date(W + ms);
const hitOf =
  (c: MemoryCounter): WindowHit =>
  (bucket, ms, now) =>
    c.hit(bucket, ms, now);

const denied = (ds: WebhookRateDecision[]) =>
  ds.filter((d): d is { allowed: false; retryAfterSeconds: number } => !d.allowed);

describe("consumeWebhookRate — bộ đếm chung giữa các bản sao", () => {
  it("đồng thời: 2 bản sao × 200 request song song cùng cửa sổ → đúng `limit` lượt qua, phần còn lại 429 kèm Retry-After", async () => {
    const shared = new MemoryCounter();
    const replicaA = hitOf(shared);
    const replicaB = hitOf(shared);
    const decisions = await Promise.all(
      Array.from({ length: 400 }, (_, i) =>
        consumeWebhookRate(i % 2 === 0 ? replicaA : replicaB, "ghnCallbackIp", "203.0.113.7", at(1_000)),
      ),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(limit);
    const blocked = denied(decisions);
    expect(blocked).toHaveLength(400 - limit);
    // Retry-After tất định (now = giây thứ 1 của cửa sổ, cửa sổ trước rỗng): lượt thứ k bị chặn được qua khi sang cửa sổ
    // kế, lúc `1·M + k·(M − e) ≤ 300·M` ⇔ e ≥ M − ⌊299·M / k⌋. Lượt 301: 9 s + 67 ms → 10 s; lượt 400: 9 s + 2 525 ms → 12 s.
    const afters = blocked.map((d) => d.retryAfterSeconds).sort((x, y) => x - y);
    expect(afters[0]).toBe(10);
    expect(afters[afters.length - 1]).toBe(12);
    for (const s of afters) expect(Number.isInteger(s)).toBe(true);
  });

  it("Retry-After lượt 301 ở 50 ms đầu cửa sổ = 11 giây (tính cho lượt kế tiếp ĐƯỢC ĐẾM)", async () => {
    const shared = new MemoryCounter();
    const hit = hitOf(shared);
    for (let i = 0; i < limit; i += 1) {
      expect((await consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(50))).allowed).toBe(true);
    }
    // e ≥ 10 000 − ⌊299·10 000 / 301⌋ = 67 ms của cửa sổ kế → 9 950 + 67 = 10 017 ms → 11 s. Nếu tính như lượt KHÔNG đếm
    // (PEEK_OVER) sẽ ra 9 950 + 34 ms → 10 s.
    expect(await consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(50))).toEqual({
      allowed: false,
      retryAfterSeconds: 11,
    });
  });

  it("được phép: dưới ngưỡng ở cả hai bản sao (tổng = limit) → mọi lượt qua; lượt kế tiếp ở bản nào cũng bị chặn", async () => {
    const shared = new MemoryCounter();
    const [a, b] = [hitOf(shared), hitOf(shared)];
    for (let i = 0; i < limit; i += 1) {
      expect(
        await consumeWebhookRate(i < limit / 2 ? a : b, "ghnCallbackIp", "203.0.113.7", at(2_000)),
      ).toEqual({
        allowed: true,
      });
    }
    const next = await consumeWebhookRate(b, "ghnCallbackIp", "203.0.113.7", at(2_000));
    expect(next).toEqual({ allowed: false, retryAfterSeconds: expect.any(Number) as number });
    const nextOnA = await consumeWebhookRate(a, "ghnCallbackIp", "203.0.113.7", at(2_001));
    expect(nextOnA.allowed).toBe(false);
  });

  it("vắt qua ranh giới cửa sổ vẫn chặn đúng ngưỡng (cửa sổ trượt, không 2× hạn mức)", async () => {
    const shared = new MemoryCounter();
    const hit = hitOf(shared);
    for (let i = 0; i < limit; i += 1)
      await consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(9_900));
    // 100 ms sau ranh giới: cửa sổ trước còn đóng góp 300 × 99% = 297 → chỉ 3 lượt nữa qua (cửa sổ cố định cho 300).
    const after = [];
    for (let i = 0; i < 10; i += 1)
      after.push(await consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(10_100)));
    expect(after.filter((d) => d.allowed)).toHaveLength(3);
    for (const d of denied(after)) expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // Hai cửa sổ sau: phần đóng góp đã trôi hết → qua.
    expect((await consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(30_000))).allowed).toBe(true);
  });

  it("khoá theo IP: IP khác độc lập; IPv6 cùng /64 chung một bộ đếm; khoá không chứa IP thô", async () => {
    const shared = new MemoryCounter();
    const hit = hitOf(shared);
    for (let i = 0; i < limit; i += 1)
      await consumeWebhookRate(hit, "ghnCallbackIp", "2001:db8:1:2::a", at(3_000));
    expect((await consumeWebhookRate(hit, "ghnCallbackIp", "2001:db8:1:2::ffff", at(3_000))).allowed).toBe(
      false,
    );
    expect((await consumeWebhookRate(hit, "ghnCallbackIp", "2001:db8:1:3::a", at(3_000))).allowed).toBe(true);
    expect((await consumeWebhookRate(hit, "ghnCallbackIp", "198.51.100.1", at(3_000))).allowed).toBe(true);
    const bucket = webhookRateBucket("ghnCallbackIp", "198.51.100.1");
    expect(bucket).toMatch(/^webhook\.ghnCallbackIp:[0-9a-f]{40}$/);
    expect(bucket).not.toContain("198.51.100.1");
    expect(webhookRateBucket("ghnCallbackIp", "unknown")).not.toBe(bucket);
  });

  it("bộ đếm lỗi (DB) → cho qua, báo lỗi đúng một lần, không ném", async () => {
    const errors: unknown[] = [];
    const broken: WindowHit = () => Promise.reject(new Error("connection terminated"));
    await expect(
      consumeWebhookRate(broken, "ghnCallbackIp", "203.0.113.7", at(0), (e) => errors.push(e)),
    ).resolves.toEqual({ allowed: true });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("connection terminated");
    // Không truyền onCounterError cũng không ném.
    await expect(consumeWebhookRate(broken, "ghnCallbackIp", "203.0.113.7", at(0))).resolves.toEqual({
      allowed: true,
    });
  });
});
