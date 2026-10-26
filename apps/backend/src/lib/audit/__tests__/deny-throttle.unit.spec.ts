import {
  decideDenyAudit,
  DENY_AUDIT_THROTTLE,
  denyBucket,
  isRecordedOccurrence,
  type DenyGroup,
  type WindowCounter,
} from "../deny-throttle";

/** Bộ đếm cửa sổ cố định trong bộ nhớ, cùng ngữ nghĩa với `hitRateCounter` (Postgres). */
function memoryCounter(): WindowCounter & { buckets: Map<string, number> } {
  const buckets = new Map<string, number>();
  const fn = (async (bucket: string, windowMs: number, now: Date) => {
    const key = `${bucket}@${Math.floor(now.getTime() / windowMs)}`;
    await Promise.resolve(); // nhường lượt như I/O thật
    const n = (buckets.get(key) ?? 0) + 1;
    buckets.set(key, n);
    return n;
  }) as WindowCounter & { buckets: Map<string, number> };
  fn.buckets = buckets;
  return fn;
}

const group: DenyGroup = {
  actorType: "user",
  actorId: "user_1",
  method: "POST",
  routeClass: "perm:refund.execute",
  reason: "missing_permission",
};
const t0 = new Date("2026-10-25T00:00:00.000Z");

describe("isRecordedOccurrence", () => {
  it("ghi lần 1, 10, 100, 1000; bỏ phần còn lại; số bất thường → ghi", () => {
    const recorded = Array.from({ length: 1000 }, (_, i) => i + 1).filter(isRecordedOccurrence);
    expect(recorded).toEqual([1, 10, 100, 1000]);
    for (const odd of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isRecordedOccurrence(odd)).toBe(true);
    }
    expect(isRecordedOccurrence(20)).toBe(false);
    expect(isRecordedOccurrence(110)).toBe(false);
  });
});

describe("decideDenyAudit (gộp theo actor, lớp route, lý do trong cửa sổ)", () => {
  it("12 lần liên tiếp cùng nhóm → ghi lần 1 và 10, kèm occurrence + cửa sổ", async () => {
    const counter = memoryCounter();
    const out = [];
    for (let i = 0; i < 12; i++) out.push(await decideDenyAudit(counter, group, t0));
    expect(out.filter((d) => d.record)).toEqual([
      { record: true, occurrence: 1, window_seconds: DENY_AUDIT_THROTTLE.windowMs / 1000 },
      { record: true, occurrence: 10, window_seconds: DENY_AUDIT_THROTTLE.windowMs / 1000 },
    ]);
    expect(out[11]).toEqual({ record: false, occurrence: 12 });
  });

  it("khác actor / lớp route / lý do / method / loại actor → nhóm riêng, mỗi nhóm được ghi lần đầu", async () => {
    const counter = memoryCounter();
    expect((await decideDenyAudit(counter, group, t0)).record).toBe(true);
    expect((await decideDenyAudit(counter, group, t0)).record).toBe(false);
    for (const other of [
      { ...group, actorId: "user_2" },
      { ...group, actorId: null },
      { ...group, routeClass: "perm:audit.read" },
      { ...group, reason: "UNDECLARED_ROUTE" },
      { ...group, method: "GET" },
      { ...group, actorType: "api-key" },
    ]) {
      expect({ other, d: await decideDenyAudit(counter, other, t0) }).toMatchObject({
        other,
        d: { record: true, occurrence: 1 },
      });
    }
  });

  it("biên cửa sổ: lần cuối cửa sổ cũ bị gộp, ms đầu cửa sổ mới ghi lại từ 1", async () => {
    const counter = memoryCounter();
    const start = new Date(
      Math.floor(t0.getTime() / DENY_AUDIT_THROTTLE.windowMs) * DENY_AUDIT_THROTTLE.windowMs,
    );
    expect((await decideDenyAudit(counter, group, start)).record).toBe(true);
    const lastMs = new Date(start.getTime() + DENY_AUDIT_THROTTLE.windowMs - 1);
    expect(await decideDenyAudit(counter, group, lastMs)).toEqual({ record: false, occurrence: 2 });
    const next = new Date(start.getTime() + DENY_AUDIT_THROTTLE.windowMs);
    expect(await decideDenyAudit(counter, group, next)).toMatchObject({ record: true, occurrence: 1 });
  });

  it("đồng thời: 25 lần song song cùng nhóm (bộ đếm nguyên tử) → đúng 2 lần ghi (1 và 10)", async () => {
    const counter = memoryCounter();
    const all = await Promise.all(Array.from({ length: 25 }, () => decideDenyAudit(counter, group, t0)));
    expect(all.filter((d) => d.record).map((d) => d.occurrence)).toEqual([1, 10]);
  });

  it("bộ đếm lỗi → vẫn ghi (occurrence null) và báo lỗi qua callback", async () => {
    const errors: unknown[] = [];
    const broken: WindowCounter = async () => {
      throw new Error("db down");
    };
    const d = await decideDenyAudit(broken, group, t0, (e) => errors.push(e));
    expect(d).toEqual({
      record: true,
      occurrence: null,
      window_seconds: DENY_AUDIT_THROTTLE.windowMs / 1000,
    });
    expect(errors).toHaveLength(1);
  });

  it("khóa bộ đếm là băm — không chứa actor id/route thô; phân tách trường không nhập nhằng", () => {
    const b = denyBucket(group);
    expect(b).toMatch(/^audit\.rbac_denied:[0-9a-f]{40}$/);
    expect(b).not.toContain("user_1");
    // "a" + "bc" khác "ab" + "c" (dùng ký tự phân tách NUL).
    expect(denyBucket({ ...group, method: "a", routeClass: "bc" })).not.toBe(
      denyBucket({ ...group, method: "ab", routeClass: "c" }),
    );
  });
});
