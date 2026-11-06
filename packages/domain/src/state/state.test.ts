import { describe, expect, it } from "vitest";
import {
  applyProviderState,
  canRetryRefund,
  defineMachine,
  orderMachine,
  paymentMachine,
  refundMachine,
  returnMachine,
  settlementMachine,
  shipmentMachine,
  type Machine,
} from "./machine.js";

const machines: Machine<string>[] = [
  orderMachine,
  paymentMachine,
  shipmentMachine,
  returnMachine,
  refundMachine,
  settlementMachine,
] as Machine<string>[];

describe("máy trạng thái — cấu trúc", () => {
  it.each(machines.map((m) => [m.name, m] as const))(
    "%s: mọi trạng thái tới được trạng thái kết thúc",
    (_n, m) => {
      for (const s of m.states) {
        const seen = new Set<string>([s]);
        const stack = [s];
        let reachesTerminal = m.isTerminal(s);
        while (stack.length) {
          const cur = stack.pop() as string;
          for (const t of m.states) {
            if (m.canTransition(cur, t) && !seen.has(t)) {
              if (m.isTerminal(t)) reachesTerminal = true;
              seen.add(t);
              stack.push(t);
            }
          }
        }
        expect(reachesTerminal, `${m.name}.${s}`).toBe(true);
      }
    },
  );
  it("khai báo trỏ tới trạng thái lạ → lỗi lúc định nghĩa", () => {
    expect(() => defineMachine<"a" | "b">("x", { a: ["c" as "b"], b: [] })).toThrow(/không khai báo/);
  });
  it("transition trả lỗi có mã", () => {
    expect(orderMachine.transition("preparing", "placed")).toEqual({ ok: true, value: "placed" });
    expect(orderMachine.transition("cancelled", "confirmed")).toMatchObject({
      ok: false,
      code: "INVALID_TRANSITION",
    });
  });
});

describe("đơn hàng", () => {
  it("preparing chưa được xác nhận trực tiếp (chưa gọi cổng/xuất kho)", () => {
    expect(orderMachine.canTransition("preparing", "confirmed")).toBe(false);
  });
  it("đơn kết thúc không đổi nữa (POST02)", () => {
    expect(orderMachine.isTerminal("completed")).toBe(true);
    expect(orderMachine.canTransition("completed", "cancelled")).toBe(false);
    expect(orderMachine.canTransition("cancelled", "confirmed")).toBe(false);
  });
});

describe("thanh toán — D-003 không lùi", () => {
  it("captured là kết thúc; callback pending đến muộn bị bỏ qua", () => {
    expect(applyProviderState(paymentMachine, "captured", "pending")).toEqual({
      state: "captured",
      changed: false,
      ignored: "out_of_order",
    });
  });
  it("callback lặp → duplicate", () => {
    expect(applyProviderState(paymentMachine, "pending", "pending").ignored).toBe("duplicate");
  });
  it("unknown thoát bằng kết quả đối chiếu", () => {
    expect(applyProviderState(paymentMachine, "unknown", "captured")).toEqual({
      state: "captured",
      changed: true,
      ignored: null,
    });
    expect(paymentMachine.canTransition("failed", "captured")).toBe(false);
  });
});

describe("giao vận / đổi trả / hoàn / đối soát", () => {
  it("delivered không lùi về shipped (callback sai thứ tự)", () => {
    expect(applyProviderState(shipmentMachine, "delivered", "shipped").ignored).toBe("out_of_order");
  });
  it("hàng trả phải qua kiểm định trước khi đóng", () => {
    expect(returnMachine.canTransition("received", "closed")).toBe(false);
    expect(returnMachine.canTransition("inspected", "closed")).toBe(true);
  });
  it("refund retry dùng cùng bản ghi; unknown thoát bằng đối chiếu", () => {
    expect(refundMachine.canTransition("failed", "processing")).toBe(true);
    expect(refundMachine.canTransition("unknown", "processing")).toBe(false);
    expect(refundMachine.isTerminal("succeeded")).toBe(true);
  });
  it("T-169: approved → failed (từ chối dứt khoát trước khi gửi cổng); approved không nhảy thẳng tới succeeded/unknown/cancelled", () => {
    expect(refundMachine.canTransition("approved", "failed")).toBe(true);
    for (const s of ["succeeded", "unknown", "cancelled"] as const) {
      expect({ s, ok: refundMachine.canTransition("approved", s) }).toEqual({ s, ok: false });
    }
    expect(refundMachine.canTransition("requested", "failed")).toBe(false);
  });
  it("T-044: chỉ failed hủy được (→ cancelled, kết thúc); unknown/processing phải đối chiếu trước", () => {
    expect(refundMachine.canTransition("failed", "cancelled")).toBe(true);
    expect(refundMachine.isTerminal("cancelled")).toBe(true);
    for (const s of ["requested", "approved", "processing", "unknown", "succeeded", "rejected"] as const) {
      expect({ s, ok: refundMachine.canTransition(s, "cancelled") }).toEqual({ s, ok: false });
    }
    expect(refundMachine.canTransition("cancelled", "processing")).toBe(false);
    // Đối chiếu trước khi hủy thấy cổng đã hoàn → succeeded (không hủy nhầm khoản đã chi).
    expect(applyProviderState(refundMachine, "failed", "succeeded").changed).toBe(true);
  });
  it("T-044: retry có giới hạn — failed và attempts < max", () => {
    expect(canRetryRefund({ state: "failed", attempts: 1 }, 3)).toBe(true);
    expect(canRetryRefund({ state: "failed", attempts: 2 }, 3)).toBe(true);
    expect(canRetryRefund({ state: "failed", attempts: 3 }, 3)).toBe(false);
    expect(canRetryRefund({ state: "failed", attempts: 4 }, 3)).toBe(false);
    expect(canRetryRefund({ state: "failed", attempts: 0 }, 1)).toBe(true);
    expect(canRetryRefund({ state: "failed", attempts: Number.NaN }, 3)).toBe(false);
    expect(canRetryRefund({ state: "cancelled", attempts: 0 }, 3)).toBe(false);
    expect(canRetryRefund({ state: "approved", attempts: 0 }, 3)).toBe(false);
    expect(() => canRetryRefund({ state: "failed", attempts: 0 }, 0)).toThrow(RangeError);
    expect(() => canRetryRefund({ state: "failed", attempts: 0 }, 1.5)).toThrow(RangeError);
  });
  it("settled là kết thúc", () => {
    expect(settlementMachine.isTerminal("settled")).toBe(true);
  });
});
