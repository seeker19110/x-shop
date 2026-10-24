// @vitest-environment node
import { resetEnvCacheForTests } from "../env";

const jar = vi.hoisted(() => new Map<string, { value: string; options?: Record<string, unknown> }>());
const reqHeaders = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { name: n, value: jar.get(n)!.value } : undefined),
    set: (n: string, value: string, options?: Record<string, unknown>) => void jar.set(n, { value, options }),
    delete: (n: string) => void jar.delete(n),
  }),
  headers: async () => ({ get: (n: string) => reqHeaders.get(n.toLowerCase()) ?? null }),
}));
const redirectMock = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`REDIRECT ${url}`);
  }),
);
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import { lookupOrderAction, redeemLinkAction } from "./actions";
import { orderCookieName, writeOrderAccess } from "./cookie";
import { mapOrder, mapOrderResponse } from "./map";
import { presentOrder } from "./present";
import { cancelOrder, fetchOrder, recheckOrder } from "./service";
import type { OrderDetails } from "./types";

/** Phản hồi thật của GET /store/x/orders/:ref (đơn VNPAY đang chờ) — hình theo backend `lib/orders/view.ts`. */
const BACKEND_ORDER = {
  display_ref: "XS-ABC123",
  state: "awaiting_payment",
  payment_method: "vnpay",
  payment_state: "pending",
  shipment_state: "unfulfilled",
  created_at: "2026-10-24T10:00:00.000Z",
  hold_expires_at: "2026-10-24T10:15:00.000Z",
  cod_confirm_by: null,
  cancel_reason: null,
  timeline: [{ at: "2026-10-24T10:00:00.000Z", kind: "placed", label: "Đã đặt đơn" }],
  lines: [
    { title: "Áo thun", variant_title: "Đen / M", quantity: 2, unit_price: 700000, total: 1400000, thumbnail: null },
  ],
  totals: { subtotal: 1400000, discount_total: 0, shipping_total: 30000, total: 1430000, paid: 0 },
  address: { province_name: "Thành phố Hà Nội", ward_name: "Phường Ba Đình", line: "12 Điện Biên Phủ" },
  contact: { name: "Nguyễn Văn An", phone: "0912***678" },
  actions: { can_cancel: true, can_recheck: true },
};
const TOKEN = "b3JkZXJfMDFBQkMuMTc2MTMwMDAwMA.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

const order = (patch: Partial<OrderDetails> = {}): OrderDetails => ({ ...mapOrder(BACKEND_ORDER)!, ...patch });

describe("map: phản hồi đơn của backend", () => {
  it("đủ trường, tiền nguyên, 3 trạng thái tách riêng", () => {
    expect(mapOrder(BACKEND_ORDER)).toMatchObject({
      ref: "XS-ABC123",
      state: "awaiting_payment",
      paymentMethod: "vnpay",
      paymentState: "pending",
      shipmentState: "unfulfilled",
      holdExpiresAt: "2026-10-24T10:15:00.000Z",
      totals: { total: 1430000, paid: 0 },
      canCancel: true,
      canRecheck: true,
    });
  });

  it("dữ liệu hỏng → null; payment_state lạ → unknown (không bao giờ thành paid)", () => {
    expect(mapOrder({ ...BACKEND_ORDER, display_ref: "<script>" })).toBeNull();
    expect(mapOrder({ ...BACKEND_ORDER, totals: { ...BACKEND_ORDER.totals, total: -1 } })).toBeNull();
    expect(mapOrder({ ...BACKEND_ORDER, lines: [{ quantity: 1.5 }] })).toBeNull();
    expect(mapOrder({ ...BACKEND_ORDER, payment_state: "PAID" })?.paymentState).toBe("unknown");
    expect(mapOrder({ ...BACKEND_ORDER, actions: { can_cancel: "yes" } })?.canCancel).toBe(false);
  });

  it("mã trạng thái → kết quả có kiểm soát (404 không phân biệt, 429 có thời gian chờ, 0 = mạng)", () => {
    expect(mapOrderResponse(404, { code: "NOT_FOUND" })).toEqual({ kind: "not_found" });
    expect(mapOrderResponse(429, { retry_after_seconds: 600 })).toEqual({ kind: "rate_limited", retryAfterS: 600 });
    expect(mapOrderResponse(0, null)).toEqual({ kind: "network" });
    expect(mapOrderResponse(409, { code: "PAYMENT_PENDING", detail: "Đang xác nhận" })).toEqual({
      kind: "error",
      code: "PAYMENT_PENDING",
      message: "Đang xác nhận",
    });
    expect(mapOrderResponse(200, { state: "x" })).toMatchObject({ kind: "error", code: "UNAVAILABLE" });
  });
});

describe("present: 3 khối Đặt đơn / Thanh toán / Giao hàng (CHK06)", () => {
  const before = new Date("2026-10-24T10:05:00Z");
  it("online đang chờ: 'Đang xác nhận thanh toán', hạn giữ hàng từ server, không mời trả lại, có Kiểm tra lại", () => {
    const p = presentOrder(order(), before);
    expect(p.placement.title).toBe("Đặt đơn");
    expect(p.payment.status).toBe("Đang xác nhận thanh toán");
    expect(p.payment.detail).toContain("17:15 24/10/2026"); // 10:15 UTC → giờ Việt Nam
    expect(p.payment.detail).toContain("không cần thanh toán lại");
    expect(p.showRecheck).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/Đã thanh toán/);
  });

  it("quá hạn giữ hàng nhưng chưa có kết quả cuối → vẫn 'đang xác nhận', không báo paid", () => {
    const p = presentOrder(order({ paymentState: "unknown" }), new Date("2026-10-24T11:00:00Z"));
    expect(p.payment.status).toBe("Đang xác nhận thanh toán");
    expect(p.payment.detail).toContain("đang kiểm tra kết quả cuối cùng");
  });

  it("chỉ nói đã thanh toán khi server báo paid", () => {
    const paid = presentOrder(order({ state: "confirmed", paymentState: "paid", totals: { ...order().totals, paid: 1430000 } }));
    expect(paid.payment.status).toBe("Đã thanh toán 1.430.000 ₫");
    expect(paid.showRecheck).toBe(false);
  });

  it("hết hạn → đơn hủy + hướng dẫn đặt lại; COD; đã hủy có hoàn tiền; giao hàng tách riêng", () => {
    const expired = presentOrder(
      order({ state: "cancelled", paymentState: "expired", cancelReason: "HOLD_EXPIRED", canRecheck: false }),
    );
    expect(expired.placement.detail).toContain("quá thời hạn thanh toán");
    expect(expired.payment.status).toBe("Hết thời hạn thanh toán");
    expect(expired.shipment.status).toBe("Không giao (đơn đã hủy)");
    expect(expired.showReorder).toBe(true);
    const cod = presentOrder(order({ state: "placed", paymentMethod: "cod", paymentState: "cod", canRecheck: false }));
    expect(cod.payment.status).toBe("Thanh toán khi nhận hàng");
    expect(cod.shipment.status).toContain("Chưa giao");
    const refund = presentOrder(order({ state: "cancelled", paymentState: "refund_pending" }));
    expect(refund.payment.status).toBe("Đang xử lý hoàn tiền");
  });
});

describe("service: token phiên đơn chỉ ở cookie HttpOnly + header, không qua URL", () => {
  const saved = { ...process.env };
  let calls: Array<{ url: string; init?: RequestInit }>;
  let reply: { status: number; body: unknown };
  beforeEach(() => {
    jar.clear();
    reqHeaders.clear();
    calls = [];
    reply = { status: 200, body: BACKEND_ORDER };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    });
    process.env.XS_DATA_SOURCE = "backend";
    process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
    process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = "pk_test";
    resetEnvCacheForTests();
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
    resetEnvCacheForTests();
  });

  it("ghi cookie: HttpOnly, SameSite=Lax, hết hạn theo token; mã/token lạ → không ghi", async () => {
    const exp = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    expect(await writeOrderAccess("XS-ABC123", TOKEN, exp)).toBe(true);
    const c = jar.get(orderCookieName("XS-ABC123"))!;
    expect(c.value).toBe(TOKEN);
    expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(Number(c.options!.maxAge)).toBeGreaterThan(6 * 24 * 3600);
    expect(jar.get("xs_order_last")?.value).toBe("XS-ABC123");
    expect(await writeOrderAccess("xs-abc", TOKEN, exp)).toBe(false);
    expect(await writeOrderAccess("XS-ABC124", "rác; Path=/", exp)).toBe(false);
  });

  it("không có cookie → not_found, không gọi backend; có cookie → header x-order-access + IP khách", async () => {
    expect(await fetchOrder("XS-ABC123")).toEqual({ kind: "not_found" });
    expect(calls).toHaveLength(0);
    jar.set(orderCookieName("XS-ABC123"), { value: TOKEN });
    reqHeaders.set("x-forwarded-for", "1.1.1.1, 203.0.113.9");
    const r = await fetchOrder("XS-ABC123");
    expect(r.kind).toBe("ok");
    expect(calls[0]!.url).toBe("http://backend.test:9000/store/x/orders/XS-ABC123");
    expect(calls[0]!.url).not.toContain(TOKEN);
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h["x-order-access"]).toBe(TOKEN);
    expect(h["x-forwarded-for"]).toBe("203.0.113.9");
  });

  it("mất mạng → network (không hiển thị trạng thái cũ/đã thanh toán)", async () => {
    jar.set(orderCookieName("XS-ABC123"), { value: TOKEN });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchOrder("XS-ABC123")).toEqual({ kind: "network" });
    expect(await recheckOrder("XS-ABC123")).toEqual({ kind: "network" });
  });

  it("recheck/cancel gọi đúng route POST; cancel đọc refund_requested", async () => {
    jar.set(orderCookieName("XS-ABC123"), { value: TOKEN });
    await recheckOrder("XS-ABC123");
    expect(calls[0]!.url).toMatch(/\/store\/x\/orders\/XS-ABC123\/recheck$/);
    expect(calls[0]!.init!.method).toBe("POST");
    reply = { status: 200, body: { ...BACKEND_ORDER, state: "cancelled", cancel: { refund_requested: true } } };
    const c = await cancelOrder("XS-ABC123");
    expect(c).toMatchObject({ kind: "ok", refundRequested: true });
    reply = { status: 409, body: { code: "NOT_CANCELLABLE", detail: "Không hủy được" } };
    expect(await cancelOrder("XS-ABC123")).toMatchObject({ kind: "error", code: "NOT_CANCELLABLE" });
  });

  it("tra cứu: 202 → thông điệp chung; 422 gắn trường; 429; thiếu trường không gọi backend", async () => {
    const form = (ma: string, sdt: string) => {
      const f = new FormData();
      f.set("ma", ma);
      f.set("sdt", sdt);
      return f;
    };
    reply = { status: 202, body: { accepted: true, message: "Nếu thông tin đúng, chúng tôi đã gửi liên kết…" } };
    expect(await lookupOrderAction({ status: "idle" }, form("xs-abc123", "0912345678"))).toEqual({
      status: "sent",
      message: "Nếu thông tin đúng, chúng tôi đã gửi liên kết…",
    });
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ display_ref: "XS-ABC123", phone: "0912345678" });
    reply = { status: 422, body: { code: "VALIDATION", field: "phone", detail: "Số điện thoại không hợp lệ" } };
    expect(await lookupOrderAction({ status: "idle" }, form("XS-ABC123", "1"))).toMatchObject({
      status: "invalid",
      field: "phone",
    });
    reply = { status: 429, body: { code: "RATE_LIMITED" } };
    expect((await lookupOrderAction({ status: "idle" }, form("XS-ABC123", "0912345678"))).status).toBe(
      "rate_limited",
    );
    const n = calls.length;
    expect((await lookupOrderAction({ status: "idle" }, form("", "0912345678"))).status).toBe("invalid");
    expect(calls).toHaveLength(n);
  });

  it("đổi liên kết: thành công → cookie + chuyển tới /don-hang/:ref (không token); thất bại → /tra-cuu-don?loi=lien-ket", async () => {
    const exp = new Date(Date.now() + 3600_000).toISOString();
    reply = { status: 200, body: { display_ref: "XS-ABC123", order_access: TOKEN, order_access_expires_at: exp } };
    const f = new FormData();
    f.set("token", "link-token.abc");
    await expect(redeemLinkAction(f)).rejects.toThrow("REDIRECT /don-hang/XS-ABC123");
    expect(jar.get(orderCookieName("XS-ABC123"))?.value).toBe(TOKEN);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ token: "link-token.abc" });
    reply = { status: 404, body: { code: "NOT_FOUND" } };
    await expect(redeemLinkAction(f)).rejects.toThrow("REDIRECT /tra-cuu-don?loi=lien-ket");
  });
});
