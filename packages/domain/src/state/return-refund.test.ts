import { describe, expect, it } from "vitest";
import { REFUND_STATES } from "./machine.js";
import { isReturnRefund, RETURN_REFUND_STEPS, returnRefundNextSteps } from "./return-refund.js";

describe("isReturnRefund (T-173)", () => {
  it("reason=return hoặc có return_id → true; chuỗi rỗng/null/undefined không tính là có return_id", () => {
    expect(isReturnRefund({ reason: "return", return_id: "xret_1" })).toBe(true);
    expect(isReturnRefund({ reason: "return", return_id: null })).toBe(true);
    expect(isReturnRefund({ reason: "other", return_id: "xret_1" })).toBe(true);
    for (const return_id of [null, undefined, ""]) {
      for (const reason of ["cancellation", "other", "late_payment", ""]) {
        expect({ reason, return_id, v: isReturnRefund({ reason, return_id }) }).toEqual({
          reason,
          return_id,
          v: false,
        });
      }
    }
  });
});

describe("returnRefundNextSteps (T-173)", () => {
  const steps = (method: string, state: string, attempts = 0, max = 3) =>
    returnRefundNextSteps({ method, state, attempts }, max);

  it("provider: requested → duyệt, thực hiện, hủy, tạo lại; approved → bỏ duyệt", () => {
    expect(steps("provider", "requested")).toEqual(["approve", "execute", "cancel", "recreate"]);
    expect(steps("provider", "approved")).toEqual(["execute", "cancel", "recreate"]);
  });

  it("manual (COD, cổng tắt) không tự vào failed → chỉ duyệt/thực hiện, không hủy/tạo lại", () => {
    expect(steps("manual", "requested")).toEqual(["approve", "execute"]);
    expect(steps("manual", "approved")).toEqual(["execute"]);
  });

  it("failed: còn lượt → thực hiện lại + hủy + tạo lại; hết lượt/attempts hỏng → chỉ hủy + tạo lại (mọi method)", () => {
    for (const method of ["provider", "manual"]) {
      expect(steps(method, "failed", 0)).toEqual(["execute", "cancel", "recreate"]);
      expect(steps(method, "failed", 2)).toEqual(["execute", "cancel", "recreate"]);
      expect(steps(method, "failed", 3)).toEqual(["cancel", "recreate"]);
      expect(steps(method, "failed", Number.NaN)).toEqual(["cancel", "recreate"]);
      expect(steps(method, "failed", 0, 1)).toEqual(["execute", "cancel", "recreate"]);
      expect(steps(method, "failed", 1, 1)).toEqual(["cancel", "recreate"]);
    }
  });

  it("processing/unknown → chỉ thực hiện lại (cổng có thể đã hoàn, chưa nhả được)", () => {
    for (const method of ["provider", "manual"]) {
      expect(steps(method, "processing", 1)).toEqual(["execute"]);
      expect(steps(method, "unknown", 1)).toEqual(["execute"]);
    }
  });

  it("kết thúc (succeeded/rejected/cancelled) và trạng thái lạ/rỗng → []", () => {
    for (const state of ["succeeded", "rejected", "cancelled", "", "REQUESTED", "deleted"]) {
      expect({ state, s: steps("provider", state) }).toEqual({ state, s: [] });
      expect({ state, s: steps("manual", state) }).toEqual({ state, s: [] });
    }
  });

  it("mọi trạng thái hoàn: chỉ trả bước hợp lệ, không trùng, đúng thứ tự chuẩn", () => {
    for (const state of REFUND_STATES) {
      for (const method of ["provider", "manual", "khác"]) {
        const s = steps(method, state, 1);
        expect(new Set(s).size).toBe(s.length);
        expect(s.every((x) => RETURN_REFUND_STEPS.includes(x))).toBe(true);
        expect(
          [...s].sort((a, b) => RETURN_REFUND_STEPS.indexOf(a) - RETURN_REFUND_STEPS.indexOf(b)),
        ).toEqual(s);
      }
    }
  });

  it("maxAttempts sai → RangeError (giống canRetryRefund) chỉ khi cần xét lượt", () => {
    expect(() => steps("provider", "failed", 0, 0)).toThrow(RangeError);
    expect(steps("provider", "requested", 0, 0)).toEqual(["approve", "execute", "cancel", "recreate"]);
  });
});
