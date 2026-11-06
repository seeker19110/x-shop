/**
 * `getRefundGateway` theo VNPAY_MODE (T-168 kiểm lại thiết kế T-027): chỉ `mock` (dev/CI) có cổng hoàn giả lập; sandbox,
 * live và VNPAY tắt (cấu hình null) luôn là cổng TẮT — fail-closed tới khi có ủy quyền hoàn tiền thật.
 */
type Mode = "mock" | "sandbox" | "live" | null;

function gatewayFor(mode: Mode): { enabled: boolean; name: string } {
  let out: { enabled: boolean; name: string } = { enabled: false, name: "" };
  jest.isolateModules(() => {
    jest.doMock("../../../lib/checkout/config", () => ({
      getVnpayConfig: () =>
        mode === null
          ? null
          : { mode, tmnCode: "TESTTMN1", hashSecret: "S".repeat(32), hashSecretPrevious: null },
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp lại module sau doMock trong isolateModules
    const m = require("../refund-gateway") as typeof import("../refund-gateway");
    const g = m.getRefundGateway();
    out = { enabled: g.enabled, name: g.constructor.name };
  });
  return out;
}

describe("getRefundGateway", () => {
  afterEach(() => jest.dontMock("../../../lib/checkout/config"));

  it("mock → cổng giả lập (bật)", () => {
    expect(gatewayFor("mock")).toEqual({ enabled: true, name: "MockVnpayRefundGateway" });
  });

  it.each(["sandbox", "live", null] as const)("%s → cổng TẮT (fail-closed)", (mode) => {
    expect(gatewayFor(mode)).toEqual({ enabled: false, name: "DisabledRefundGateway" });
  });

  it("cổng tắt không gọi mạng: refund → failed provider_disabled, query → not_found", async () => {
    const { DisabledRefundGateway } =
      jest.requireActual<typeof import("../refund-gateway")>("../refund-gateway");
    const g = new DisabledRefundGateway();
    await expect(g.refund()).resolves.toEqual({
      outcome: "failed",
      providerRef: null,
      reason: "provider_disabled",
    });
    await expect(g.query()).resolves.toEqual({ outcome: "not_found", reason: "provider_disabled" });
  });
});
