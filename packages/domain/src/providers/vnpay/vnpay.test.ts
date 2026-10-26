import { describe, expect, it } from "vitest";
import { MockVnpayGateway } from "./mock.js";
import {
  IPN_RESPONSES,
  buildPaymentUrl,
  buildQueryDr,
  buildReturnUrl,
  buildRefund,
  fromVnpDate,
  hmacSha512,
  interpretQueryResponse,
  sanitizeOrderInfo,
  signData,
  toVnpDate,
  verifyNotification,
  vnpEncode,
  type VnpayConfig,
} from "./vnpay.js";

const cfg: VnpayConfig = {
  tmnCode: "XSHOP001",
  hashSecret: "SECRETKEYFORTESTONLY",
  paymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  apiUrl: "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction",
  returnUrl: "https://shop.example/thanh-toan/ket-qua",
};
const created = new Date("2026-10-24T09:00:00Z");
const input = {
  txnRef: "PA_01JABCDEF",
  amount: 1_200_000,
  orderInfo: "Thanh toán đơn XS-1001",
  ipAddr: "203.0.113.5",
  createdAt: created,
  expiresAt: new Date(created.getTime() + 15 * 60_000),
};

describe("ngày giờ GMT+7", () => {
  it("UTC 09:00 → 16:00 giờ VN; qua nửa đêm đổi ngày", () => {
    expect(toVnpDate(created)).toBe("20261024160000");
    expect(toVnpDate(new Date("2026-12-31T17:30:05Z"))).toBe("20270101003005");
  });
  it("round-trip và từ chối ngày sai", () => {
    expect(fromVnpDate("20261024160000")?.toISOString()).toBe("2026-10-24T09:00:00.000Z");
    expect(fromVnpDate("20261332160000")).toBeNull();
    expect(fromVnpDate("2026")).toBeNull();
  });
});

describe("ký", () => {
  it("encode kiểu PHP: khoảng trắng → +, ký tự đặc biệt mã hóa", () => {
    expect(vnpEncode("a b/c:d")).toBe("a+b%2Fc%3Ad");
    expect(vnpEncode("(x)!*'")).toBe("%28x%29%21%2A%27");
  });
  it("chuỗi ký sắp theo key, bỏ SecureHash, bỏ tham số không phải vnp_", () => {
    expect(signData({ vnp_B: "2", vnp_A: "1 1", vnp_SecureHash: "x", other: "y", vnp_C: "" })).toBe(
      "vnp_A=1+1&vnp_B=2&vnp_C=",
    );
  });
  it("orderInfo bỏ dấu, ký tự lạ", () => {
    expect(sanitizeOrderInfo("Thanh toán đơn #XS-1001 <script>")).toBe("Thanh toan don XS-1001 script");
  });
});

describe("buildPaymentUrl", () => {
  it("số tiền ×100, có hạn phiên, chữ ký hợp lệ", () => {
    const url = new URL(buildPaymentUrl(cfg, input));
    expect(url.origin + url.pathname).toBe(cfg.paymentUrl);
    const q = url.searchParams;
    expect(q.get("vnp_Amount")).toBe("120000000");
    expect(q.get("vnp_ExpireDate")).toBe("20261024161500");
    expect(q.get("vnp_CurrCode")).toBe("VND");
    expect(q.get("vnp_Version")).toBe("2.1.0");
    const params = Object.fromEntries(q.entries());
    expect(q.get("vnp_SecureHash")).toBe(hmacSha512(cfg.hashSecret, signData(params)));
  });
  it("từ chối 0 đồng, txnRef lạ, hạn trước lúc tạo", () => {
    expect(() => buildPaymentUrl(cfg, { ...input, amount: 0 })).toThrow();
    expect(() => buildPaymentUrl(cfg, { ...input, txnRef: "a&b" })).toThrow();
    expect(() => buildPaymentUrl(cfg, { ...input, expiresAt: created })).toThrow();
    expect(() => buildPaymentUrl(cfg, { ...input, bankCode: "NCB" })).not.toThrow();
  });
});

describe("buildPaymentUrl — vnp_ReturnUrl kèm attempt", () => {
  it("không có returnParams → giữ nguyên chuỗi cấu hình", () => {
    const q = new URL(buildPaymentUrl(cfg, input)).searchParams;
    expect(q.get("vnp_ReturnUrl")).toBe(cfg.returnUrl);
    expect(buildReturnUrl(cfg.returnUrl, {})).toBe(cfg.returnUrl);
  });
  it("attempt nằm trong vnp_ReturnUrl và được ký (chữ ký vẫn hợp lệ, đổi attempt → đổi chữ ký)", () => {
    const a = new URL(buildPaymentUrl(cfg, { ...input, returnParams: { attempt: "chk_01JABC" } }))
      .searchParams;
    const ret = new URL(a.get("vnp_ReturnUrl") as string);
    expect(ret.origin + ret.pathname).toBe(cfg.returnUrl);
    expect(ret.searchParams.get("attempt")).toBe("chk_01JABC");
    const params = Object.fromEntries(a.entries());
    expect(a.get("vnp_SecureHash")).toBe(hmacSha512(cfg.hashSecret, signData(params)));
    const b = new URL(buildPaymentUrl(cfg, { ...input, returnParams: { attempt: "chk_KHAC" } })).searchParams;
    expect(b.get("vnp_SecureHash")).not.toBe(a.get("vnp_SecureHash"));
  });
  it("giữ query sẵn có của returnUrl; ghi đè cùng khóa", () => {
    expect(buildReturnUrl("https://shop.example/kq?src=vnp&attempt=cu", { attempt: "moi" })).toBe(
      "https://shop.example/kq?src=vnp&attempt=moi",
    );
  });
  it("từ chối khóa/giá trị lạ (không cho dữ liệu tùy ý, ký tự đặc biệt hay tham số vnp_ đi qua cổng)", () => {
    const bads: Array<Record<string, string>> = [
      { attempt: "" },
      { attempt: "a&b=c" },
      { attempt: "x".repeat(129) },
      { attempt: "0912 345 678" },
      { vnp_ResponseCode: "00" },
      { "": "x" },
      { Attempt: "x" },
    ];
    for (const bad of bads) {
      expect(() => buildPaymentUrl(cfg, { ...input, returnParams: bad })).toThrow(/returnParams/);
    }
  });
});

describe("verifyNotification — S-101, S-103 (AT07)", () => {
  const gw = new MockVnpayGateway(cfg);
  const url = buildPaymentUrl(cfg, input);
  it("IPN thành công hợp lệ", () => {
    const r = verifyNotification(cfg, gw.pay(url, "success"));
    expect(r).toMatchObject({ ok: true, value: { txnRef: input.txnRef, amount: 1_200_000, success: true } });
    if (r.ok) expect(r.value.transactionNo).toMatch(/^\d+$/);
  });
  it("khách hủy → hợp lệ nhưng không success", () => {
    const r = verifyNotification(cfg, gw.pay(url, "cancelled"));
    expect(r).toMatchObject({ ok: true, value: { success: false, responseCode: "24" } });
  });
  it("chữ ký sai, thiếu chữ ký, sửa tham số sau khi ký", () => {
    expect(verifyNotification(cfg, gw.pay(url, "success", { badSignature: true }))).toEqual({
      ok: false,
      code: "INVALID_SIGNATURE",
    });
    const q = gw.pay(url, "success");
    q.delete("vnp_SecureHash");
    expect(verifyNotification(cfg, q)).toMatchObject({ ok: false, code: "INVALID_SIGNATURE" });
    const t = gw.pay(url, "success");
    t.set("vnp_Amount", "1");
    expect(verifyNotification(cfg, t)).toMatchObject({ ok: false, code: "INVALID_SIGNATURE" });
  });
  it("số tiền bị đổi (ký đúng) → caller so sánh và trả 04; tham số không phải vnp_ bị bỏ qua", () => {
    const q = gw.pay(url, "success", { tamperAmount: 1 });
    q.set("utm", "x");
    const r = verifyNotification(cfg, q);
    expect(r).toMatchObject({ ok: true, value: { amount: 1 } });
  });
  it("merchant khác, đầu vào dị dạng", () => {
    const other = new MockVnpayGateway({ ...cfg, tmnCode: "KHAC" });
    expect(verifyNotification(cfg, other.pay(url, "success"))).toEqual({
      ok: false,
      code: "MERCHANT_MISMATCH",
    });
    const huge = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`vnp_${i}`, "x"]));
    expect(verifyNotification(cfg, huge)).toEqual({ ok: false, code: "MALFORMED" });
    expect(verifyNotification(cfg, { vnp_X: "a".repeat(2000) })).toEqual({ ok: false, code: "MALFORMED" });
    const odd: Record<string, string> = { vnp_Amount: "123", vnp_TxnRef: "A", vnp_TmnCode: cfg.tmnCode };
    odd.vnp_SecureHash = hmacSha512(cfg.hashSecret, signData(odd));
    expect(verifyNotification(cfg, odd)).toEqual({ ok: false, code: "MALFORMED" });
    const noRef: Record<string, string> = { vnp_Amount: "100", vnp_TmnCode: cfg.tmnCode };
    noRef.vnp_SecureHash = hmacSha512(cfg.hashSecret, signData(noRef));
    expect(verifyNotification(cfg, noRef)).toEqual({ ok: false, code: "MALFORMED" });
  });
  it("mã phản hồi IPN cố định", () => {
    expect(IPN_RESPONSES.invalidSignature.RspCode).toBe("97");
    expect(IPN_RESPONSES.alreadyConfirmed.RspCode).toBe("02");
    expect(IPN_RESPONSES.invalidAmount.RspCode).toBe("04");
  });
});

describe("querydr / refund", () => {
  const common = { requestId: "REQ1", ipAddr: "127.0.0.1", createdAt: created };
  it("body querydr có chữ ký nối |", () => {
    const b = buildQueryDr(cfg, { ...common, txnRef: "T1", transactionDate: created, orderInfo: "Tra cuu" });
    expect(b.vnp_Command).toBe("querydr");
    expect(b.vnp_SecureHash).toBe(
      hmacSha512(
        cfg.hashSecret,
        "REQ1|2.1.0|querydr|XSHOP001|T1|20261024160000|20261024160000|127.0.0.1|Tra cuu",
      ),
    );
  });
  it("body refund một phần / toàn phần", () => {
    const base = {
      ...common,
      txnRef: "T1",
      amount: 270_000,
      transactionNo: "14000001",
      transactionDate: created,
      createdBy: "ke-toan",
      orderInfo: "Hoan",
    };
    expect(buildRefund(cfg, { ...base, full: false })).toMatchObject({
      vnp_TransactionType: "03",
      vnp_Amount: "27000000",
    });
    expect(buildRefund(cfg, { ...base, full: true }).vnp_TransactionType).toBe("02");
    expect(() => buildRefund(cfg, { ...base, full: true, amount: -1 })).toThrow();
  });
  it("diễn giải querydr: paid / chưa / lỗi / chữ ký sai / số tiền lệch", () => {
    const gw = new MockVnpayGateway(cfg);
    const url = buildPaymentUrl(cfg, input);
    expect(interpretQueryResponse(cfg, gw.query(input.txnRef, input.amount), input).outcome).toBe("not_paid");
    gw.pay(url, "success");
    expect(interpretQueryResponse(cfg, gw.query(input.txnRef, input.amount), input).outcome).toBe("paid");
    expect(
      interpretQueryResponse(cfg, gw.query(input.txnRef, input.amount), { ...input, amount: 1 }).reason,
    ).toBe("amount_mismatch");
    const bad = { ...gw.query(input.txnRef, input.amount), vnp_SecureHash: "0".repeat(128) };
    expect(interpretQueryResponse(cfg, bad, input)).toMatchObject({
      outcome: "unknown",
      reason: "invalid_signature",
    });
    const gw2 = new MockVnpayGateway(cfg);
    gw2.pay(url, "failed");
    expect(interpretQueryResponse(cfg, gw2.query(input.txnRef, input.amount), input).outcome).toBe("failed");
    expect(interpretQueryResponse(cfg, gw2.query("KHAC", 1), input).reason).toBe("mismatch");
  });
  it("mã phản hồi API khác 00 → unknown", () => {
    const gw = new MockVnpayGateway(cfg);
    const res = gw.query("T", 1);
    const tampered: Record<string, string> = { ...res, vnp_ResponseCode: "91" };
    const data = [
      "vnp_ResponseId",
      "vnp_Command",
      "vnp_ResponseCode",
      "vnp_Message",
      "vnp_TmnCode",
      "vnp_TxnRef",
      "vnp_Amount",
      "vnp_BankCode",
      "vnp_PayDate",
      "vnp_TransactionNo",
      "vnp_TransactionType",
      "vnp_TransactionStatus",
      "vnp_OrderInfo",
      "vnp_PromotionCode",
      "vnp_PromotionAmount",
    ]
      .map((k) => (tampered as Record<string, string>)[k] ?? "")
      .join("|");
    tampered.vnp_SecureHash = hmacSha512(cfg.hashSecret, data);
    expect(interpretQueryResponse(cfg, tampered, { txnRef: "T", amount: 1 })).toMatchObject({
      outcome: "unknown",
      reason: "response_91",
    });
  });
});
