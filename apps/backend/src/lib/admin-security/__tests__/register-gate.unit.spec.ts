import { acceptMatchesInvite, isUnlinkedIdentity } from "../invite-guard";
import { inviteTokenFromReferer, mayRegister, type InviteLookup, type InviteView } from "../register-gate";

/** Cổng đăng ký (T-138, BE-AUTH-003, D-075): danh sách cho phép, mọi ca khác `false` (route trả cùng một phản hồi). */
const NOW = new Date(Date.UTC(2026, 9, 26, 12, 0, 0));
const later = new Date(NOW.getTime() + 60_000);
const earlier = new Date(NOW.getTime() - 1);

const inv = (o: Partial<InviteView> = {}): InviteView => ({
  email: "nv@x-shop.test",
  accepted: false,
  expires_at: later,
  ...o,
});

function lookup(tokens: Record<string, InviteView>) {
  const calls: string[] = [];
  const l: InviteLookup = {
    byToken: async (t) => {
      calls.push(t);
      return tokens[t] ?? null;
    },
  };
  return { l, calls };
}

const TOKENS = {
  ok: inv(),
  okIso: inv({ expires_at: later.toISOString() }),
  other: inv({ email: "khac@x-shop.test" }),
  accepted: inv({ accepted: true }),
  expired: inv({ expires_at: earlier }),
  edge: inv({ expires_at: NOW }),
};

const base = {
  actorType: "user",
  provider: "emailpass",
  email: "nv@x-shop.test",
  inviteToken: undefined,
  refererToken: null,
};

describe("mayRegister (register-gate)", () => {
  it("không token (thân lẫn Referer) → từ chối, kể cả email đang có lời mời (D-075)", async () => {
    const { l, calls } = lookup(TOKENS);
    expect(await mayRegister(base, l, NOW)).toBe(false);
    expect(await mayRegister({ ...base, inviteToken: null }, l, NOW)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("token hợp lệ đúng email (thân hoặc Referer) → cho; sai email / đã nhận / hết hạn (kể cả đúng mốc) / lạ → từ chối", async () => {
    const { l } = lookup(TOKENS);
    expect(await mayRegister({ ...base, inviteToken: "ok" }, l, NOW)).toBe(true);
    expect(await mayRegister({ ...base, inviteToken: "okIso" }, l, NOW)).toBe(true);
    expect(await mayRegister({ ...base, refererToken: "ok" }, l, NOW)).toBe(true);
    expect(await mayRegister({ ...base, email: "NV@x-shop.test", inviteToken: "ok" }, l, NOW)).toBe(false);
    for (const t of ["other", "accepted", "expired", "edge", "khong-co"]) {
      expect(await mayRegister({ ...base, inviteToken: t }, l, NOW)).toBe(false);
      expect(await mayRegister({ ...base, refererToken: t }, l, NOW)).toBe(false);
    }
  });

  it("đã gửi token trong thân thì thân quyết định — token thân sai không được Referer đúng cứu", async () => {
    const { l } = lookup(TOKENS);
    expect(await mayRegister({ ...base, inviteToken: "khong-co", refererToken: "ok" }, l, NOW)).toBe(false);
    expect(await mayRegister({ ...base, inviteToken: "", refererToken: "ok" }, l, NOW)).toBe(false);
  });

  it("actor/provider khác chính xác 'user'/'emailpass' → từ chối, không tra lời mời", async () => {
    const { l, calls } = lookup(TOKENS);
    for (const [actorType, provider] of [
      ["customer", "emailpass"],
      ["USER", "emailpass"],
      ["user", "EMAILPASS"],
      ["foo", "emailpass"],
      ["user", "google"],
      [undefined, undefined],
      [["user"], "emailpass"],
    ] as const) {
      expect(await mayRegister({ ...base, actorType, provider, inviteToken: "ok" }, l, NOW)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("email/token rỗng, sai kiểu, quá dài → từ chối, không tra lời mời", async () => {
    const { l, calls } = lookup(TOKENS);
    for (const email of ["", undefined, null, 42, ["nv@x-shop.test"], { $ne: "" }, `${"a".repeat(320)}@x`]) {
      expect(await mayRegister({ ...base, email, inviteToken: "ok" }, l, NOW)).toBe(false);
    }
    for (const inviteToken of ["", 0, false, ["ok"], { a: 1 }, "t".repeat(4097)]) {
      expect(await mayRegister({ ...base, inviteToken }, l, NOW)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("email Unicode: so khớp đúng chuỗi (không chuẩn hoá NFC/NFD)", async () => {
    const { l } = lookup({ u: inv({ email: "nhân.viên@x-shop.test" }) });
    expect(await mayRegister({ ...base, email: "nhân.viên@x-shop.test", inviteToken: "u" }, l, NOW)).toBe(
      true,
    );
    expect(await mayRegister({ ...base, email: "nhân.viên@x-shop.test", inviteToken: "u" }, l, NOW)).toBe(
      false,
    );
  });
});

describe("inviteTokenFromReferer", () => {
  const host = "api.x-shop.vn";
  it("trang mời dashboard cùng host → token (http/https, '/' cuối, admin.path tuỳ biến, token mã hoá URL)", () => {
    expect(inviteTokenFromReferer(`https://${host}/app/invite?token=abc`, host)).toBe("abc");
    expect(inviteTokenFromReferer(`http://${host}/app/invite/?token=abc&x=1`, host)).toBe("abc");
    expect(inviteTokenFromReferer(`https://API.X-SHOP.VN/app/invite?token=a%2Bb`, host)).toBe("a+b");
    expect(inviteTokenFromReferer(`https://${host}/quan-tri/invite?token=abc`, host, "/quan-tri/")).toBe(
      "abc",
    );
    expect(inviteTokenFromReferer("http://localhost:9000/app/invite?token=t", "localhost:9000")).toBe("t");
  });

  it("khác host/cổng, sai đường dẫn, thiếu/trùng token, scheme lạ, rác → null", () => {
    for (const ref of [
      `https://evil.example/app/invite?token=abc`,
      `https://${host}.evil.example/app/invite?token=abc`,
      `https://${host}:8443/app/invite?token=abc`,
      `https://${host}/app/invitex?token=abc`,
      `https://${host}/app/login?token=abc`,
      `https://${host}/evil/app/invite?token=abc`,
      `https://${host}/app/invite`,
      `https://${host}/app/invite?token=`,
      `https://${host}/app/invite?token=a&token=b`,
      `javascript://${host}/app/invite?token=abc`,
      `https://${host}/app/invite?token=${"t".repeat(4097)}`,
      "khong-phai-url",
      "",
      undefined,
      ["https://x"],
    ]) {
      expect(inviteTokenFromReferer(ref, host)).toBeNull();
    }
    expect(inviteTokenFromReferer(`https://${host}/app/invite?token=abc`, undefined)).toBeNull();
    expect(inviteTokenFromReferer(`https://${host}/app/invite?token=abc`, "")).toBeNull();
  });
});

describe("acceptMatchesInvite / isUnlinkedIdentity (invite-guard)", () => {
  it("thân không đổi email; identity phải là emailpass của đúng email lời mời", () => {
    const ok = { inviteEmail: "a@x.test", bodyEmail: undefined, identityEmails: ["a@x.test"] };
    expect(acceptMatchesInvite(ok)).toBe(true);
    expect(acceptMatchesInvite({ ...ok, bodyEmail: null })).toBe(true);
    expect(acceptMatchesInvite({ ...ok, bodyEmail: "a@x.test" })).toBe(true);
    expect(acceptMatchesInvite({ ...ok, bodyEmail: "b@x.test" })).toBe(false);
    expect(acceptMatchesInvite({ ...ok, bodyEmail: "A@x.test" })).toBe(false);
    expect(acceptMatchesInvite({ ...ok, bodyEmail: "" })).toBe(false);
    expect(acceptMatchesInvite({ ...ok, identityEmails: ["c@x.test"] })).toBe(false);
    expect(acceptMatchesInvite({ ...ok, identityEmails: [] })).toBe(false);
  });

  it("chưa gắn actor = không có khoá `*_id` mang giá trị", () => {
    expect(isUnlinkedIdentity(undefined)).toBe(true);
    expect(isUnlinkedIdentity(null)).toBe(true);
    expect(isUnlinkedIdentity({})).toBe(true);
    expect(isUnlinkedIdentity({ user_id: "" })).toBe(true);
    expect(isUnlinkedIdentity({ note: "x" })).toBe(true);
    expect(isUnlinkedIdentity({ user_id: "user_1" })).toBe(false);
    expect(isUnlinkedIdentity({ customer_id: "cus_1" })).toBe(false);
  });
});
