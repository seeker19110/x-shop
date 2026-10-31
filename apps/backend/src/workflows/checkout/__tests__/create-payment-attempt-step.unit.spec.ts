import { createMedusaContainer } from "@medusajs/framework/utils";
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { asValue } from "@medusajs/framework/awilix";
import { vnpay } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import { createPaymentAttemptStep } from "../steps";

const VNPAY = {
  mode: "mock",
  tmnCode: "XSHOPTEST",
  hashSecret: "unit-test-secret-0123456789abcdef0123",
  paymentUrl: "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html",
  apiUrl: "https://sandbox.vnpayment.vn/merchant_webapi/api/transaction",
  returnUrl: "https://shop.example/thanh-toan/ket-qua",
};
jest.mock("../../../lib/checkout/config", () => ({
  ...jest.requireActual("../../../lib/checkout/config"),
  getVnpayConfig: () => VNPAY,
}));

/**
 * T-170: chuỗi lưu vào attempt (`vnp_create_date`) phải tính từ `now` của input (`prepared.now`) — CÙNG mốc ký
 * `vnp_CreateDate` vào URL — không từ đồng hồ lúc step chạy. `now` cố định ở quá khứ xa nên mọi cách lấy giờ hiện tại
 * (vd `toVnpDate(new Date())`) đều đỏ tất định, không phụ thuộc ranh giới giây.
 */
function harness() {
  const inserts: Array<Record<string, unknown>> = [];
  const pending: Array<[string, string]> = [];
  const service = {
    insertPaymentAttempt: jest.fn(async (input: Record<string, unknown>) => {
      inserts.push(input);
      return "payatt_TEST";
    }),
    markPaymentAttemptPending: jest.fn(async (id: string, url: string) => {
      pending.push([id, url]);
    }),
    failOpenPaymentAttempt: jest.fn(async () => undefined),
  };
  const container = createMedusaContainer();
  container.register(CHECKOUT_MODULE, asValue(service));
  return { container, inserts, pending };
}

let seq = 0;
async function run(now: string, holdExpiresAt: string, container: ReturnType<typeof harness>["container"]) {
  const wf = createWorkflow(
    `t170-create-payment-attempt-${++seq}`,
    (input: { now: string; hold: string }) => {
      const r = createPaymentAttemptStep({
        payment_method: "vnpay",
        attempt_id: "chk_TEST",
        order_id: "order_TEST",
        display_ref: "XS-ABC123",
        amount: 150_000,
        now: input.now,
        hold_expires_at: input.hold,
        ip: "203.0.113.5",
      });
      return new WorkflowResponse(r);
    },
  );
  const { result } = await wf(container).run({ input: { now, hold: holdExpiresAt }, throwOnError: true });
  return result as { payment_url: string; txn_ref: string };
}

describe("createPaymentAttemptStep — vnp_create_date (T-170)", () => {
  it('now cố định 2020-01-01T00:00:00Z → lưu "20200101070000" = vnp_CreateDate trong URL đã ký', async () => {
    const h = harness();
    const r = await run("2020-01-01T00:00:00.000Z", "2020-01-01T00:15:00.000Z", h.container);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]).toMatchObject({ provider: "vnpay", vnp_create_date: "20200101070000" });
    const url = new URL(r.payment_url);
    expect(url.searchParams.get("vnp_CreateDate")).toBe("20200101070000");
    expect(url.searchParams.get("vnp_TxnRef")).toBe(h.inserts[0]!.txn_ref);
    expect(h.pending).toEqual([["payatt_TEST", r.payment_url]]);
  });

  it("biên GMT+7: now 16:59:59.999Z → ngày cũ giờ VN; 17:00:00.000Z → đã sang ngày mới (UTC chưa đổi ngày)", async () => {
    for (const [now, expected] of [
      ["2020-02-28T16:59:59.999Z", "20200228235959"],
      ["2020-02-28T17:00:00.000Z", "20200229000000"],
      ["2019-12-31T17:00:00.000Z", "20200101000000"],
    ] as const) {
      const h = harness();
      const hold = new Date(new Date(now).getTime() + 15 * 60_000).toISOString();
      const r = await run(now, hold, h.container);
      expect({
        stored: h.inserts[0]!.vnp_create_date,
        sent: new URL(r.payment_url).searchParams.get("vnp_CreateDate"),
      }).toEqual({ stored: expected, sent: expected });
      expect(vnpay.toVnpDate(vnpay.fromVnpDate(expected)!)).toBe(expected);
    }
  });
});
