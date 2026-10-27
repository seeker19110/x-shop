import { vnpay } from "@x-shop/domain";
import { parseEnv, VNPAY_DEV_DEFAULTS } from "../../env";
import { MockModeVnpayGateway } from "../../checkout/vnpay-gateway";
import {
  interpretQueryResponseWithRotation,
  verificationSecrets,
  verifyNotificationWithRotation,
} from "../vnpay-secrets";

const CURRENT = "vnpay-khoa-hien-tai-0123456789abcdef0123";
const PREVIOUS = "vnpay-khoa-truoc-0123456789abcdef012345";
const OTHER = "vnpay-khoa-la-0123456789abcdef0123456789";
const TMN = "XSHOPTEST";

const rotating = { tmnCode: TMN, hashSecret: CURRENT, hashSecretPrevious: PREVIOUS };
const single = { tmnCode: TMN, hashSecret: CURRENT, hashSecretPrevious: null };

const PAYMENT_CFG: vnpay.VnpayConfig = {
  tmnCode: TMN,
  hashSecret: CURRENT,
  paymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  apiUrl: "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction",
  returnUrl: "https://shop.example.vn/thanh-toan/ket-qua",
};

const paymentUrl = () =>
  vnpay.buildPaymentUrl(PAYMENT_CFG, {
    txnRef: "PA01HXYZ",
    amount: 350_000,
    orderInfo: "Thanh toan don X1",
    ipAddr: "127.0.0.1",
    createdAt: new Date("2026-10-26T03:00:00Z"),
    expiresAt: new Date("2026-10-26T03:15:00Z"),
  });

/** IPN "đã trả" do VNPAY ký bằng `secret`. */
const ipnSignedWith = (secret: string) =>
  new vnpay.MockVnpayGateway({ tmnCode: TMN, hashSecret: secret }).pay(paymentUrl(), "success");

describe("verificationSecrets", () => {
  it("hiện tại trước, khoá trước sau; trống/null/trùng → chỉ khoá hiện tại", () => {
    expect(verificationSecrets(rotating).map((k) => k.used)).toEqual(["current", "previous"]);
    expect(verificationSecrets(rotating)[0]!.secret).toBe(CURRENT);
    for (const hashSecretPrevious of [null, undefined, "", CURRENT]) {
      expect(verificationSecrets({ tmnCode: TMN, hashSecret: CURRENT, hashSecretPrevious })).toEqual([
        { used: "current", secret: CURRENT },
      ]);
    }
  });
});

describe("verifyNotificationWithRotation (IPN/return)", () => {
  it("chữ ký bằng khoá hiện tại → hợp lệ (current)", () => {
    const r = verifyNotificationWithRotation(rotating, ipnSignedWith(CURRENT));
    expect(r.ok).toBe(true);
    expect(r.secretUsed).toBe("current");
  });

  it("chữ ký bằng khoá TRƯỚC trong cửa sổ xoay → hợp lệ (previous), cùng dữ liệu như khoá hiện tại", () => {
    const r = verifyNotificationWithRotation(rotating, ipnSignedWith(PREVIOUS));
    expect(r).toMatchObject({ ok: true, secretUsed: "previous" });
    if (!r.ok) throw new Error("mong đợi hợp lệ");
    expect(r.value).toMatchObject({ txnRef: "PA01HXYZ", amount: 350_000, success: true, tmnCode: TMN });
  });

  it("hết cửa sổ xoay (không đặt khoá trước) → chữ ký khoá cũ bị từ chối", () => {
    expect(verifyNotificationWithRotation(single, ipnSignedWith(PREVIOUS))).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
  });

  it("khoá lạ → INVALID_SIGNATURE", () => {
    expect(verifyNotificationWithRotation(rotating, ipnSignedWith(OTHER))).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
  });

  it.each([CURRENT, PREVIOUS])(
    "sửa 1 byte ở bất kỳ tham số ký nào (khoá %#) → INVALID_SIGNATURE",
    (secret) => {
      const good = ipnSignedWith(secret);
      for (const key of [...good.keys()].filter((k) => k !== "vnp_SecureHash")) {
        const tampered = new URLSearchParams(good);
        const v = tampered.get(key) ?? "";
        tampered.set(key, v === "" ? "x" : v.slice(0, -1) + (v.endsWith("0") ? "1" : "0"));
        expect(verifyNotificationWithRotation(rotating, tampered)).toEqual({
          ok: false,
          code: "INVALID_SIGNATURE",
        });
      }
      // Sửa 1 ký tự hex của chính chữ ký.
      const sig = good.get("vnp_SecureHash")!;
      const badSig = new URLSearchParams(good);
      badSig.set("vnp_SecureHash", (sig[0] === "a" ? "b" : "a") + sig.slice(1));
      expect(verifyNotificationWithRotation(rotating, badSig).ok).toBe(false);
    },
  );

  it("chữ ký đúng (khoá trước) nhưng merchant khác → MERCHANT_MISMATCH, không nuốt lỗi", () => {
    const p = ipnSignedWith(PREVIOUS);
    const other = Object.fromEntries([...p.entries()].filter(([k]) => k !== "vnp_SecureHash"));
    other.vnp_TmnCode = "MERCHANTKHAC";
    const signed = { ...other, vnp_SecureHash: vnpay.hmacSha512(PREVIOUS, vnpay.signData(other)) };
    expect(verifyNotificationWithRotation(rotating, signed)).toEqual({
      ok: false,
      code: "MERCHANT_MISMATCH",
    });
  });

  it("thiếu chữ ký / định dạng hỏng → không thử ra hợp lệ", () => {
    const p = ipnSignedWith(PREVIOUS);
    p.delete("vnp_SecureHash");
    expect(verifyNotificationWithRotation(rotating, p)).toEqual({ ok: false, code: "INVALID_SIGNATURE" });
  });
});

describe("ký đi luôn bằng khoá hiện tại", () => {
  it("URL thanh toán ký bằng khoá hiện tại, KHÔNG khớp khoá trước", () => {
    const url = new URL(paymentUrl());
    const params = Object.fromEntries(url.searchParams.entries());
    const sig = params.vnp_SecureHash;
    expect(sig).toBe(vnpay.hmacSha512(CURRENT, vnpay.signData(params)));
    expect(sig).not.toBe(vnpay.hmacSha512(PREVIOUS, vnpay.signData(params)));
  });

  it("querydr/refund ký bằng khoá hiện tại khi cấu hình có cả khoá trước", () => {
    const common = { requestId: "r1", ipAddr: "127.0.0.1", createdAt: new Date("2026-10-26T03:00:00Z") };
    const q = vnpay.buildQueryDr(rotating, {
      ...common,
      txnRef: "PA01",
      transactionDate: common.createdAt,
      orderInfo: "x",
    });
    const qOnlyCurrent = vnpay.buildQueryDr(single, {
      ...common,
      txnRef: "PA01",
      transactionDate: common.createdAt,
      orderInfo: "x",
    });
    expect(q.vnp_SecureHash).toBe(qOnlyCurrent.vnp_SecureHash);
  });
});

describe("interpretQueryResponseWithRotation (querydr)", () => {
  const expected = { txnRef: "PA01HXYZ", amount: 350_000 };
  const answer = (secret: string) => {
    const m = new vnpay.MockVnpayGateway({ tmnCode: TMN, hashSecret: secret });
    m.pay(paymentUrl(), "success");
    return m.query(expected.txnRef, expected.amount);
  };

  it("phản hồi ký bằng khoá hiện tại hoặc khoá trước → paid", () => {
    expect(interpretQueryResponseWithRotation(rotating, answer(CURRENT), expected).outcome).toBe("paid");
    expect(interpretQueryResponseWithRotation(rotating, answer(PREVIOUS), expected).outcome).toBe("paid");
  });

  it("khoá lạ hoặc hết cửa sổ xoay → unknown/invalid_signature (không suy diễn chưa trả)", () => {
    expect(interpretQueryResponseWithRotation(rotating, answer(OTHER), expected)).toMatchObject({
      outcome: "unknown",
      reason: "invalid_signature",
    });
    expect(interpretQueryResponseWithRotation(single, answer(PREVIOUS), expected)).toMatchObject({
      outcome: "unknown",
      reason: "invalid_signature",
    });
  });

  it("chữ ký đúng (khoá trước) nhưng sai số tiền → amount_mismatch, không bị che bởi lần thử khoá hiện tại", () => {
    expect(
      interpretQueryResponseWithRotation(rotating, answer(PREVIOUS), { ...expected, amount: 1_000 }),
    ).toMatchObject({ outcome: "unknown", reason: "amount_mismatch" });
  });

  it("MockModeVnpayGateway (VNPAY_MODE=mock) dùng xác minh xoay khoá", async () => {
    const gw = new MockModeVnpayGateway({ tmnCode: TMN, hashSecret: CURRENT, hashSecretPrevious: PREVIOUS });
    gw.mock.pay(paymentUrl(), "success");
    const r = await gw.queryStatus({
      txnRef: expected.txnRef,
      amount: expected.amount,
      transactionDate: new Date(),
      orderInfo: "x",
    });
    expect(r.outcome).toBe("paid");
  });
});

describe("env VNPAY_HASH_SECRET_PREVIOUS (zod)", () => {
  const DB = "postgres://u:p@localhost:5432/x";
  const bad = (src: Record<string, string>) => {
    const r = parseEnv({ DATABASE_URL: DB, NODE_ENV: "test", ...src });
    return r.ok ? [] : r.problems.map((p) => p.variable);
  };

  it("vắng → hashSecretPrevious = null", () => {
    const r = parseEnv({ DATABASE_URL: DB, NODE_ENV: "test" });
    expect(r.ok && r.env.vnpay?.hashSecretPrevious).toBeNull();
  });

  it("đặt hợp lệ → vào cấu hình runtime; chuỗi rỗng = không đặt", () => {
    const r = parseEnv({
      DATABASE_URL: DB,
      NODE_ENV: "test",
      VNPAY_HASH_SECRET: CURRENT,
      VNPAY_HASH_SECRET_PREVIOUS: PREVIOUS,
    });
    expect(r.ok && r.env.vnpay).toMatchObject({ hashSecret: CURRENT, hashSecretPrevious: PREVIOUS });
    const empty = parseEnv({ DATABASE_URL: DB, VNPAY_HASH_SECRET: CURRENT, VNPAY_HASH_SECRET_PREVIOUS: " " });
    expect(empty.ok && empty.env.vnpay?.hashSecretPrevious).toBeNull();
  });

  it("ngắn hơn 32 ký tự / trùng khoá hiện tại / đặt khi chưa đặt khoá hiện tại → lỗi nêu tên biến", () => {
    expect(bad({ VNPAY_HASH_SECRET: CURRENT, VNPAY_HASH_SECRET_PREVIOUS: "ngan" })).toEqual([
      "VNPAY_HASH_SECRET_PREVIOUS",
    ]);
    expect(bad({ VNPAY_HASH_SECRET: CURRENT, VNPAY_HASH_SECRET_PREVIOUS: CURRENT })).toEqual([
      "VNPAY_HASH_SECRET_PREVIOUS",
    ]);
    expect(bad({ VNPAY_HASH_SECRET_PREVIOUS: PREVIOUS })).toEqual(["VNPAY_HASH_SECRET_PREVIOUS"]);
  });

  it("production: khoá trước là khoá giả của dev → lỗi", () => {
    const production = {
      NODE_ENV: "production",
      DATABASE_URL: DB,
      REDIS_URL: "rediss://cache.example.vn:6380",
      JWT_SECRET: "jwt-0123456789abcdef0123456789abcdef",
      COOKIE_SECRET: "cookie-0123456789abcdef0123456789abcd",
      AUTH_MFA_ENCRYPTION_KEY: "mfa-0123456789abcdef0123456789abcdef0",
      ORDER_LOOKUP_SECRET: "order-0123456789abcdef0123456789abcd",
      XS_TRUSTED_PROXIES: "10.0.0.0/8",
      STOREFRONT_URL: "https://shop.example.vn",
      PRIVATE_UPLOAD_DIR: "/var/lib/xshop/private-uploads",
      STORE_CORS: "https://shop.example.vn",
      ADMIN_CORS: "https://admin.example.vn",
      AUTH_CORS: "https://admin.example.vn",
      VNPAY_MODE: "live",
      VNPAY_TMN_CODE: "XSHOPPROD",
      VNPAY_HASH_SECRET: CURRENT,
      VNPAY_PAYMENT_URL: "https://pay.vnpay.example/paymentv2/vpcpay.html",
      VNPAY_API_URL: "https://pay.vnpay.example/merchant_webapi/api/transaction",
      VNPAY_RETURN_URL: "https://shop.example.vn/thanh-toan/ket-qua",
      GHN_MODE: "live",
      GHN_BASE_URL: "https://ghn.example.vn/api",
      GHN_TOKEN: "ghn-token-0123456789",
      GHN_SHOP_ID: "123456",
    };
    expect(parseEnv(production).ok).toBe(true);
    expect(parseEnv({ ...production, VNPAY_HASH_SECRET_PREVIOUS: PREVIOUS }).ok).toBe(true);
    const r = parseEnv({ ...production, VNPAY_HASH_SECRET_PREVIOUS: VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET });
    expect(r.ok ? [] : r.problems.map((p) => p.variable)).toEqual(["VNPAY_HASH_SECRET_PREVIOUS"]);
  });
});
