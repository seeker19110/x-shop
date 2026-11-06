import { describe, expect, it } from "vitest";
import { listWards, validateAddress } from "../../address/address.js";
import {
  buildCreateOrderBody,
  buildFeeBody,
  isGhnCancelled,
  mapGhnStatus,
  parseCallback,
  type CreateShipmentInput,
} from "./ghn.js";
import { MockGhn } from "./mock.js";

const ward = listWards("79")[0]!;
const addr = validateAddress({ provinceCode: "79", wardCode: ward.code, line: "1 Lê Lợi" });
if (!addr.ok) throw new Error("fixture");
const input: CreateShipmentInput = {
  clientOrderCode: "XS1001-S1",
  to: { name: "Nguyễn Văn A", phone: "0912345678", address: addr.value },
  codAmount: 0,
  insuranceValue: 1_200_000,
  weightGrams: 600,
  items: [{ name: "Áo sơ mi", code: "SM-DEN-M", quantity: 1, price: 630_000, weightGrams: 300 }],
  paymentTypeId: 1,
  requiredNote: "CHOXEMHANGKHONGTHU",
};

describe("GHN body — địa chỉ 2 cấp", () => {
  it("is_new_to_address, không quận/huyện, COD 0 khi đã trả đủ", () => {
    const b = buildCreateOrderBody(input);
    expect(b).toMatchObject({
      is_new_to_address: true,
      to_ward_name: ward.name,
      to_province_name: addr.value.provinceName,
      cod_amount: 0,
      client_order_code: "XS1001-S1",
    });
    expect(b).not.toHaveProperty("to_district_id");
    expect(buildFeeBody({ to: addr.value, weightGrams: 600, insuranceValue: 0 })).toMatchObject({
      is_new_to_address: true,
    });
  });
  it("chặn đầu vào sai", () => {
    expect(() => buildCreateOrderBody({ ...input, codAmount: -1 })).toThrow();
    expect(() => buildCreateOrderBody({ ...input, clientOrderCode: "a b" })).toThrow();
    expect(() => buildCreateOrderBody({ ...input, weightGrams: 0 })).toThrow();
    expect(() => buildCreateOrderBody({ ...input, items: [] })).toThrow();
  });
});

describe("trạng thái và callback", () => {
  it("ánh xạ trạng thái; lạ → null", () => {
    expect(mapGhnStatus("delivered")).toBe("delivered");
    expect(mapGhnStatus("delivery_fail")).toBe("failed");
    expect(mapGhnStatus("returned")).toBe("returned");
    expect(mapGhnStatus("lost")).toBeNull();
  });
  it("hoàn về người gửi → returning/returned; cancel không phải trạng thái tiến trình", () => {
    expect(mapGhnStatus("waiting_to_return")).toBe("failed");
    for (const s of ["return", "return_transporting", "return_sorting", "returning", "return_fail"]) {
      expect(mapGhnStatus(s)).toBe("returning");
    }
    expect(mapGhnStatus("cancel")).toBeNull();
    expect(isGhnCancelled("cancel")).toBe(true);
    expect(isGhnCancelled("Cancel")).toBe(false);
    expect(isGhnCancelled("")).toBe(false);
    expect(isGhnCancelled("returned")).toBe(false);
  });
  it("parse callback + khóa chống lặp; dị dạng → null", () => {
    const cb = parseCallback({
      OrderCode: "GHN1",
      ClientOrderCode: "XS1001-S1",
      Type: "Switch_status",
      Status: "delivered",
      Time: "2026-10-24T10:00:00Z",
      CODAmount: 0,
    });
    expect(cb).toMatchObject({
      type: "switch_status",
      codAmount: 0,
      eventKey: "GHN1|switch_status|delivered|2026-10-24T10:00:00Z",
    });
    expect(parseCallback(null)).toBeNull();
    expect(parseCallback({ OrderCode: "x" })).toBeNull();
    expect(parseCallback({ OrderCode: "x".repeat(65), Type: "a", Time: "t" })).toBeNull();
    expect(parseCallback({ OrderCode: "x", Type: "cod", Time: "t", CODAmount: 1.5 })?.codAmount).toBeNull();
  });
  it('trường bắt buộc rỗng → null; Status/ClientOrderCode rỗng giữ nguyên "" (BASE-DATA-003)', () => {
    expect(parseCallback({ OrderCode: "", Type: "a", Time: "t" })).toBeNull();
    expect(parseCallback({ OrderCode: "x", Type: "", Time: "t" })).toBeNull();
    expect(parseCallback({ OrderCode: "x", Type: "a", Time: "" })).toBeNull();
    expect(
      parseCallback({ OrderCode: "x", Type: "a", Time: "t", Status: "", ClientOrderCode: "" }),
    ).toMatchObject({
      status: "",
      clientOrderCode: "",
      codAmount: null,
    });
  });
});

describe("MockGhn — S-303 không tạo trùng", () => {
  it("tạo lại cùng client_order_code trả vận đơn cũ", () => {
    const g = new MockGhn();
    const a = g.create(input);
    const b = g.create(input);
    expect(b).toEqual({ orderCode: a.orderCode, duplicate: true });
    expect(g.created).toBe(1);
    g.setStatus("XS1001-S1", "delivered");
    expect(g.detailByClientCode("XS1001-S1")?.status).toBe("delivered");
    g.setStatus("khong-co", "delivered");
    expect(g.detailByClientCode("khong-co")).toBeNull();
    expect(g.fee(500)).toBe(22_000);
    expect(g.fee(1200)).toBe(32_000);
  });
});
