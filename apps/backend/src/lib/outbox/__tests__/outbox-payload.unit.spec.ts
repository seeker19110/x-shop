import { assertOutboxPayload, isSecretKey, OUTBOX_PAYLOAD_TYPES, validateOutboxPayload } from "../payload";

/** T-093 — BE-JOB-007: schema payload outbox kiểm khi worker nhận; sai → lý do ngắn, không chứa giá trị (PII). */
describe("validateOutboxPayload", () => {
  const ORDER = "order_01JABCDEF0123456789";

  it("payload đúng của mọi producer hiện có → ok", () => {
    const good: Array<[string, Record<string, unknown>]> = [
      [
        "order.placed_pending",
        { order_id: ORDER, display_ref: "XS-1", payment_method: "cod", state: "placed" },
      ],
      ["order.confirmed", { order_id: ORDER, provider_txn_id: "14000000" }],
      [
        "order.confirmed",
        { order_id: ORDER, display_ref: "XS-1", payment_method: "cod", confirmed_by: "user_1" },
      ],
      ["payment.native_sync", { order_id: ORDER, amount: 499_000 }],
      ["order.cancelled", { order_id: ORDER, reason: "HOLD_EXPIRED", from: "placed", refund_amount: 0 }],
      ["shipment.shipped", { order_id: ORDER, shipment_id: "shp_1", provider_order_code: "GHN1" }],
      // T-149: chỉ ID — token/link phát hành lúc gửi.
      ["order.lookup_link", { order_id: ORDER, display_ref: "XS-1" }],
      ["order.lookup_link", { order_id: ORDER }],
      // Loại chưa khai schema riêng: chỉ kiểm chung.
      ["test.count", { i: 3 }],
      ["test.fail", {}],
    ];
    for (const [type, payload] of good) expect(validateOutboxPayload(type, payload)).toEqual({ ok: true });
    expect(OUTBOX_PAYLOAD_TYPES).toEqual(
      expect.arrayContaining([
        "order.placed_pending",
        "order.confirmed",
        "order.lookup_link",
        "shipment.shipped",
      ]),
    );
  });

  it("thiếu/sai trường bắt buộc → lý do nêu đường dẫn + mã lỗi, KHÔNG nêu giá trị", () => {
    const r1 = validateOutboxPayload("order.confirmed", { display_ref: "XS-1" });
    expect(r1).toEqual({ ok: false, reason: expect.stringContaining("order_id:") });
    const r2 = validateOutboxPayload("order.placed_pending", { order_id: "an@example.test" });
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toContain("an@example.test");
    expect(validateOutboxPayload("order.lookup_link", { display_ref: "XS-1" }).ok).toBe(false);
    expect(
      validateOutboxPayload("order.placed_pending", { order_id: ORDER, payment_method: "bitcoin" }).ok,
    ).toBe(false);
  });

  it("T-149 — order.lookup_link: token thô hoặc link (URL mang token) trong payload → sai, lý do không chứa giá trị", () => {
    const token = "b3JkZXJfMDFKQUJDLjE3OTMwODkxNzc.VYNAshDkEYz6xG1PqTp-X_NqqTutjaELj96nugj26D8";
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ order_id: ORDER, display_ref: "XS-1", token, expires_at: "2026-10-27T08:19:37.555Z" }, "token:"],
      [{ order_id: ORDER, link: `https://shop.example.vn/tra-cuu-don/xac-thuc?token=${token}` }, "link:"],
      [{ order_id: ORDER, link: "javascript:alert(1)" }, "link:"],
      [{ order_id: ORDER, link: null }, "link:"],
    ];
    for (const [payload, field] of cases) {
      const r = validateOutboxPayload("order.lookup_link", payload);
      expect(r).toEqual({ ok: false, reason: expect.stringContaining(field) });
      expect(JSON.stringify(r)).not.toContain(token);
    }
    expect(
      validateOutboxPayload("order.placed_pending", { order_id: ORDER, payment_method: "bitcoin" }).ok,
    ).toBe(false);
  });

  it("tiền: số nguyên an toàn ≥ 0 — số thực, âm, vượt 2^53, chuỗi → sai", () => {
    for (const amount of [1.5, -1, 2 ** 53, "499000", Number.NaN]) {
      expect(validateOutboxPayload("payment.native_sync", { order_id: ORDER, amount }).ok).toBe(false);
    }
    expect(validateOutboxPayload("payment.native_sync", { order_id: ORDER, amount: 0 }).ok).toBe(true);
  });

  it("không phải object phẳng (null, mảng, chuỗi, object lồng = object đã serialize) → sai", () => {
    for (const payload of [null, undefined, "x", 42, [ORDER], { order_id: ORDER, cart: { items: [] } }]) {
      const r = validateOutboxPayload("order.confirmed", payload);
      expect(r.ok).toBe(false);
    }
    expect(validateOutboxPayload("test.x", { nested: [1, 2] }).ok).toBe(false);
  });

  it("giới hạn kích thước: > 32 khoá hoặc chuỗi > 2000 ký tự → sai", () => {
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
    expect(validateOutboxPayload("test.x", many).ok).toBe(false);
    expect(validateOutboxPayload("test.x", { note: "a".repeat(2001) }).ok).toBe(false);
    expect(validateOutboxPayload("test.x", { note: "ă".repeat(2000) }).ok).toBe(true);
  });

  it("khoá gợi bí mật (password/token/secret…) bị từ chối ở mọi loại sự kiện", () => {
    for (const key of [
      "password",
      "token",
      "accessToken",
      "vnp_secret",
      "api_key",
      "apiKey",
      "otp",
      "card_number",
    ]) {
      const r = validateOutboxPayload("order.confirmed", { order_id: ORDER, [key]: "x" });
      expect(r).toEqual({ ok: false, reason: expect.stringContaining(`${key}:custom`) });
    }
  });
});

describe("isSecretKey", () => {
  it("theo từ, không theo chuỗi con", () => {
    for (const k of [
      "password",
      "Password",
      "user_password",
      "refreshToken",
      "x-api-key",
      "SESSION",
      "pan",
      "cvv",
    ])
      expect(isSecretKey(k)).toBe(true);
    for (const k of [
      "company",
      "japan",
      "passenger_count",
      "order_id",
      "provider_txn_id",
      "display_ref",
      "tokens_used",
    ])
      expect(isSecretKey(k)).toBe(false);
  });
});

describe("assertOutboxPayload (kiểm lúc ghi — T-149)", () => {
  const ORDER = "order_01JABCDEF0123456789";
  it("đúng → không ném; sai → ném nêu loại + trường, không nêu giá trị", () => {
    expect(() => assertOutboxPayload("order.lookup_link", { order_id: ORDER })).not.toThrow();
    expect(() => assertOutboxPayload("test.fail", {})).not.toThrow();
    expect(() =>
      assertOutboxPayload("order.confirmed", { order_id: ORDER, password: "mk-bi-mat-1" }),
    ).toThrow(/^\[outbox\] order\.confirmed: payload không hợp lệ — password:custom$/);
    try {
      assertOutboxPayload("order.placed_pending", { order_id: "an@example.test" });
      throw new Error("phải ném");
    } catch (e) {
      expect((e as Error).message).toContain("order_id:");
      expect((e as Error).message).not.toContain("an@example.test");
    }
  });
});
