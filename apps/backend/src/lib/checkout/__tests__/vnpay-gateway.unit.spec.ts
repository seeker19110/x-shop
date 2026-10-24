import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { vnpay } from "@x-shop/domain";
import { FixedWindowLimiter } from "../../http/rate-limit";
import { HttpVnpayGateway } from "../vnpay-gateway";

const cfg = { tmnCode: "XSHOPTEST", hashSecret: "unit-test-secret-0123456789abcdef0123" };
const input = {
  txnRef: "PA_TEST",
  amount: 150_000,
  transactionDate: new Date(),
  orderInfo: "Thanh toan don XS-ABC123",
};

/** Máy chủ giả VNPAY API: handler quyết định phản hồi; ghi lại body nhận được. */
async function fakeVnpay(
  handler: (body: Record<string, string>, res: import("node:http").ServerResponse) => void,
) {
  const bodies: Array<Record<string, string>> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, string>;
      bodies.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return { url, bodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("HttpVnpayGateway (querydr) — kết quả mơ hồ luôn là unknown (AT11)", () => {
  it("VNPAY không trả lời trong hạn → unknown/timeout", async () => {
    const s = await fakeVnpay(() => undefined);
    try {
      const r = await new HttpVnpayGateway({ ...cfg, apiUrl: s.url }, 150).queryStatus(input);
      expect(r).toEqual({ outcome: "unknown", transactionNo: null, reason: "timeout" });
      expect(s.bodies[0]).toMatchObject({
        vnp_Command: "querydr",
        vnp_TxnRef: "PA_TEST",
        vnp_TmnCode: cfg.tmnCode,
      });
    } finally {
      await s.close();
    }
  });

  it("HTTP 500 / mất kết nối / chữ ký phản hồi sai → unknown", async () => {
    const s500 = await fakeVnpay((_b, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    try {
      expect(
        (await new HttpVnpayGateway({ ...cfg, apiUrl: s500.url }, 2000).queryStatus(input)).outcome,
      ).toBe("unknown");
    } finally {
      await s500.close();
    }
    const down = await new HttpVnpayGateway({ ...cfg, apiUrl: "http://127.0.0.1:9/api" }, 2000).queryStatus(
      input,
    );
    expect(down).toMatchObject({ outcome: "unknown", reason: "network" });

    const forged = await fakeVnpay((_b, res) => {
      const reply = new vnpay.MockVnpayGateway({ ...cfg, hashSecret: "khoa-khac-0123456789" }).query(
        "PA_TEST",
        150_000,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(reply));
    });
    try {
      const r = await new HttpVnpayGateway({ ...cfg, apiUrl: forged.url }, 2000).queryStatus(input);
      expect(r).toMatchObject({ outcome: "unknown", reason: "invalid_signature" });
    } finally {
      await forged.close();
    }
  });

  it("phản hồi hợp lệ: đã trả → paid kèm transactionNo; chưa trả → not_paid", async () => {
    const mock = new vnpay.MockVnpayGateway(cfg);
    const s = await fakeVnpay((body, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(mock.query(body.vnp_TxnRef as string, 150_000)));
    });
    try {
      const gw = new HttpVnpayGateway({ ...cfg, apiUrl: s.url }, 2000);
      expect((await gw.queryStatus(input)).outcome).toBe("not_paid");
      const url = vnpay.buildPaymentUrl(
        { ...cfg, paymentUrl: "https://pay.test/vpc", apiUrl: s.url, returnUrl: "https://shop.test/kq" },
        {
          txnRef: "PA_TEST",
          amount: 150_000,
          orderInfo: "x",
          ipAddr: "127.0.0.1",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      );
      const paid = mock.pay(url, "success");
      expect(await gw.queryStatus(input)).toMatchObject({
        outcome: "paid",
        transactionNo: paid.get("vnp_TransactionNo"),
      });
    } finally {
      await s.close();
    }
  });
});

describe("FixedWindowLimiter", () => {
  it("cho qua tới giới hạn trong cửa sổ, chặn phần vượt, mở lại ở cửa sổ sau; khóa độc lập", () => {
    const l = new FixedWindowLimiter(2, 1000);
    expect([l.allow("a", 0), l.allow("a", 10), l.allow("a", 20)]).toEqual([true, true, false]);
    expect(l.allow("b", 20)).toBe(true);
    expect(l.allow("a", 1000)).toBe(true);
  });

  it("quá số khóa tối đa → dọn khóa cũ, không phình bộ nhớ", () => {
    const l = new FixedWindowLimiter(1, 1000, 2);
    l.allow("a", 0);
    l.allow("b", 0);
    expect(l.allow("c", 5000)).toBe(true);
    expect(l.allow("a", 5000)).toBe(true);
  });
});
