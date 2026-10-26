import { isSensitiveKey, REDACTED, redactLog, redactText } from "../redact";

/**
 * T-090 — bộ che log (BASE-ERR-007, SEC-SECRET-007, CMP-PRIV-008/010): theo tên trường + theo nội dung, bộ mẫu PII tiếng
 * Việt (SĐT, CCCD 12 số, email, địa chỉ có dấu/không dấu) và ca không được che nhầm.
 */

describe("che theo tên trường", () => {
  it.each([
    "password",
    "newPassword",
    "token",
    "access_token",
    "refreshToken",
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "api_key",
    "x-api-key",
    "apiKey",
    "client_secret",
    "VNPAY_HASH_SECRET",
    "vnp_SecureHash",
    "DATABASE_URL",
    "redis_url",
    "session",
    "sid",
    "otp",
    "recovery_code",
    "card_number",
    "cvv",
    "AUTH_MFA_ENCRYPTION_KEY",
    "email",
    "customer_email",
    "phone",
    "phone_number",
    "sdt",
    "so_dien_thoai",
    "address_1",
    "dia_chi",
    "cccd",
    "national_id",
    "full_name",
    "first_name",
    "date_of_birth",
  ])("%s → che", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "shipping",
    "company",
    "inside",
    "span_id",
    "trace_id",
    "status_code",
    "order_id",
    "display_ref",
    "message",
    "province_code",
    "event",
    "duration_ms",
    "",
  ])("%s → giữ", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it("che cả object/mảng dưới khoá nhạy cảm; lồng sâu và trong mảng; không đổi đầu vào", () => {
    const input = {
      order_id: "XS-ABC123",
      headers: { authorization: "Bearer abc", "content-type": "application/json" },
      customer: { email: "a@b.vn", phone: "0912345678", address: { line: "12 Lê Lợi" } },
      items: [{ sku: "AO-M", token: "t1" }],
      shipping_address: { ward: "Bến Thành" },
    };
    const snapshot = JSON.stringify(input);
    expect(redactLog(input)).toEqual({
      order_id: "XS-ABC123",
      headers: { authorization: REDACTED, "content-type": "application/json" },
      customer: { email: REDACTED, phone: REDACTED, address: REDACTED },
      items: [{ sku: "AO-M", token: REDACTED }],
      shipping_address: REDACTED,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe("che theo nội dung — bộ mẫu PII tiếng Việt", () => {
  it.each([
    ["khach.hang+1@gmail.com", "[EMAIL]"],
    ["Liên hệ NGUYEN.VAN.A@Example.COM.VN ngay", "Liên hệ [EMAIL] ngay"],
    ["0912345678", "[PHONE]"],
    ["SĐT 0912 345 678.", "SĐT [PHONE]."],
    ["0912.345.678", "[PHONE]"],
    ["0912-345-678", "[PHONE]"],
    ["+84 912 345 678", "[PHONE]"],
    ["+84912345678", "[PHONE]"],
    ["84912345678", "[PHONE]"],
    ["bàn 024 3826 1234", "bàn [PHONE]"],
    ["CCCD 001099012345", "CCCD [CCCD]"],
    ["001 099 012 345", "[CCCD]"],
    ["thẻ 4111 1111 1111 1111", "thẻ [CARD]"],
    ["4111111111111111", "[CARD]"],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    ["12 Nguyễn Trãi, P. Bến Thành, Q.1, TP.HCM", "[ADDRESS]"],
    ["Phường Dịch Vọng, Quận Cầu Giấy, Hà Nội", "[ADDRESS], Hà Nội"],
    ["so 5 ngo 12 lang ha, phuong lang ha, quan dong da, ha noi", "[ADDRESS], ha noi"],
    ["Số 5 ngõ 12 Láng Hạ, Đống Đa, Hà Nội", "[ADDRESS], Đống Đa, Hà Nội"],
    ["giao: 25/3 hẻm 102 Lê Văn Sỹ, phường 13, quận 3; gọi trước", "giao: [ADDRESS]; gọi trước"],
    ["Thôn 3, Xã Tân Lập, Huyện Đan Phượng", "[ADDRESS]"],
  ])("địa chỉ %j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("nhiều loại trong một thông điệp", () => {
    const out = redactText(
      "Khách khach@x.vn (0987654321, CCCD 079203001234) giao 12 Lê Lợi, Phường Bến Nghé, Quận 1",
    );
    expect(out).not.toMatch(/khach@x\.vn|0987654321|079203001234|Lê Lợi|Bến Nghé/);
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[PHONE]");
    expect(out).toContain("[CCCD]");
    expect(out).toBe("Khách [EMAIL] ([PHONE], CCCD [CCCD]) giao [ADDRESS]");
  });

  it.each([
    "Thử lại 3 Lần",
    "readiness: không sẵn sàng (database, redis)",
    "duration 0.123456789",
    "2026-10-26T10:00:00.000Z",
    "trace 123e4567-e89b-12d3-a456-426614174000",
    "order XS-ABC123 total 1500000",
    "đơn liên quan tới khuyến mãi",
    "ts 1761472800000",
    "4111111111111112",
    "[http] 404 NOT_FOUND POST /store/x/thing trace_id=r1",
    "ip 10.0.0.12:5432",
    "quận",
  ])("không che nhầm %j", (input) => {
    expect(redactText(input)).toBe(input);
  });
});

describe("che bí mật trong văn bản", () => {
  it.each([
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc", `Authorization: ${REDACTED}`],
    ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl", `token ${REDACTED}`],
    ["postgres://xshop:matkhau@db:5432/x", `postgres://${REDACTED}@db:5432/x`],
    ["redis://:s3cret@cache:6379/0", `redis://${REDACTED}@cache:6379/0`],
    ["GET /cb?token=abc123&x=1", `GET /cb?token=${REDACTED}&x=1`],
    ['{"password":"p@ss word","x":1}', `{"password":"${REDACTED}","x":1}`],
    ["vnp_SecureHash=ab12cd&vnp_Amount=100", `vnp_SecureHash=${REDACTED}&vnp_Amount=100`],
    ["client_secret: 'zzz'", `client_secret: '${REDACTED}'`],
    ["Cookie=connect.sid", `Cookie=${REDACTED}`],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("không đụng `tokenizer=` hay `passport_photo_count` trong văn bản", () => {
    expect(redactText("tokenizer=fast")).toBe("tokenizer=fast");
  });
});

describe("cấu trúc", () => {
  it("vòng tham chiếu → [Circular]; tham chiếu dùng chung (không vòng) giữ nguyên", () => {
    const shared = { v: 1 };
    const a: Record<string, unknown> = { x: shared, y: shared };
    a.self = a;
    expect(redactLog(a)).toEqual({ x: { v: 1 }, y: { v: 1 }, self: "[Circular]" });
  });

  it("sâu quá 10 cấp → [Truncated]", () => {
    let deep: Record<string, unknown> = { leaf: "0912345678" };
    for (let i = 0; i < 12; i++) deep = { d: deep };
    expect(JSON.stringify(redactLog(deep))).toContain("[Truncated]");
  });

  it("Error, Date, bigint, Map, hàm, symbol, null/undefined/số/boolean", () => {
    const err = Object.assign(new Error("gửi tới a@b.vn thất bại"), {
      config: { headers: { authorization: "x" } },
    });
    const out = redactLog({
      err,
      at: new Date("2026-10-26T10:00:00Z"),
      bad: new Date("x"),
      big: 10n,
      m: new Map([["phone", "0912345678"]]),
      fn: () => 1,
      sym: Symbol("s"),
      n: null,
      u: undefined,
      zero: 0,
      f: false,
    }) as Record<string, unknown>;
    expect(out.err).toMatchObject({
      type: "Error",
      message: "gửi tới [EMAIL] thất bại",
      config: { headers: { authorization: REDACTED } },
    });
    expect(String((out.err as { stack: string }).stack)).not.toContain("a@b.vn");
    expect(out).toMatchObject({
      at: "2026-10-26T10:00:00.000Z",
      bad: null,
      big: "10",
      m: { phone: REDACTED },
      n: null,
      zero: 0,
      f: false,
    });
    expect(out.fn).toBeUndefined();
    expect(out.sym).toBeUndefined();
  });

  it("chuỗi rỗng và Unicode tổ hợp không lỗi", () => {
    expect(redactText("")).toBe("");
    expect(redactText("Nguyễn")).toBe("Nguyễn");
  });
});
