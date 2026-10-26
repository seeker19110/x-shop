import { mayRegister, type InviteLookup, type InviteView } from "../register-gate";

/** Cổng đăng ký (T-138, BE-AUTH-003): danh sách cho phép, mọi ca khác `false` (route trả cùng một phản hồi). */
const NOW = new Date(Date.UTC(2026, 9, 26, 12, 0, 0));
const later = new Date(NOW.getTime() + 60_000);
const earlier = new Date(NOW.getTime() - 1);

function lookup(tokens: Record<string, InviteView>, pending: string[] = []) {
  const calls = { byToken: [] as string[], pending: [] as string[] };
  const l: InviteLookup = {
    byToken: async (t) => {
      calls.byToken.push(t);
      return tokens[t] ?? null;
    },
    pendingForEmail: async (e) => {
      calls.pending.push(e);
      return pending.includes(e);
    },
  };
  return { l, calls };
}

const base = { actorType: "user", provider: "emailpass", email: "nv@x-shop.test", inviteToken: undefined };

describe("mayRegister (register-gate)", () => {
  it("không token: chỉ khi có lời mời còn hạn cho ĐÚNG email (luồng dashboard Medusa)", async () => {
    const { l } = lookup({}, ["nv@x-shop.test"]);
    expect(await mayRegister(base, l, NOW)).toBe(true);
    expect(await mayRegister({ ...base, email: "NV@x-shop.test" }, l, NOW)).toBe(false);
    expect(await mayRegister({ ...base, email: "khac@x-shop.test" }, l, NOW)).toBe(false);
    expect(await mayRegister({ ...base, inviteToken: null }, l, NOW)).toBe(true);
  });

  it("token hợp lệ đúng email → cho; sai email / đã nhận / hết hạn (kể cả đúng mốc) / không hợp lệ → từ chối", async () => {
    const inv = (o: Partial<InviteView> = {}): InviteView => ({
      email: "nv@x-shop.test",
      accepted: false,
      expires_at: later,
      ...o,
    });
    const { l } = lookup(
      {
        ok: inv(),
        okIso: inv({ expires_at: later.toISOString() }),
        other: inv({ email: "khac@x-shop.test" }),
        accepted: inv({ accepted: true }),
        expired: inv({ expires_at: earlier }),
        edge: inv({ expires_at: NOW }),
      },
      ["nv@x-shop.test"],
    );
    expect(await mayRegister({ ...base, inviteToken: "ok" }, l, NOW)).toBe(true);
    expect(await mayRegister({ ...base, inviteToken: "okIso" }, l, NOW)).toBe(true);
    for (const t of ["other", "accepted", "expired", "edge", "khong-co"]) {
      // Có lời mời chờ theo email cũng KHÔNG cứu token sai: đã gửi token thì token quyết định.
      expect(await mayRegister({ ...base, inviteToken: t }, l, NOW)).toBe(false);
    }
  });

  it("actor/provider khác chính xác 'user'/'emailpass' → từ chối, không tra lời mời", async () => {
    const { l, calls } = lookup({}, ["nv@x-shop.test"]);
    for (const [actorType, provider] of [
      ["customer", "emailpass"],
      ["USER", "emailpass"],
      ["user", "EMAILPASS"],
      ["foo", "emailpass"],
      ["user", "google"],
      [undefined, undefined],
      [["user"], "emailpass"],
    ] as const) {
      expect(await mayRegister({ ...base, actorType, provider }, l, NOW)).toBe(false);
    }
    expect(calls).toEqual({ byToken: [], pending: [] });
  });

  it("email/token rỗng, sai kiểu, quá dài → từ chối, không tra lời mời", async () => {
    const { l, calls } = lookup({}, [""]);
    for (const email of ["", undefined, null, 42, ["nv@x-shop.test"], { $ne: "" }, `${"a".repeat(320)}@x`]) {
      expect(await mayRegister({ ...base, email }, l, NOW)).toBe(false);
    }
    for (const inviteToken of ["", 0, false, ["ok"], { a: 1 }, "t".repeat(4097)]) {
      expect(await mayRegister({ ...base, inviteToken }, l, NOW)).toBe(false);
    }
    expect(calls).toEqual({ byToken: [], pending: [] });
  });

  it("email Unicode: so khớp đúng chuỗi (không chuẩn hoá), không lỗi", async () => {
    const { l } = lookup({}, ["nhân.viên@x-shop.test"]);
    expect(await mayRegister({ ...base, email: "nhân.viên@x-shop.test" }, l, NOW)).toBe(true);
    expect(await mayRegister({ ...base, email: "nhân.viên@x-shop.test" }, l, NOW)).toBe(false);
  });
});
