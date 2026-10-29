import { readFileSync } from "node:fs";
import { err, ok, type Result } from "../result.js";
import { searchKey, toNfc } from "../catalog/text.js";
import {
  CHECKOUT_LIMITS,
  CHECKOUT_MESSAGES,
  charLength,
  normalizePhone,
  normalizeText,
} from "../validation/index.js";

/**
 * Danh mục đơn vị hành chính 2 cấp (tỉnh/thành → phường/xã) sau sắp xếp 01/07/2025 — 34 tỉnh, 3.321 xã.
 * Nguồn: thanglequoc/vietnamese-provinces-database (MIT), chép gọn vào `data/vn-admin-units.json` (CHK03, S-301).
 * Mã ở đây là mã quốc gia; mã của hãng vận chuyển nằm trong namespace riêng (vd `ghn:`), không suy diễn lẫn nhau.
 */
export interface Province {
  code: string;
  name: string;
}
export interface Ward {
  code: string;
  name: string;
  provinceCode: string;
}

interface Dataset {
  version: string;
  license: string;
  provinces: { code: string; name: string; wards: [string, string][] }[];
}

let cache: { dataset: Dataset; wardsByCode: Map<string, Ward> } | null = null;

function load() {
  if (cache) return cache;
  const dataset = JSON.parse(
    readFileSync(new URL("../../data/vn-admin-units.json", import.meta.url), "utf8"),
  ) as Dataset;
  const wardsByCode = new Map<string, Ward>();
  for (const p of dataset.provinces) {
    for (const [code, name] of p.wards) wardsByCode.set(code, { code, name, provinceCode: p.code });
  }
  cache = { dataset, wardsByCode };
  return cache;
}

export function addressDatasetVersion(): string {
  return load().dataset.version;
}

export function listProvinces(): Province[] {
  return load().dataset.provinces.map(({ code, name }) => ({ code, name }));
}

export function listWards(provinceCode: string): Ward[] {
  const p = load().dataset.provinces.find((x) => x.code === provinceCode);
  return p ? p.wards.map(([code, name]) => ({ code, name, provinceCode })) : [];
}

export interface AddressInput {
  provinceCode: string;
  wardCode: string;
  /** Số nhà, đường, tòa nhà… */
  line: string;
  /** Chuỗi gốc khách nhập (nếu dán cả địa chỉ), lưu để đối chiếu. */
  original?: string;
}

/** Bản chụp địa chỉ lưu kèm đơn — giữ tên tại thời điểm đặt để cập nhật danh mục không đổi lịch sử (DATA05). */
export interface AddressSnapshot {
  provinceCode: string;
  provinceName: string;
  wardCode: string;
  wardName: string;
  line: string;
  original: string | null;
  datasetVersion: string;
}

export type AddressError = "PROVINCE_NOT_FOUND" | "WARD_NOT_FOUND" | "WARD_PROVINCE_MISMATCH" | "VALIDATION";

export function validateAddress(input: AddressInput): Result<AddressSnapshot, AddressError> {
  const { dataset, wardsByCode } = load();
  const province = dataset.provinces.find((p) => p.code === input.provinceCode);
  if (!province) return err("PROVINCE_NOT_FOUND", CHECKOUT_MESSAGES.province, "province_code");
  const ward = wardsByCode.get(input.wardCode);
  if (!ward) return err("WARD_NOT_FOUND", CHECKOUT_MESSAGES.ward, "ward_code");
  if (ward.provinceCode !== province.code) {
    return err("WARD_PROVINCE_MISMATCH", "Phường/xã không thuộc tỉnh/thành đã chọn", "ward_code");
  }
  // Cùng quy tắc với `addressLineSchema` của form checkout (một nguồn: validation/).
  const line = normalizeText(input.line);
  if (charLength(line) < CHECKOUT_LIMITS.lineMin)
    return err("VALIDATION", CHECKOUT_MESSAGES.line, "address_line");
  if (charLength(line) > CHECKOUT_LIMITS.lineMax)
    return err("VALIDATION", CHECKOUT_MESSAGES.lineTooLong, "address_line");
  return ok({
    provinceCode: province.code,
    provinceName: province.name,
    wardCode: ward.code,
    wardName: ward.name,
    line,
    original: input.original === undefined ? null : toNfc(input.original).slice(0, 500),
    datasetVersion: dataset.version,
  });
}

/**
 * Gợi ý phường/xã theo tên (có/không dấu) trong một tỉnh — dùng khi ánh xạ địa chỉ cũ: trả ứng viên để KHÁCH xác nhận,
 * không tự chọn (CHK03).
 */
export function suggestWards(provinceCode: string, query: string, limit = 8): Ward[] {
  const q = searchKey(query).replace(/^(phuong|xa|dac khu|thi tran) /, "");
  if (q === "") return [];
  return listWards(provinceCode)
    .filter((w) => searchKey(w.name).includes(q))
    .slice(0, limit);
}

/**
 * Số di động Việt Nam 10 số (0xxxxxxxxx hoặc +84xxxxxxxxx) → dạng chuẩn 0xxxxxxxxx. Quy tắc nằm ở
 * `validation/phone.ts` (một nguồn với form checkout); hàm này chỉ bọc thành `Result`.
 */
export function normalizeVnPhone(raw: string): Result<string, "VALIDATION"> {
  const phone = normalizePhone(raw);
  return phone === null ? err("VALIDATION", "Số điện thoại không hợp lệ", "phone") : ok(phone);
}
