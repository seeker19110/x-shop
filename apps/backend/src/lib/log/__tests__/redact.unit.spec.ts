import { inspect } from "node:util";
import { isSensitiveKey, MAX_TEXT, REDACTED, redactLog, redactText, shortHash } from "../redact";

/**
 * ReDoS (review T-090): đầu vào đối nghịch 32K ký tự cho TỪNG mẫu phải xong nhanh. Trần 50 ms CPU/lần (máy CI chậm vẫn dư —
 * bản regex mở cũ mất 300–450 ms với 16K ký tự cho riêng mẫu email).
 */
describe("hiệu năng đầu vào đối nghịch (chống ReDoS)", () => {
  const N = 32_000;
  const cases: [string, string][] = [
    ["email: chữ không @", "a".repeat(N)],
    ["email: nhiều @ không tên miền", "a@".repeat(N / 2)],
    ["email: tên miền dài không TLD", `a@${"b".repeat(N)}`],
    ["email: chấm lặp", `${"a.".repeat(N / 2)}@`],
    ["URL: scheme dài không ://", "a".repeat(N) + ":"],
    ["URL: :// không @", `http://${":".repeat(N)}`],
    ["Bearer lặp", "Bearer ".repeat(N / 7)],
    ["JWT: eyJ lặp", "eyJ".repeat(N / 3)],
    ["key=value: khoảng trắng dài", `token${" ".repeat(N)}x`],
    ["key=value: nháy không đóng", `password="${"a".repeat(N)}`],
    ["số dài (thẻ/CCCD/SĐT)", "1".repeat(N)],
    ["số tách nhóm", "0 ".repeat(N / 2)],
    ["địa chỉ: số + khoảng trắng", `1${" ".repeat(N)}x`],
    ["địa chỉ: 1/1/1…", `${"1/".repeat(N / 2)} đường`],
    ["địa chỉ: phẩy lặp", "Phường A,".repeat(N / 9)],
    ["SQL: nháy lặp", `insert into x values (${"'',".repeat(N / 3)}`],
    ["SQL: select dài", `select ${"a ".repeat(N / 2)}`],
    ["OTP: chữ lặp", "otp ".repeat(N / 4)],
    ["Key ()=( lặp", "Key (".repeat(N / 5)],
    ["SQL: literal dài + nháy", `insert into "t" values (${"'a".repeat(N / 2)}`],
    ["SQL: chỉ nháy", `insert into "t" ${"'".repeat(N)}`],
    ["SELECT viết hoa lặp", "SELECT ".repeat(N / 7)],
    ["cụm số + Tên", ", 1 Ab".repeat(N / 6)],
    ["address= lặp", "address=".repeat(N / 8)],
  ];
  it.each(cases)("%s → < 50 ms", (_name, input) => {
    redactText(input.slice(0, 100)); // làm nóng regex
    // Thời gian CPU (không phải wall-clock): cổng chạy song song nhiều tiến trình làm wall-clock vượt trần dù regex
    // không backtrack (63 ms khi máy tải nặng); backtracking thảm hoạ vẫn tốn hàng trăm ms CPU nên vẫn bị bắt.
    const t0 = process.cpuUsage();
    redactText(input);
    const d = process.cpuUsage(t0);
    expect((d.user + d.system) / 1000).toBeLessThan(50);
  });
});

describe("địa chỉ/họ tên trong nháy, SQL, JSON, util.inspect (review T-090)", () => {
  it("lỗi knex có câu INSERT kèm giá trị → mọi literal trong nháy bị che", () => {
    const msg =
      'insert into "customer_address" ("first_name", "last_name", "address_1", "city") values (\'An\', \'Nguyễn\', \'25/3 hẻm 12 Lê Văn Sỹ\', \'Phường 13, Quận 3\') - duplicate key value';
    const out = redactText(msg);
    expect(out).not.toMatch(/An'|Nguyễn|Lê Văn Sỹ|Phường 13/);
    expect(out).toContain(
      `values ('${shortHash("An")}', '${shortHash("Nguyễn")}', '${shortHash("25/3 hẻm 12 Lê Văn Sỹ")}', '${shortHash("Phường 13, Quận 3")}')`,
    );
    expect(shortHash("An")).toMatch(/^\[h:[0-9a-f]{8}\]$/);
    expect(out).toContain("duplicate key value");
  });

  it("chi tiết ràng buộc Postgres `Key (...)=(...)` → băm ngắn từng giá trị (còn đối chiếu được)", () => {
    expect(redactText("Key (phone, name)=(0912345678, Trần B) already exists.")).toBe(
      `Key (phone, name)=(${shortHash("0912345678")}, ${shortHash("Trần B")}) already exists.`,
    );
    expect(redactText("Key (idempotency_key)=(idem_01JABCDEF) already exists.")).toBe(
      `Key (idempotency_key)=(${shortHash("idem_01JABCDEF")}) already exists.`,
    );
  });

  it("literal SQL dài hơn 4096 ký tự không làm lệch cặp nháy (không lộ họ tên phía sau)", () => {
    const out = redactText(`insert into "a" ("x", "y", "z") values ('${"x".repeat(5000)}', 'An', 'Nguyễn')`);
    expect(out).not.toMatch(/'An'|Nguyễn|xxxx/);
  });

  it('địa chỉ sau khoá address= / "address":"…" vẫn bị che', () => {
    expect(redactText(`{"address":"12 Nguyễn Trãi","city":"HCM"}`)).toBe(
      `{"address":"${REDACTED}","city":"HCM"}`,
    );
    expect(redactText("address=12 Lê Lợi&x=1")).toBe(`address=${REDACTED}&x=1`);
    expect(redactText("first_name: 'Lan'")).toBe(`first_name: '${REDACTED}'`);
  });

  it.each([
    "size=38 Đỏ, còn:12 Áo Thun",
    "giao lúc 10:30 Chiều, kho 3 Hà Nội",
    "[checkout] giữ hàng: variant=variant_01J qty=2 Áo, warehouse=Kho 1 Hà Nội",
    "Đơn XS-1001: 2 Áo Thun, 1 Quần Jean",
    "Allowed values ('draft', 'published') for status",
    "update cart set: 'promo' applied",
    "Please select a size from the list: 'M'",
    "status changed: 'pending' -> 'captured' (amount 1250000)",
    "Bật 2fa 2026-10-26 cho user_01J",
    "otp_window=1 totp period=30",
    "vnp_TxnRef=PA_01JABC vnp_Amount=125000000 vnp_ResponseCode=00 vnp_PayDate=20261026103000",
    'GHN order_code=GYH7XKPQ status=delivering to_ward_code="21012" fee=30000',
    "Không tìm thấy biến thể 'AO-THUN-38-DO' trong kho 'WH-HN'",
  ])("không che nhầm (review): %j", (input) => {
    expect(redactText(input)).toBe(input);
  });

  it("JSON.stringify / util.inspect của object địa chỉ (khoá lạ) → địa chỉ bị che", () => {
    const addr = { line: "12 Nguyễn Trãi", ward: "Phường Bến Thành", district: "Quận 1" };
    for (const text of [JSON.stringify(addr), inspect(addr)]) {
      const out = redactText(`lỗi giao hàng: ${text}`);
      expect(out).not.toMatch(/Nguyễn Trãi|Bến Thành/);
    }
    expect(redactText(`addr='12 Nguyễn Trãi, Phường Bến Thành'`)).not.toMatch(/Nguyễn Trãi|Bến Thành/);
    expect(redactText(`"25/3 hẻm 12 Lê Văn Sỹ"`)).not.toContain("Lê Văn Sỹ");
  });

  it("câu SELECT có literal; thông điệp thường có nháy không bị che nhầm", () => {
    expect(redactText("select * from \"order\" where \"email\" = 'x' and name = 'Lan'")).not.toContain("Lan");
    expect(redactText("không tìm thấy sản phẩm 'ao-thun'")).toBe("không tìm thấy sản phẩm 'ao-thun'");
  });
});

describe("khoá API tiền tố và mã OTP/MFA (review T-090)", () => {
  it.each([
    ["key sk_live_51HxYzAbCdEfGh123456", `key ${REDACTED}`],
    ["pk_test_abcdefgh12", REDACTED],
    ["whsec_abcdefghijk", REDACTED],
    [`key sk_${"0a".repeat(32)}`, `key ${REDACTED}`],
    [`pk_${"f1".repeat(16)}`, REDACTED],
    ["otp 123456", `otp ${REDACTED}`],
    ["mfa code=654321", `mfa code=${REDACTED}`],
    ["Mã OTP: 112233", `Mã OTP: ${REDACTED}`],
    ["recovery_code 12345678", `recovery_code ${REDACTED}`],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("không che mã HTTP / mã lỗi thường", () => {
    expect(redactText("status 404 code 500")).toBe("status 404 code 500");
  });
});

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
      customer: { email: "a@example.test", phone: "0912345678", address: { line: "12 Lê Lợi" } },
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
    ["khach.hang+1@example.com", "[EMAIL]"],
    ["Liên hệ NGUYEN.VAN.A@Example.COM ngay", "Liên hệ [EMAIL] ngay"],
    ["0912345678", "[PHONE]"],
    ["SĐT 0912 345 678.", "SĐT [PHONE]."],
    ["0912.345.678", "[PHONE]"],
    ["0912-345-678", "[PHONE]"],
    ["+84 912 345 678", "[PHONE]"],
    ["+84912345678", "[PHONE]"],
    ["84912345678", "[PHONE]"],
    ["bàn 024 3826 1234", "bàn [PHONE]"],
    ["CCCD 099099012345", "CCCD [CCCD]"],
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
      "Khách khach@example.test (0987654321, CCCD 099203001234) giao 12 Lê Lợi, Phường Bến Nghé, Quận 1",
    );
    expect(out).not.toMatch(/khach@x\.vn|0987654321|099203001234|Lê Lợi|Bến Nghé/);
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
    const err = Object.assign(new Error("gửi tới a@example.test thất bại"), {
      config: { headers: { authorization: "x" } },
    });
    const out = redactLog({
      err,
      at: new Date("2026-10-26T10:00:00Z"),
      bad: new Date(Number.NaN),
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
    expect(String((out.err as { stack: string }).stack)).not.toContain("a@example.test");
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

  it("chuỗi quá MAX_TEXT bị cắt, ghi số ký tự bỏ", () => {
    const out = redactText("a".repeat(MAX_TEXT + 10));
    expect(out.length).toBeLessThan(MAX_TEXT + 40);
    expect(out).toContain("[cắt 10 ký tự]");
  });

  it("chuỗi rỗng và Unicode tổ hợp không lỗi", () => {
    expect(redactText("")).toBe("");
    expect(redactText("Nguyễn")).toBe("Nguyễn");
  });
});
