import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decideIdempotency,
  isValidIdempotencyKey,
  payloadHash,
  signLookupToken,
  verifyLookupToken,
} from "./idempotency.js";
import {
  PERMISSIONS,
  ROLES,
  can,
  canApproveRefund,
  maskEmail,
  maskPhone,
  permissionsOf,
  refundNeedsSecondApproval,
} from "./rbac.js";

describe("RBAC — AT21", () => {
  it("kho không hoàn tiền, không xuất khách hàng", () => {
    expect(can(["warehouse"], "refund.execute")).toBe(false);
    expect(can(["warehouse"], "refund.request")).toBe(false);
    expect(can(["warehouse"], "customer.export")).toBe(false);
    expect(can(["warehouse"], "return.inspect")).toBe(true);
    expect(can(["warehouse"], "inventory.adjust")).toBe(true);
  });
  it("owner có mọi quyền; vai trò lạ/rỗng không có gì", () => {
    expect(permissionsOf(["owner"])).toEqual([...PERMISSIONS]);
    expect(permissionsOf([])).toEqual([]);
    expect(permissionsOf(["admin"])).toEqual([]);
    expect(can(["owner"], "khong.ton.tai" as never)).toBe(false);
  });
  it("đúng phạm vi từng vai trò (đặc tả §5.4)", () => {
    expect(can(["catalog_manager"], "refund.execute")).toBe(false);
    expect(can(["catalog_manager"], "price.write")).toBe(true);
    expect(can(["order_staff"], "payment.read")).toBe(false);
    expect(can(["support"], "order.read")).toBe(false);
    expect(can(["support"], "order.read_masked")).toBe(true);
    expect(can(["support"], "refund.execute")).toBe(false);
    expect(can(["accountant"], "catalog.write")).toBe(false);
    expect(can(["accountant"], "refund.execute")).toBe(true);
    expect(can(["support", "warehouse"], "return.inspect")).toBe(true);
  });
  it("chỉ owner quản lý người dùng/cấu hình", () => {
    for (const r of ROLES.filter((x) => x !== "owner")) {
      expect(can([r], "user.manage")).toBe(false);
      expect(can([r], "settings.manage")).toBe(false);
    }
  });
  it("duyệt hoàn tiền hai người — S-403", () => {
    expect(refundNeedsSecondApproval(5_000_001, 5_000_000)).toBe(true);
    expect(refundNeedsSecondApproval(5_000_000, 5_000_000)).toBe(false);
    expect(canApproveRefund({ id: "u1", roles: ["accountant"] }, "u1")).toEqual({
      ok: false,
      reason: "SELF_APPROVAL",
    });
    expect(canApproveRefund({ id: "u2", roles: ["warehouse"] }, "u1")).toEqual({
      ok: false,
      reason: "FORBIDDEN",
    });
    expect(canApproveRefund({ id: "u2", roles: ["accountant"] }, "u1")).toEqual({ ok: true });
  });
  it("che PII", () => {
    expect(maskPhone("0912345678")).toBe("091****678");
    expect(maskPhone("123")).toBe("***");
    expect(maskEmail("lan@example.com")).toBe("l***@example.com");
    expect(maskEmail("bad")).toBe("***");
  });
});

describe("idempotency — DATA01", () => {
  it("hash không phụ thuộc thứ tự khóa; khác nội dung → khác hash", () => {
    expect(payloadHash({ a: 1, b: { d: [1, 2], c: "x" } })).toBe(
      payloadHash({ b: { c: "x", d: [1, 2] }, a: 1 }),
    );
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
    expect(canonicalJson({ a: undefined, b: null, c: [undefined] })).toBe('{"b":null,"c":[null]}');
    expect(canonicalJson("x")).toBe('"x"');
  });
  it("quyết định new/replay/conflict", () => {
    expect(decideIdempotency(null, "h")).toBe("new");
    expect(decideIdempotency({ payloadHash: "h" }, "h")).toBe("replay");
    expect(decideIdempotency({ payloadHash: "h" }, "k")).toBe("conflict");
  });
  it("định dạng key", () => {
    expect(isValidIdempotencyKey("0123456789abcdef")).toBe(true);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
    expect(isValidIdempotencyKey("có dấu cách 1234567")).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
  });
});

describe("token tra cứu đơn — POST01", () => {
  const secret = "test-secret-32-bytes-xxxxxxxxxxxx";
  const now = new Date("2026-10-24T10:00:00Z");
  const tok = signLookupToken(secret, "order_01ABC", new Date(now.getTime() + 15 * 60_000));
  it("hợp lệ trong hạn", () => {
    expect(verifyLookupToken(secret, tok, now)).toEqual({ ok: true, orderId: "order_01ABC" });
  });
  it("hết hạn đúng biên, sai khóa, sửa nội dung, dị dạng", () => {
    expect(verifyLookupToken(secret, tok, new Date(now.getTime() + 15 * 60_000))).toEqual({
      ok: false,
      reason: "EXPIRED",
    });
    expect(verifyLookupToken("khac", tok, now)).toMatchObject({ reason: "BAD_SIGNATURE" });
    const [, mac] = tok.split(".");
    const forged = `${Buffer.from("order_OTHER.9999999999").toString("base64url")}.${mac}`;
    expect(verifyLookupToken(secret, forged, now)).toMatchObject({ reason: "BAD_SIGNATURE" });
    expect(verifyLookupToken(secret, "abc", now)).toMatchObject({ reason: "MALFORMED" });
    expect(verifyLookupToken(secret, `${Buffer.from("x y.1").toString("base64url")}.m`, now)).toMatchObject({
      reason: "MALFORMED",
    });
  });
});
