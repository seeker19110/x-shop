import { describe, expect, it } from "vitest";
import {
  parseShippingFeeSnapshot,
  reusableShippingFee,
  type ShippingFeeBasis,
  type ShippingFeeSnapshot,
} from "./shipping-fee.js";

const quotedAt = "2026-10-27T03:00:00.000Z";
const expiresAt = "2026-10-27T03:10:00.000Z";
const basis: ShippingFeeBasis = {
  provinceCode: "01",
  wardCode: "00004",
  weightGrams: 500,
  insuranceValue: 700_000,
  service: "ghn-standard",
};
const snap: ShippingFeeSnapshot = { ...basis, fee: 30_000, provider: "ghn", quotedAt, expiresAt };
const quoted = { snapshot: snap, shippingFee: 30_000, paymentMethod: "cod", expiresAt: new Date(expiresAt) };
const current = { ...basis, paymentMethod: "cod" };
const at = (iso: string) => new Date(iso);

describe("reusableShippingFee — phí đã báo còn hiệu lực tới submit (T-153)", () => {
  it("còn hạn, đầu vào không đổi → dùng lại đúng ảnh chụp", () => {
    expect(reusableShippingFee(quoted, current, at("2026-10-27T03:01:00.000Z"))).toEqual(snap);
  });

  it("biên hết hạn: now = hạn → hỏi lại; 1 ms trước hạn → dùng lại", () => {
    expect(reusableShippingFee(quoted, current, at(expiresAt))).toBeNull();
    expect(reusableShippingFee(quoted, current, at("2026-10-27T03:09:59.999Z"))).toEqual(snap);
  });

  it("hạn sớm hơn giữa quote và báo phí quyết định", () => {
    const now = at("2026-10-27T03:05:00.000Z");
    expect(
      reusableShippingFee({ ...quoted, expiresAt: "2026-10-27T03:04:00.000Z" }, current, now),
    ).toBeNull();
    expect(
      reusableShippingFee(
        { ...quoted, snapshot: { ...snap, expiresAt: "2026-10-27T03:04:00.000Z" } },
        current,
        now,
      ),
    ).toBeNull();
  });

  it.each([
    ["tỉnh", { provinceCode: "79" }],
    ["phường", { wardCode: "00007" }],
    ["khối lượng", { weightGrams: 501 }],
    ["giá trị khai (giá đổi)", { insuranceValue: 750_000 }],
    ["dịch vụ", { service: "ghn-express" }],
    ["phương thức thanh toán", { paymentMethod: "vnpay" }],
  ])("đổi %s → hỏi lại", (_label, patch) => {
    expect(reusableShippingFee(quoted, { ...current, ...patch }, at("2026-10-27T03:01:00.000Z"))).toBeNull();
  });

  it("phí ảnh chụp khác phí đã tính vào quote → không dùng (không tin dữ liệu lệch)", () => {
    const now = at("2026-10-27T03:01:00.000Z");
    expect(reusableShippingFee({ ...quoted, shippingFee: 32_000 }, current, now)).toBeNull();
    expect(reusableShippingFee({ ...quoted, shippingFee: "30000" }, current, now)).toBeNull();
  });

  it("phí 0 (miễn phí từ hãng) vẫn là phí hợp lệ, dùng lại được", () => {
    const zero = { ...snap, fee: 0 };
    expect(reusableShippingFee({ ...quoted, snapshot: zero, shippingFee: 0 }, current, at(quotedAt))).toEqual(
      zero,
    );
  });

  it("quote cũ không có ảnh chụp / hạn quote hỏng → hỏi lại", () => {
    const now = at("2026-10-27T03:01:00.000Z");
    expect(reusableShippingFee({ ...quoted, snapshot: null }, current, now)).toBeNull();
    expect(reusableShippingFee({ ...quoted, snapshot: undefined }, current, now)).toBeNull();
    expect(reusableShippingFee({ ...quoted, expiresAt: "không phải ngày" }, current, now)).toBeNull();
  });
});

describe("parseShippingFeeSnapshot", () => {
  it("nhận ảnh chụp đủ trường", () => {
    expect(parseShippingFeeSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it.each([
    ["null", null],
    ["mảng", [snap]],
    ["chuỗi", "30000"],
    ["phí âm", { ...snap, fee: -1 }],
    ["phí lẻ", { ...snap, fee: 30_000.5 }],
    ["phí vượt số nguyên an toàn", { ...snap, fee: 2 ** 53 }],
    ["phí dạng chuỗi", { ...snap, fee: "30000" }],
    ["khối lượng null", { ...snap, weightGrams: null }],
    ["giá trị khai lẻ", { ...snap, insuranceValue: 1.5 }],
    ["phường rỗng", { ...snap, wardCode: "" }],
    ["thiếu tỉnh", { ...snap, provinceCode: undefined }],
    ["hạn không phải ngày", { ...snap, expiresAt: "mai" }],
    ["thiếu thời điểm báo", { ...snap, quotedAt: undefined }],
  ])("%s → null", (_label, raw) => {
    expect(parseShippingFeeSnapshot(raw)).toBeNull();
  });
});
