// @vitest-environment node
import nextConfig, { PRIVATE_SOURCES } from "../../../next.config";

/** S-505 / AT22: mọi đường riêng tư trả `Cache-Control: private, no-store`. */
describe("next.config headers: đường riêng tư không cache", () => {
  it("giỏ, thanh toán, đơn hàng và API giỏ/checkout đều có private, no-store", async () => {
    const rules = await nextConfig.headers!();
    for (const source of PRIVATE_SOURCES) {
      const rule = rules.find((r) => r.source === source);
      expect(rule, source).toBeDefined();
      expect(rule!.headers).toContainEqual({ key: "Cache-Control", value: "private, no-store" });
    }
    expect(PRIVATE_SOURCES).toEqual(
      expect.arrayContaining(["/gio-hang", "/thanh-toan", "/don-hang/:path*", "/api/cart/:path*"]),
    );
  });

  it("route /api/cart/count tự đặt private, no-store ngay cả khi chạy ngoài Next", async () => {
    vi.resetModules();
    vi.doMock("./service", () => ({ loadCartCount: async () => 3 }));
    const { GET } = await import("../../app/api/cart/count/route");
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ count: 3 });
  });
});
