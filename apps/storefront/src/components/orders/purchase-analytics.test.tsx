import { render } from "@testing-library/react";
import { findPii, type AnalyticsEvent } from "../../lib/analytics/schema";
import { resetAnalyticsForTests } from "../../lib/analytics/track";
import { mapOrder } from "../../lib/orders/map";
import type { OrderDetails } from "../../lib/orders/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../../lib/orders/actions", () => ({
  recheckOrderAction: vi.fn(),
  cancelOrderAction: vi.fn(),
  lookupOrderAction: vi.fn(),
  redeemLinkAction: vi.fn(),
}));

import { OrderDetail } from "./OrderDetail";
import { purchaseEventOf } from "./purchase-event";

const RAW = {
  display_ref: "XS-PUR001",
  state: "confirmed",
  payment_method: "vnpay",
  payment_state: "paid",
  shipment_state: "unfulfilled",
  created_at: "2026-10-24T10:00:00.000Z",
  hold_expires_at: null,
  cod_confirm_by: null,
  cancel_reason: null,
  timeline: [{ at: "2026-10-24T10:00:00.000Z", kind: "placed", label: "Đã đặt đơn" }],
  lines: [
    {
      title: "Áo thun",
      variant_title: "Đen / M",
      quantity: 1,
      unit_price: 700000,
      total: 700000,
      thumbnail: null,
    },
  ],
  totals: { subtotal: 700000, discount_total: 0, shipping_total: 30000, total: 730000, paid: 730000 },
  address: { province_name: "Thành phố Hà Nội", ward_name: "Phường Ba Đình", line: "12 Điện Biên Phủ" },
  contact: { name: "Nguyễn Văn An", phone: "0912***678" },
  actions: { can_cancel: true, can_recheck: false },
};
const order = (patch: Partial<OrderDetails> = {}): OrderDetails => ({ ...mapOrder(RAW)!, ...patch });
const NOW = new Date("2026-10-24T10:05:00Z");
const purchases = () => ((window.dataLayer ?? []) as AnalyticsEvent[]).filter((e) => e.event === "purchase");

beforeEach(() => {
  window.dataLayer = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetAnalyticsForTests();
});

describe("purchaseEventOf — định nghĩa purchase theo trạng thái server", () => {
  it("VNPAY đã thanh toán → purchase với mã đơn, tổng tiền nguyên VND, phương thức; không PII", () => {
    const e = purchaseEventOf(order());
    expect(e).toEqual({ event: "purchase", order_id: "XS-PUR001", value: 730000, payment_type: "vnpay" });
    expect(findPii(e)).toBeNull();
  });

  it("COD: chỉ khi đơn đã xác nhận/hoàn tất (đặt xong chưa xác nhận → order_placed, không purchase)", () => {
    const cod = (state: OrderDetails["state"], paymentState: OrderDetails["paymentState"] = "cod") =>
      purchaseEventOf(order({ paymentMethod: "cod", state, paymentState }));
    expect(cod("placed")).toBeNull();
    expect(cod("confirmed")).toMatchObject({ event: "purchase", payment_type: "cod", value: 730000 });
    expect(cod("completed", "paid")).toMatchObject({ event: "purchase", payment_type: "cod" });
    expect(cod("cancelled")).toBeNull();
    expect(cod("cancelled", "void")).toBeNull();
  });

  it("VNPAY chưa xác nhận / chưa rõ / hết hạn / hủy chờ hoàn → không", () => {
    for (const [state, paymentState] of [
      ["awaiting_payment", "pending"],
      ["awaiting_payment", "unknown"],
      ["cancelled", "expired"],
      ["cancelled", "refund_pending"],
      ["cancelled", "paid"],
      ["confirmed", "pending"],
    ] as const) {
      expect({ state, paymentState, e: purchaseEventOf(order({ state, paymentState })) }).toEqual({
        state,
        paymentState,
        e: null,
      });
    }
  });

  it("biên tiền: 0 đồng hợp lệ (đơn 0đ đã xác nhận); không nguyên/âm/vượt an toàn → không bắn", () => {
    const withTotal = (total: number) => purchaseEventOf(order({ totals: { ...order().totals, total } }));
    expect(withTotal(0)).toMatchObject({ value: 0 });
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(withTotal(bad)).toBeNull();
  });
});

describe("OrderDetail bắn purchase một lần mỗi đơn", () => {
  it("đơn đã thanh toán: bắn khi hiện trang; render lại / mở lại trang (tab mới) không bắn lần 2", () => {
    const { rerender, unmount } = render(<OrderDetail order={order()} now={NOW} />);
    expect(purchases()).toEqual([
      {
        v: 1,
        currency: "VND",
        event: "purchase",
        order_id: "XS-PUR001",
        value: 730000,
        payment_type: "vnpay",
      },
    ]);
    rerender(<OrderDetail order={order()} now={NOW} />);
    unmount();
    window.sessionStorage.clear();
    resetAnalyticsForTests(); // tab/phiên mới: chỉ còn localStorage
    render(<OrderDetail order={order()} now={NOW} />);
    expect(purchases()).toHaveLength(1);
    expect(JSON.stringify(purchases())).not.toMatch(/Nguyễn|0912|Điện Biên|Áo thun/);
  });

  it("đang chờ thanh toán → không bắn; sau khi server xác nhận (render lại với đơn paid) → bắn đúng một lần", () => {
    const pending = order({ state: "awaiting_payment", paymentState: "pending" });
    const { rerender } = render(<OrderDetail order={pending} now={NOW} />);
    expect(purchases()).toHaveLength(0);
    rerender(<OrderDetail order={order()} now={NOW} />);
    rerender(<OrderDetail order={order()} now={NOW} />);
    expect(purchases()).toHaveLength(1);
  });

  it("đơn khác → sự kiện riêng; COD vừa đặt (placed) → không bắn", () => {
    render(
      <OrderDetail order={order({ paymentMethod: "cod", state: "placed", paymentState: "cod" })} now={NOW} />,
    );
    expect(purchases()).toHaveLength(0);
    render(<OrderDetail order={order({ ref: "XS-PUR002" })} now={NOW} />);
    render(<OrderDetail order={order()} now={NOW} />);
    expect(
      purchases()
        .map((e) => e.order_id)
        .sort(),
    ).toEqual(["XS-PUR001", "XS-PUR002"]);
  });
});
