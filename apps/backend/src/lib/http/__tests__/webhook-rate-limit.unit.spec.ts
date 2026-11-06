import { MemoryCounter } from "../../security/__tests__/memory-counter";
import {
  consumeWebhookRate,
  LocalHitGuard,
  localHitGuard,
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
  // Bộ chặn sớm của tiến trình là trạng thái toàn cục: mỗi ca bắt đầu từ trạng thái sạch.
  beforeEach(() => localHitGuard.clear());

  it("đồng thời: 2 bản sao × 200 request song song cùng cửa sổ → đúng `limit` lượt qua, phần còn lại 429 kèm Retry-After", async () => {
    const shared = new MemoryCounter();
    const replicaA = hitOf(shared);
    const replicaB = hitOf(shared);
    const decisions = await Promise.all(
      Array.from({ length: 400 }, (_, i) =>
        // guard = null: kiểm Retry-After của CHÍNH bộ đếm chung (chặn sớm dùng số đếm cục bộ nên Retry-After có thể ngắn hơn).
        consumeWebhookRate(
          i % 2 === 0 ? replicaA : replicaB,
          "ghnCallbackIp",
          "203.0.113.7",
          at(1_000),
          undefined,
          null,
        ),
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

describe("vnpayIpnIp — chính sách IPN VNPAY (T-152)", () => {
  const { limit: ipnLimit, windowMs: ipnWindow } = WEBHOOK_RATE_LIMITS.vnpayIpnIp;

  it("hạn mức 300/10 s như hiện hành; khoá tách khỏi GHN", () => {
    expect(ipnLimit).toBe(300);
    expect(ipnWindow).toBe(10_000);
    expect(webhookRateBucket("vnpayIpnIp", "203.0.113.7")).toMatch(/^webhook\.vnpayIpnIp:[0-9a-f]{40}$/);
    expect(webhookRateBucket("vnpayIpnIp", "203.0.113.7")).not.toBe(
      webhookRateBucket("ghnCallbackIp", "203.0.113.7"),
    );
  });

  it("hai bản sao (hai LocalHitGuard riêng, chung một bộ đếm) chia nhau đúng `limit` lượt", async () => {
    const shared = new MemoryCounter();
    const [ga, gb] = [new LocalHitGuard(), new LocalHitGuard()];
    const calls = Array.from({ length: 400 }, (_, i) =>
      consumeWebhookRate(
        hitOf(shared),
        "vnpayIpnIp",
        "203.0.113.7",
        at(1_000),
        undefined,
        i % 2 === 0 ? ga : gb,
      ),
    );
    const decisions = await Promise.all(calls);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(ipnLimit);
    expect(denied(decisions)).toHaveLength(400 - ipnLimit);
  });
});

describe("chặn sớm trong bộ nhớ (LocalHitGuard)", () => {
  /** Bộ đếm chung đếm số lần ghi (UPSERT) thật. */
  const counting = (c: MemoryCounter) => {
    let writes = 0;
    const hit: WindowHit = (b, ms, now) => {
      writes += 1;
      return c.hit(b, ms, now);
    };
    return { hit, writes: () => writes };
  };

  it("dội 2 000 request song song từ một bản: ≤ limit lần ghi, kết quả cho/chặn y hệt khi không có chặn sớm", async () => {
    const run = async (guard: LocalHitGuard | null) => {
      const { hit, writes } = counting(new MemoryCounter());
      const ds = await Promise.all(
        Array.from({ length: 2_000 }, () =>
          consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(1_000), undefined, guard),
        ),
      );
      return { allowed: ds.filter((d) => d.allowed).length, writes: writes() };
    };
    const without = await run(null);
    const withGuard = await run(new LocalHitGuard());
    expect(without).toEqual({ allowed: limit, writes: 2_000 }); // không chặn sớm: mỗi request một UPSERT
    expect(withGuard.allowed).toBe(limit); // cùng số lượt qua
    expect(withGuard.writes).toBe(limit); // ghi bị chặn trần
  });

  it("không chặn nhầm: bản khác đã tiêu hạn mức thì bản này vẫn được hỏi bộ đếm chung (và bị chặn ở đó)", async () => {
    const shared = new MemoryCounter();
    const { hit, writes } = counting(shared);
    for (let i = 0; i < limit; i += 1)
      await shared.hit(webhookRateBucket("ghnCallbackIp", "203.0.113.7"), 10_000, at(1_000));
    const d = await consumeWebhookRate(
      hit,
      "ghnCallbackIp",
      "203.0.113.7",
      at(1_000),
      undefined,
      new LocalHitGuard(),
    );
    expect(d.allowed).toBe(false);
    expect(writes()).toBe(1); // đã tới bộ đếm chung, không phải do chặn sớm
  });

  it("vắt qua ranh giới cửa sổ: cùng quyết định trong cửa sổ đầu; sau đó không bao giờ lọt quá hạn mức trượt", async () => {
    let writes = 0;
    const run = async (guard: LocalHitGuard | null) => {
      const shared = new MemoryCounter();
      const counted: WindowHit = (b, ms, now) => {
        writes += 1;
        return shared.hit(b, ms, now);
      };
      const phases: boolean[][] = [[], []];
      for (const [k, t] of [9_900, 10_100].entries()) {
        for (let i = 0; i < 400; i += 1) {
          phases[k]!.push(
            (await consumeWebhookRate(counted, "ghnCallbackIp", "203.0.113.7", at(t), undefined, guard))
              .allowed,
          );
        }
      }
      return phases;
    };
    const [g1, g2] = await run(new LocalHitGuard());
    // 300 ở cửa sổ đầu + 3 sau khi ô lăn (previous = 300 được giữ): ghi DB ≤ limit + 3, không phải 800.
    expect(writes).toBe(limit + 3);
    const [n1] = await run(null);
    expect(g1).toEqual(n1); // cùng cửa sổ: y hệt bộ đếm chung
    // Lượt bị chặn sớm không được đếm vào DB nên cửa sổ trước "nhẹ" hơn: 300·0,99 = 297 → đúng 3 lượt nữa, không hơn.
    expect(g2!.filter(Boolean)).toHaveLength(3);
  });

  it("sang cửa sổ mới: phần đóng góp cục bộ trôi dần, lượt hợp lệ lại qua; IP khác độc lập", async () => {
    const guard = new LocalHitGuard();
    const hit = hitOf(new MemoryCounter());
    for (let i = 0; i < limit + 5; i += 1)
      await consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(0), undefined, guard);
    expect(
      (await consumeWebhookRate(hit, "ghnCallbackIp", "203.0.113.7", at(30_000), undefined, guard)).allowed,
    ).toBe(true);
    expect(
      (await consumeWebhookRate(hit, "ghnCallbackIp", "198.51.100.1", at(0), undefined, guard)).allowed,
    ).toBe(true);
  });

  it("bộ đếm chung lỗi: cho qua và KHÔNG tiêu hạn mức cục bộ (không tự khoá)", async () => {
    const guard = new LocalHitGuard();
    const broken: WindowHit = () => Promise.reject(new Error("down"));
    for (let i = 0; i < limit + 50; i += 1) {
      expect(
        await consumeWebhookRate(broken, "ghnCallbackIp", "203.0.113.7", at(0), undefined, guard),
      ).toEqual({ allowed: true });
    }
  });
});

describe("LocalHitGuard — trần bộ nhớ, chi phí, release qua ranh giới (review T-152)", () => {
  it("trần cứng: N khoá lớn không làm Map vượt trần; hết chỗ → bỏ qua chặn sớm (đi thẳng bộ đếm chung)", async () => {
    const guard = new LocalHitGuard(100);
    const hit = hitOf(new MemoryCounter());
    for (let i = 0; i < 1_000; i += 1) {
      const d = await consumeWebhookRate(
        hit,
        "ghnCallbackIp",
        `10.0.${i >> 8}.${i & 255}`,
        at(0),
        undefined,
        guard,
      );
      expect(d.allowed).toBe(true);
    }
    expect(guard.size).toBeLessThanOrEqual(100);
    // Khoá ngoài trần vẫn bị bộ đếm chung chặn đúng ngưỡng (không theo dõi cục bộ).
    const shared = new MemoryCounter();
    const full = new LocalHitGuard(1);
    await consumeWebhookRate(hitOf(shared), "ghnCallbackIp", "1.1.1.1", at(0), undefined, full);
    const outs: boolean[] = [];
    for (let i = 0; i < limit + 5; i += 1)
      outs.push(
        (await consumeWebhookRate(hitOf(shared), "ghnCallbackIp", "2.2.2.2", at(0), undefined, full)).allowed,
      );
    expect(outs.filter(Boolean)).toHaveLength(limit);
    expect(full.size).toBe(1);
  });

  it("ô cũ được dọn khi sang cửa sổ mới để nhường chỗ (không kẹt đầy mãi)", () => {
    const guard = new LocalHitGuard(10);
    for (let i = 0; i < 10; i += 1) guard.reserve(`b${i}`, limit, 10_000, at(0));
    expect(guard.reserve("moi", limit, 10_000, at(1_000))).toMatchObject({ ticket: null }); // đầy, chưa có ô cũ
    const later = guard.reserve("moi", limit, 10_000, at(30_000)); // 3 cửa sổ sau: ô cũ đã trôi
    expect(later).toMatchObject({ blocked: false, ticket: expect.anything() as unknown });
    expect(guard.size).toBeLessThanOrEqual(10);
  });

  it("CPU: 50 000 khoá khác nhau nằm trong ngân sách (O(1) mỗi request, không duyệt Map)", () => {
    const guard = new LocalHitGuard();
    const before = process.cpuUsage();
    for (let i = 0; i < 50_000; i += 1) guard.reserve(`webhook.ghnCallbackIp:${i}`, limit, 10_000, at(1_000));
    const used = process.cpuUsage(before);
    const ms = (used.user + used.system) / 1000;
    expect(guard.size).toBeLessThanOrEqual(10_000);
    expect(ms).toBeLessThan(1_000); // mã cũ (sweep O(n) mỗi request): ~12 000 ms
  });

  it("DB treo vắt qua ranh giới rồi lỗi: lượt giữ chỗ được trả đúng ô, guard không chặn lượt mà bộ đếm chung cho qua", async () => {
    const guard = new LocalHitGuard();
    const failers: Array<(e: Error) => void> = [];
    const hanging: WindowHit = () =>
      new Promise((_, reject) => {
        failers.push(reject);
      });
    const pending = Array.from({ length: limit }, () =>
      consumeWebhookRate(hanging, "ghnCallbackIp", "203.0.113.7", at(9_999), undefined, guard),
    );
    // Trong lúc 300 lượt còn treo, một request ở cửa sổ kế làm ô lăn (previous = 300). Lượt đang bay được tính để giữ trần
    // ghi DB (đánh đổi có chủ ý: chỉ xảy ra khi DB đang treo, lúc đó bộ đếm chung cũng chưa ghi được).
    const fresh = new MemoryCounter();
    expect(
      (await consumeWebhookRate(hitOf(fresh), "ghnCallbackIp", "203.0.113.7", at(10_001), undefined, guard))
        .allowed,
    ).toBe(false);
    failers.forEach((f) => f(new Error("db down"))); // DB lỗi sau khi cửa sổ đã lăn → trả chỗ vào `previous`
    expect((await Promise.all(pending)).every((d) => d.allowed)).toBe(true);
    // Bộ đếm chung trống: mọi lượt kế phải qua, có guard cũng như không (trước sửa: guard chặn vì previous = 300).
    for (let i = 0; i < 5; i += 1) {
      const withGuard = await consumeWebhookRate(
        hitOf(fresh),
        "ghnCallbackIp",
        "203.0.113.7",
        at(10_001),
        undefined,
        guard,
      );
      expect(withGuard.allowed).toBe(true);
    }
  });

  it("release trả đúng ô: cùng cửa sổ → current; lăn 1 cửa sổ → previous; lăn xa → không đổi", () => {
    const guard = new LocalHitGuard();
    const rsv = (t: number) => guard.reserve("b", 5, 10_000, at(t));
    const ticket = (r: ReturnType<typeof rsv>) => (r.blocked ? null : r.ticket);
    const t1 = ticket(rsv(9_999));
    guard.reserve("b", 5, 10_000, at(10_500)); // ô lăn: previous = 1, current = 1
    guard.release(t1); // phải giảm previous
    // 4 lượt nữa ở cửa sổ này: hiệu dụng (current 1 + 4)=5 + previous 0 → vẫn ≤ 5; lượt thứ 6 mới bị chặn
    for (let i = 0; i < 4; i += 1) expect(rsv(10_500).blocked).toBe(false);
    expect(rsv(10_500).blocked).toBe(true);
  });
});
