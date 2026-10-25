import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkRefundAllowed,
  codAmount,
  decideOnCapture,
  ledgerTotals,
  overpaidAmount,
  reconcile,
  refundOccupiesCapture,
  type LedgerEntry,
} from "./ledger.js";

const cap = (amount: number, id = `t${amount}`): LedgerEntry => ({
  kind: "capture",
  amount,
  providerTxnId: id,
});
const ref = (
  amount: number,
  state: Extract<LedgerEntry, { kind: "refund" }>["state"],
  id = "r1",
): LedgerEntry => ({
  kind: "refund",
  amount,
  refundId: id,
  state,
});

describe("ledgerTotals", () => {
  it("rỗng", () => {
    expect(ledgerTotals([])).toEqual({ captured: 0, refundSucceeded: 0, refundHeld: 0, net: 0 });
  });
  it("tách thành công / đang giữ / bị từ chối", () => {
    const t = ledgerTotals([
      cap(1_000_000),
      ref(100_000, "succeeded", "a"),
      ref(50_000, "unknown", "b"),
      ref(10_000, "rejected", "c"),
      ref(20_000, "failed", "d"),
    ]);
    expect(t).toEqual({ captured: 1_000_000, refundSucceeded: 100_000, refundHeld: 70_000, net: 900_000 });
  });
});

describe("checkRefundAllowed — AT16", () => {
  it("không vượt đã thu, tính cả phần đang giữ", () => {
    const e = [cap(500_000), ref(300_000, "processing")];
    expect(checkRefundAllowed(e, 200_000)).toEqual({ ok: true, value: 0 });
    expect(checkRefundAllowed(e, 200_001)).toMatchObject({ ok: false, code: "REFUND_EXCEEDS_CAPTURED" });
    expect(checkRefundAllowed([], 1)).toMatchObject({ ok: false, code: "REFUND_EXCEEDS_CAPTURED" });
    expect(checkRefundAllowed(e, 0)).toMatchObject({ ok: false, code: "VALIDATION" });
    expect(checkRefundAllowed(e, 1.5)).toMatchObject({ ok: false, code: "VALIDATION" });
  });
  it("thuộc tính: chuỗi yêu cầu được chấp nhận không bao giờ vượt captured", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(fc.integer({ min: 1, max: 5_000_000 }), { maxLength: 20 }),
        (captured, requests) => {
          const entries: LedgerEntry[] = [cap(captured)];
          for (const [i, amt] of requests.entries()) {
            if (checkRefundAllowed(entries, amt).ok) entries.push(ref(amt, "processing", `r${i}`));
          }
          const t = ledgerTotals(entries);
          return t.refundSucceeded + t.refundHeld <= t.captured;
        },
      ),
    );
  });
});

describe("hủy yêu cầu hoàn failed (T-044)", () => {
  it("failed giữ tiền; cancelled nhả → yêu cầu mới vừa đủ, không vượt", () => {
    const held = [cap(730_000), ref(730_000, "failed", "a")];
    expect(checkRefundAllowed(held, 1)).toMatchObject({ ok: false, code: "REFUND_EXCEEDS_CAPTURED" });
    const released = [cap(730_000), ref(730_000, "cancelled", "a")];
    expect(ledgerTotals(released)).toEqual({
      captured: 730_000,
      refundSucceeded: 0,
      refundHeld: 0,
      net: 730_000,
    });
    expect(checkRefundAllowed(released, 730_000)).toEqual({ ok: true, value: 0 });
    expect(checkRefundAllowed([...released, ref(730_000, "requested", "b")], 1)).toMatchObject({
      ok: false,
      code: "REFUND_EXCEEDS_CAPTURED",
    });
  });
  it("refundOccupiesCapture: chỉ rejected/cancelled nhả chỗ của giao dịch gốc", () => {
    expect(refundOccupiesCapture("cancelled")).toBe(false);
    expect(refundOccupiesCapture("rejected")).toBe(false);
    for (const s of ["requested", "approved", "processing", "unknown", "failed", "succeeded"] as const) {
      expect({ s, v: refundOccupiesCapture(s) }).toEqual({ s, v: true });
    }
  });
});

describe("COD / thu dư — AT13, AT36", () => {
  it("đơn online đã trả đủ → COD 0; chưa trả → COD = tổng", () => {
    expect(codAmount(1_200_000, [cap(1_200_000)])).toBe(0);
    expect(codAmount(1_200_000, [])).toBe(1_200_000);
    expect(codAmount(1_200_000, [cap(1_200_000), ref(200_000, "succeeded")])).toBe(200_000);
  });
  it("thu dư", () => {
    expect(overpaidAmount(1_000_000, [cap(1_000_000, "a"), cap(1_000_000, "b")])).toBe(1_000_000);
    expect(overpaidAmount(1_000_000, [cap(1_000_000)])).toBe(0);
  });
});

describe("decideOnCapture — AT09, AT36", () => {
  it("đơn chờ, đủ tiền → xác nhận một lần", () => {
    expect(decideOnCapture("awaiting_payment", 1_000_000, [cap(1_000_000)], 1_000_000)).toEqual({
      action: "confirm_order",
      overpaid: 0,
    });
  });
  it("thu thiếu → chỉ ghi", () => {
    expect(decideOnCapture("awaiting_payment", 1_000_000, [cap(999_999)], 999_999)).toEqual({
      action: "record_only",
      reason: "underpaid",
    });
  });
  it("AT09: tiền đến sau hủy → ngoại lệ late_payment", () => {
    expect(decideOnCapture("cancelled", 1_000_000, [cap(1_000_000)], 1_000_000)).toEqual({
      action: "exception",
      reason: "late_payment",
      amount: 1_000_000,
    });
  });
  it("AT36: khoản thứ hai khi đã xác nhận → overpayment, không xác nhận lại", () => {
    expect(
      decideOnCapture("confirmed", 1_000_000, [cap(1_000_000, "a"), cap(1_000_000, "b")], 1_000_000),
    ).toEqual({ action: "exception", reason: "overpayment", amount: 1_000_000 });
  });
  it("hai khoản về trước khi xác nhận → xác nhận một lần kèm số dư", () => {
    expect(decideOnCapture("placed", 1_000_000, [cap(600_000, "a"), cap(600_000, "b")], 600_000)).toEqual({
      action: "confirm_order",
      overpaid: 200_000,
    });
  });
});

describe("reconcile — AT14", () => {
  it("delivered nhưng chưa có chứng từ → unsettled, còn phải thu", () => {
    expect(reconcile(1_200_000, 20_000, null)).toEqual({
      expectedNet: 1_180_000,
      receivedNet: 0,
      difference: -1_180_000,
      state: "unsettled",
    });
  });
  it("đủ / thiếu / thừa", () => {
    expect(reconcile(1_200_000, 20_000, 1_180_000).state).toBe("settled");
    expect(reconcile(1_200_000, 20_000, 1_000_000)).toMatchObject({
      state: "partially_settled",
      difference: -180_000,
    });
    expect(reconcile(1_200_000, 20_000, 1_200_000)).toMatchObject({ state: "disputed", difference: 20_000 });
  });
});
