import { listWards, validateAddress } from "@x-shop/domain";
import { GhnError, HttpGhnClient, MockModeGhnClient } from "../ghn-client";
import { forwardPath, isCarrierCancelled, planCancel, planProgress } from "../progress";

const ward = listWards("01")[0]!;
const addr = validateAddress({ provinceCode: "01", wardCode: ward.code, line: "1 Tràng Tiền" });
if (!addr.ok) throw new Error("fixture");
const input = {
  clientOrderCode: "XS-ABCDEF-S1",
  to: { name: "Nguyễn Văn A", phone: "0912345678", address: addr.value },
  codAmount: 0,
  insuranceValue: 700_000,
  weightGrams: 300,
  items: [{ name: "Áo", code: "SKU1", quantity: 1, price: 700_000, weightGrams: 300 }],
  paymentTypeId: 1 as const,
  requiredNote: "CHOXEMHANGKHONGTHU" as const,
};

describe("planProgress — áp trạng thái hãng, không lùi", () => {
  it("trực tiếp hợp lệ; trùng → duplicate", () => {
    expect(planProgress("packed", "shipped")).toEqual({
      steps: [{ from: "packed", to: "shipped" }],
      final: "shipped",
      ignored: null,
    });
    expect(planProgress("shipped", "shipped").ignored).toBe("duplicate");
  });
  it("mất mốc trung gian → đi qua bước hợp lệ", () => {
    expect(planProgress("packed", "delivered").steps.map((s) => s.to)).toEqual(["shipped", "delivered"]);
    expect(planProgress("packed", "returned").steps.map((s) => s.to)).toEqual([
      "shipped",
      "returning",
      "returned",
    ]);
  });
  it("mốc cũ / lùi → out_of_order (kể cả cạnh lùi máy cho phép packed→picking)", () => {
    expect(planProgress("delivered", "shipped")).toMatchObject({
      steps: [],
      final: "delivered",
      ignored: "out_of_order",
    });
    expect(planProgress("packed", "picking").ignored).toBe("out_of_order");
    expect(planProgress("returned", "delivered").ignored).toBe("out_of_order");
    expect(forwardPath("delivered", "packed")).toBeNull();
  });
  it("giao lỗi rồi giao lại là hợp lệ", () => {
    expect(planProgress("shipped", "failed").final).toBe("failed");
    expect(planProgress("failed", "shipped").final).toBe("shipped");
  });
  it("hoàn về sau giao lỗi đi qua returning; đã giao thì KHÔNG sang hoàn về (T-045)", () => {
    expect(planProgress("failed", "returned").steps.map((s) => s.to)).toEqual(["returning", "returned"]);
    expect(planProgress("returning", "returned").final).toBe("returned");
    expect(planProgress("delivered", "returning")).toEqual({
      steps: [],
      final: "delivered",
      ignored: "out_of_order",
    });
    expect(planProgress("delivered", "returned").ignored).toBe("out_of_order");
    expect(planProgress("delivered", "failed").ignored).toBe("out_of_order");
  });
});

describe("planCancel — hãng hủy trước lấy hàng (T-045)", () => {
  it("packed/picking → về unfulfilled qua cạnh lùi hợp lệ; đã unfulfilled → duplicate", () => {
    expect(planCancel("packed")).toEqual({
      steps: [
        { from: "packed", to: "picking" },
        { from: "picking", to: "unfulfilled" },
      ],
      final: "unfulfilled",
      ignored: null,
    });
    expect(planCancel("picking").steps).toEqual([{ from: "picking", to: "unfulfilled" }]);
    expect(planCancel("unfulfilled")).toMatchObject({ steps: [], ignored: "duplicate" });
  });
  it("đã lấy hàng/đã giao/đang hoàn → out_of_order, giữ nguyên", () => {
    for (const s of ["shipped", "failed", "delivered", "returning", "returned"] as const) {
      expect(planCancel(s)).toEqual({ steps: [], final: s, ignored: "out_of_order" });
    }
  });
  it("isCarrierCancelled: unfulfilled + có mã hãng; giữ chỗ chưa có mã → false", () => {
    expect(isCarrierCancelled({ state: "unfulfilled", provider_order_code: "GHN1" })).toBe(true);
    expect(isCarrierCancelled({ state: "unfulfilled", provider_order_code: null })).toBe(false);
    expect(isCarrierCancelled({ state: "packed", provider_order_code: "GHN1" })).toBe(false);
  });
});

describe("HttpGhnClient — phân loại lỗi, token chỉ ở header", () => {
  const cfg = {
    mode: "sandbox" as const,
    baseUrl: "https://ghn.test/api/",
    token: "tok-12345678",
    shopId: "99",
  };
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const respond = (status: number, body: unknown) =>
    jest.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("gửi Token/ShopId ở header, đường dẫn chuẩn hoá; tạo thành công → mã vận đơn", async () => {
    const f = respond(200, { code: 200, data: { order_code: "GHN1", total_fee: 25_000 } });
    global.fetch = f;
    const r = await new HttpGhnClient(cfg).createOrder(input);
    expect(r).toEqual({ orderCode: "GHN1", fee: 25_000 });
    const [url, init] = (f as unknown as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ghn.test/api/v2/shipping-order/create");
    expect(init.headers).toMatchObject({ Token: "tok-12345678", ShopId: "99" });
    expect(String(init.body)).not.toContain("tok-12345678");
  });
  it("5xx/401 → unavailable; 400 khi báo phí → not_served; 400 khi tạo → rejected", async () => {
    global.fetch = respond(502, {});
    await expect(
      new HttpGhnClient(cfg).quoteFee({ to: addr.value, weightGrams: 300, insuranceValue: 0 }),
    ).rejects.toMatchObject({
      kind: "unavailable",
    });
    global.fetch = respond(401, {});
    await expect(new HttpGhnClient(cfg).detail("GHN1")).rejects.toMatchObject({ kind: "unavailable" });
    global.fetch = respond(400, { code: 400, message: "route not supported" });
    await expect(
      new HttpGhnClient(cfg).quoteFee({ to: addr.value, weightGrams: 300, insuranceValue: 0 }),
    ).rejects.toMatchObject({
      kind: "not_served",
    });
    await expect(new HttpGhnClient(cfg).createOrder(input)).rejects.toMatchObject({ kind: "rejected" });
    expect(await new HttpGhnClient(cfg).detailByClientCode("XS-1")).toBeNull();
  });
  it("timeout/lỗi mạng → timeout/unavailable (mơ hồ, không coi là chưa tạo)", async () => {
    global.fetch = jest.fn(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const err = await new HttpGhnClient(cfg).createOrder(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GhnError);
    expect((err as GhnError).kind).toBe("timeout");
    global.fetch = jest.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new HttpGhnClient(cfg).detail("GHN1")).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("chi tiết vận đơn: đọc mã/trạng thái/COD; thiếu trường → null", async () => {
    global.fetch = respond(200, {
      code: 200,
      data: {
        order_code: "GHN1",
        client_order_code: "XS-1",
        status: "delivered",
        cod_amount: 0,
        to_phone: "x",
      },
    });
    expect(await new HttpGhnClient(cfg).detail("GHN1")).toEqual({
      orderCode: "GHN1",
      clientOrderCode: "XS-1",
      status: "delivered",
      codAmount: 0,
    });
    global.fetch = respond(200, { code: 200, data: { order_code: "GHN1" } });
    expect(await new HttpGhnClient(cfg).detail("GHN1")).toBeNull();
  });
});

describe("MockModeGhnClient", () => {
  it("tạo idempotent theo client_order_code; lỗi một lần; phường không phục vụ", async () => {
    const m = new MockModeGhnClient();
    m.createFaults.push("timeout_after_commit");
    await expect(m.createOrder(input)).rejects.toMatchObject({ kind: "timeout" });
    expect((await m.detailByClientCode(input.clientOrderCode))?.status).toBe("ready_to_pick");
    const again = await m.createOrder(input);
    expect(m.mock.created).toBe(1);
    expect(again.orderCode).toMatch(/^GHNMOCK/);
    m.unservedWards.add(ward.code);
    await expect(m.quoteFee({ to: addr.value, weightGrams: 300, insuranceValue: 0 })).rejects.toMatchObject({
      kind: "not_served",
    });
  });
});
