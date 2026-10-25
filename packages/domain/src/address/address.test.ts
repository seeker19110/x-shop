import { describe, expect, it } from "vitest";
import {
  addressDatasetVersion,
  listProvinces,
  listWards,
  normalizeVnPhone,
  suggestWards,
  validateAddress,
} from "./address.js";

describe("danh mục 2 cấp", () => {
  it("34 tỉnh/thành, 3.321 phường/xã, mã duy nhất", () => {
    const provinces = listProvinces();
    expect(provinces).toHaveLength(34);
    const wards = provinces.flatMap((p) => listWards(p.code));
    expect(wards).toHaveLength(3321);
    expect(new Set(wards.map((w) => w.code)).size).toBe(3321);
    expect(addressDatasetVersion()).toMatch(/thanglequoc/);
  });
  it("Hà Nội có Phường Ba Đình; tỉnh lạ → rỗng", () => {
    expect(listProvinces()[0]).toEqual({ code: "01", name: "Thành phố Hà Nội" });
    expect(listWards("01").some((w) => w.name === "Phường Ba Đình")).toBe(true);
    expect(listWards("99")).toEqual([]);
  });
});

describe("validateAddress — S-301, AT23", () => {
  const ward = listWards("01")[0]!;
  it("hợp lệ → snapshot có tên + phiên bản dữ liệu, không có quận/huyện", () => {
    const r = validateAddress({
      provinceCode: "01",
      wardCode: ward.code,
      line: "  12  Phố Huế ",
      original: "12 Phố Huế, HN",
    });
    expect(r).toMatchObject({
      ok: true,
      value: {
        provinceName: "Thành phố Hà Nội",
        wardName: ward.name,
        line: "12 Phố Huế",
        original: "12 Phố Huế, HN",
      },
    });
    if (r.ok) expect(r.value).not.toHaveProperty("districtCode");
  });
  it("lỗi gắn trường", () => {
    expect(validateAddress({ provinceCode: "99", wardCode: ward.code, line: "abc" })).toMatchObject({
      ok: false,
      code: "PROVINCE_NOT_FOUND",
      field: "province_code",
    });
    expect(validateAddress({ provinceCode: "01", wardCode: "x", line: "abc" })).toMatchObject({
      code: "WARD_NOT_FOUND",
    });
    const other = listWards("79")[0]!;
    expect(validateAddress({ provinceCode: "01", wardCode: other.code, line: "abc" })).toMatchObject({
      code: "WARD_PROVINCE_MISMATCH",
    });
    expect(validateAddress({ provinceCode: "01", wardCode: ward.code, line: " a " })).toMatchObject({
      field: "address_line",
    });
    expect(validateAddress({ provinceCode: "01", wardCode: ward.code, line: "x".repeat(201) })).toMatchObject(
      {
        field: "address_line",
      },
    );
  });
  it("gợi ý phường/xã không dấu để khách xác nhận", () => {
    expect(suggestWards("01", "ba dinh").map((w) => w.name)).toContain("Phường Ba Đình");
    expect(suggestWards("01", "Phường Ba Đình").map((w) => w.name)).toContain("Phường Ba Đình");
    expect(suggestWards("01", "  ")).toEqual([]);
    expect(suggestWards("01", "a", 3)).toHaveLength(3);
  });
});

describe("normalizeVnPhone", () => {
  it("chuẩn hóa +84 và khoảng trắng", () => {
    expect(normalizeVnPhone("+84 912 345 678")).toEqual({ ok: true, value: "0912345678" });
    expect(normalizeVnPhone("0912.345.678")).toEqual({ ok: true, value: "0912345678" });
  });
  it("từ chối số bàn/sai độ dài", () => {
    for (const bad of ["0212345678", "091234567", "09123456789", "abc", ""]) {
      expect(normalizeVnPhone(bad)).toMatchObject({ ok: false, field: "phone" });
    }
  });
});
