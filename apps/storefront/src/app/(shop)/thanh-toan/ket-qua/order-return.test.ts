// @vitest-environment node
import nextConfig, { NO_REFERRER_SOURCES, PRIVATE_SOURCES } from "../../../../../next.config";

const m = vi.hoisted(() => ({
  requestAttempt: vi.fn(),
  readLastOrderRef: vi.fn(),
  readOrderAccess: vi.fn(),
  recheckOrder: vi.fn(),
}));
vi.mock("../../../../lib/checkout/service", () => ({ requestAttempt: m.requestAttempt }));
vi.mock("../../../../lib/orders/cookie", () => ({
  readLastOrderRef: m.readLastOrderRef,
  readOrderAccess: m.readOrderAccess,
}));
vi.mock("../../../../lib/orders/service", () => ({ recheckOrder: m.recheckOrder }));

import { GET } from "./route";

/** Tham số VNPAY "thành công" do trình duyệt mang về (chưa có IPN) — route không được tin. */
const VNP = "vnp_ResponseCode=00&vnp_TransactionStatus=00&vnp_TxnRef=PA_1&vnp_OrderInfo=Thanh+toan+don+XS-ABC123";
const req = (qs: string) => new Request(`https://shop.test/thanh-toan/ket-qua?${qs}`);

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.requestAttempt.mockResolvedValue({ kind: "failed", code: "NOT_FOUND", message: "" });
  m.recheckOrder.mockResolvedValue({ kind: "ok" });
});

describe("/thanh-toan/ket-qua (AT08, AT24): không đổi trạng thái theo URL", () => {
  it("có phiên đơn → recheck phía server cùng đơn rồi 303 tới /don-hang/:ref; private no-store, no-referrer", async () => {
    m.readLastOrderRef.mockResolvedValue("XS-ABC123");
    m.readOrderAccess.mockResolvedValue("tok");
    const res = await GET(req(VNP));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://shop.test/don-hang/XS-ABC123");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(m.recheckOrder).toHaveBeenCalledWith("XS-ABC123");
    // Không có tham số nào của VNPAY đi tiếp sang trang đơn.
    expect(res.headers.get("location")).not.toContain("vnp_");
  });

  it("?attempt=… của giỏ trong phiên → lấy mã đơn từ server (không từ URL)", async () => {
    m.requestAttempt.mockResolvedValue({ kind: "placed", ref: "XS-QWE789" });
    m.readOrderAccess.mockResolvedValue("tok");
    const res = await GET(req(`attempt=chk_1&${VNP}`));
    expect(m.requestAttempt).toHaveBeenCalledWith("chk_1");
    expect(res.headers.get("location")).toBe("https://shop.test/don-hang/XS-QWE789");
  });

  it("không có phiên đơn (trình duyệt khác) → trang tra cứu 'đang xác nhận', chỉ điền sẵn mã đơn; không recheck", async () => {
    m.readLastOrderRef.mockResolvedValue(null);
    const res = await GET(req(VNP));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://shop.test/tra-cuu-don?tu=thanh-toan&ma=XS-ABC123");
    expect(m.recheckOrder).not.toHaveBeenCalled();
    // Mã đơn trên URL có cookie phiên của ĐƠN KHÁC → không được cấp quyền theo URL.
    m.readLastOrderRef.mockResolvedValue("XS-ZZZ999");
    m.readOrderAccess.mockResolvedValue(null);
    expect((await GET(req(VNP))).headers.get("location")).toContain("/tra-cuu-don?");
  });
});

describe("next.config: trang đơn/tra cứu riêng tư, token không rò qua Referer", () => {
  it("tra cứu + xác thực + kết quả thanh toán: private, no-store; no-referrer đặt SAU quy tắc chung", async () => {
    expect(PRIVATE_SOURCES).toEqual(
      expect.arrayContaining(["/don-hang/:path*", "/tra-cuu-don", "/tra-cuu-don/:path*", "/thanh-toan/:path*"]),
    );
    const rules = await nextConfig.headers!();
    const global = rules.findIndex((r) => r.source === "/:path*");
    for (const source of NO_REFERRER_SOURCES) {
      const i = rules.findIndex(
        (r) => r.source === source && r.headers.some((h) => h.key === "Referrer-Policy" && h.value === "no-referrer"),
      );
      expect(i, source).toBeGreaterThan(global);
    }
  });
});
