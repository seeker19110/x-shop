import type { RefundMethod } from "../../../modules/returns/constants";
import type { RefundRow } from "../../../modules/returns/service";
import { ReturnsError } from "../errors";
import { autoManualNote, routeRefund, type CaptureInfo, type RefundSources } from "../refund-route";

/**
 * T-169 — định tuyến phương thức hoàn: `auto` chọn `manual` (có lý do) khi cổng tắt / xung đột mã / khoản thu không gắn
 * attempt; `provider` tường minh không thực hiện được → lỗi ngay khi tạo (không tạo yêu cầu chắc chắn kẹt).
 */
const cap = (id: string, amount: number, linked = true, provider = "vnpay"): CaptureInfo => ({
  provider,
  provider_txn_id: id,
  amount,
  linked,
});
const src = (captures: CaptureInfo[], txnConflict = false): RefundSources => ({
  captures,
  txnConflict,
  gatewayEnabled: true,
});
/** `routeRefund` với cờ cổng hoàn bật/tắt tường minh (ghi đè `gatewayEnabled` của nguồn). */
const route = (
  s: RefundSources,
  refunds: RefundRow[],
  amount: number,
  method: RefundMethod | "auto",
  gatewayEnabled: boolean,
) => routeRefund({ ...s, gatewayEnabled }, refunds, amount, method);
const providerRefund = (captureRef: string, amount: number, state: RefundRow["state"] = "approved") =>
  ({
    id: `r-${captureRef}-${amount}`,
    method: "provider",
    capture_ref: captureRef,
    amount,
    state,
  }) as RefundRow;

function codeOf(fn: () => unknown): { code: string; detail: Record<string, unknown> } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ReturnsError) return { code: e.code, detail: e.detail };
    throw e;
  }
}

describe("routeRefund — auto", () => {
  it("cổng bật + khoản thu gắn attempt đủ chỗ → provider trên đúng khoản thu đó", () => {
    const r = route(src([cap("T1", 500_000)]), [], 500_000, "auto", true);
    expect(r).toEqual({ method: "provider", capture: cap("T1", 500_000) });
  });
  it("cổng tắt → manual (provider_disabled)", () => {
    expect(route(src([cap("T1", 500_000)]), [], 1, "auto", false)).toEqual({
      method: "manual",
      reason: "provider_disabled",
    });
  });
  it("đơn đang có attempt_txn_conflict → manual dù khoản thu đầu còn chỗ (cách hiểu chặt)", () => {
    const r = route(src([cap("T1", 500_000), cap("T2", 500_000, false)], true), [], 1, "auto", true);
    expect(r).toEqual({ method: "manual", reason: "attempt_txn_conflict" });
  });
  it("khoản thu gắn attempt đã bị refund cổng chiếm hết, còn khoản không gắn → manual (capture_unlinked)", () => {
    const sources = src([cap("T1", 500_000), cap("T2", 500_000, false)]);
    const r = route(sources, [providerRefund("T1", 500_000)], 500_000, "auto", true);
    expect(r).toEqual({ method: "manual", reason: "capture_unlinked" });
  });
  it("refund cổng đã hủy/từ chối không chiếm chỗ (biên: trạng thái nhả)", () => {
    const refunds = [providerRefund("T1", 500_000, "cancelled"), providerRefund("T1", 500_000, "rejected")];
    expect(route(src([cap("T1", 500_000)]), refunds, 500_000, "auto", true).method).toBe("provider");
  });
  it("vượt phần còn lại của mọi khoản thu gắn attempt → manual (exceeds_single_capture)", () => {
    const r = route(src([cap("T1", 300_000), cap("T2", 300_000)]), [], 500_000, "auto", true);
    expect(r).toEqual({ method: "manual", reason: "exceeds_single_capture" });
  });
  it("COD / không có khoản thu VNPAY → manual không ghi lý do (kể cả cổng tắt)", () => {
    const cod = src([cap("cod:X", 500_000, false, "cod")]);
    expect(route(cod, [], 1, "auto", false)).toEqual({ method: "manual", reason: null });
    expect(route(src([]), [], 1, "auto", true)).toEqual({ method: "manual", reason: null });
  });
});

describe("routeRefund — manual / provider", () => {
  it("manual luôn là manual, không lý do", () => {
    expect(route(src([cap("T1", 1)]), [], 1, "manual", false)).toEqual({
      method: "manual",
      reason: null,
    });
  });
  it("provider khi cổng tắt → 409 REFUND_PROVIDER_DISABLED", () => {
    expect(codeOf(() => route(src([cap("T1", 500_000)]), [], 1, "provider", false))?.code).toBe(
      "REFUND_PROVIDER_DISABLED",
    );
  });
  it("provider trên đơn không có VNPAY → REFUND_METHOD_UNAVAILABLE (trước cả kiểm cổng)", () => {
    expect(codeOf(() => route(src([]), [], 1, "provider", false))?.code).toBe("REFUND_METHOD_UNAVAILABLE");
  });
  it("provider chỉ còn khoản thu không gắn attempt → REFUND_METHOD_UNAVAILABLE kèm phần hoàn qua cổng được", () => {
    const sources = src([cap("T1", 500_000), cap("T2", 500_000, false)], true);
    const err = codeOf(() => route(sources, [providerRefund("T1", 400_000)], 500_000, "provider", true));
    expect(err).toEqual({ code: "REFUND_METHOD_UNAVAILABLE", detail: { provider_refundable: 100_000 } });
  });
  it("provider trên khoản thu gắn attempt vẫn được khi đơn có xung đột (lựa chọn tường minh của kế toán)", () => {
    const sources = src([cap("T1", 500_000), cap("T2", 500_000, false)], true);
    expect(route(sources, [], 500_000, "provider", true)).toMatchObject({
      method: "provider",
      capture: { provider_txn_id: "T1" },
    });
  });
  it("tổng chỗ trên các khoản gắn attempt đủ nhưng không khoản nào đủ một mình → REFUND_SPLIT_REQUIRED", () => {
    const sources = src([cap("T1", 300_000), cap("T2", 300_000)]);
    expect(codeOf(() => route(sources, [], 500_000, "provider", true))?.code).toBe("REFUND_SPLIT_REQUIRED");
  });
});

describe("autoManualNote", () => {
  it("giữ ghi chú người tạo, nối lý do có mã máy đọc", () => {
    expect(autoManualNote("Hoàn bù", "provider_disabled")).toBe(
      "Hoàn bù [Hoàn tay do hệ thống chọn: cổng hoàn tiền đang tắt ở môi trường này (provider_disabled)]",
    );
  });
  it("ghi chú rỗng/null/khoảng trắng → chỉ lý do", () => {
    for (const note of [null, "", "   "]) {
      expect(autoManualNote(note, "capture_unlinked")).toMatch(
        /^\[Hoàn tay do hệ thống chọn: .*\(capture_unlinked\)\]$/,
      );
    }
  });
});
