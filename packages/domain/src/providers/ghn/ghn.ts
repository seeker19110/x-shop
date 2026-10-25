/**
 * Protocol GHN (Giao Hàng Nhanh) — báo phí, tạo/hủy/tra vận đơn, callback. NGUỒN: developer.ghn.vn trả 403 khi
 * xác minh 2026-10-24; cài theo nguồn thứ cấp (docs/research/2026-10-24-stack.md mục 7) — CHƯA XÁC MINH tên trường
 * chính xác, URL sandbox và cơ chế xác thực callback. Bắt buộc đối chiếu khi có token sandbox (RK-006).
 * Địa chỉ dùng hệ mới 2 cấp: `is_new_to_address: true`, gửi tên tỉnh/phường khớp master data, để trống quận/huyện.
 */
import { assertNonNegativeVnd } from "../../money/money.js";
import type { ShipmentState } from "../../state/machine.js";
import type { AddressSnapshot } from "../../address/address.js";

export interface GhnConfig {
  baseUrl: string;
  token: string;
  shopId: string;
}

export interface GhnItem {
  name: string;
  code: string;
  quantity: number;
  price: number;
  weightGrams: number;
}

export interface CreateShipmentInput {
  /** Reference của shop, ổn định theo shipment — tra lại khi timeout trước khi gửi lần nữa (S-303). */
  clientOrderCode: string;
  to: { name: string; phone: string; address: AddressSnapshot };
  /** Số thu tại cửa đã tính từ ledger (codAmount) — đơn đã trả đủ online phải là 0 (AT13). */
  codAmount: number;
  insuranceValue: number;
  weightGrams: number;
  items: GhnItem[];
  /** 1 = shop trả phí ship (phí đã thu trong checkout), 2 = người nhận trả. */
  paymentTypeId: 1 | 2;
  /** CHOTHUHANG | CHOXEMHANGKHONGTHU | KHONGCHOXEMHANG */
  requiredNote: "CHOTHUHANG" | "CHOXEMHANGKHONGTHU" | "KHONGCHOXEMHANG";
  note?: string;
}

export function buildCreateOrderBody(input: CreateShipmentInput): Record<string, unknown> {
  assertNonNegativeVnd(input.codAmount, "codAmount");
  assertNonNegativeVnd(input.insuranceValue, "insuranceValue");
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(input.clientOrderCode)) throw new Error("clientOrderCode không hợp lệ");
  if (!Number.isSafeInteger(input.weightGrams) || input.weightGrams <= 0)
    throw new Error("weightGrams không hợp lệ");
  if (input.items.length === 0) throw new Error("Vận đơn cần ít nhất một món");
  return {
    payment_type_id: input.paymentTypeId,
    required_note: input.requiredNote,
    note: input.note ?? "",
    client_order_code: input.clientOrderCode,
    to_name: input.to.name,
    to_phone: input.to.phone,
    to_address: `${input.to.address.line}, ${input.to.address.wardName}, ${input.to.address.provinceName}`,
    to_ward_name: input.to.address.wardName,
    to_province_name: input.to.address.provinceName,
    is_new_to_address: true,
    cod_amount: input.codAmount,
    insurance_value: input.insuranceValue,
    weight: input.weightGrams,
    service_type_id: 2,
    items: input.items.map((i) => ({
      name: i.name,
      code: i.code,
      quantity: i.quantity,
      price: i.price,
      weight: i.weightGrams,
    })),
  };
}

export interface FeeInput {
  to: AddressSnapshot;
  weightGrams: number;
  insuranceValue: number;
}

export function buildFeeBody(input: FeeInput): Record<string, unknown> {
  return {
    service_type_id: 2,
    to_ward_name: input.to.wardName,
    to_province_name: input.to.provinceName,
    is_new_to_address: true,
    weight: input.weightGrams,
    insurance_value: input.insuranceValue,
  };
}

/** Trạng thái GHN → trạng thái shipment của dự án. Trạng thái lạ → null (ghi sự kiện thô, xử lý tay). */
const STATUS_MAP: Record<string, ShipmentState> = {
  ready_to_pick: "packed",
  picking: "packed",
  money_collect_picking: "packed",
  picked: "shipped",
  storing: "shipped",
  transporting: "shipped",
  sorting: "shipped",
  delivering: "shipped",
  money_collect_delivering: "shipped",
  delivered: "delivered",
  delivery_fail: "failed",
  waiting_to_return: "failed",
  return: "returning",
  return_transporting: "returning",
  return_sorting: "returning",
  returning: "returning",
  return_fail: "returning",
  returned: "returned",
};

export function mapGhnStatus(status: string): ShipmentState | null {
  return STATUS_MAP[status] ?? null;
}

/**
 * `cancel` = vận đơn bị hủy TRƯỚC khi hãng lấy hàng (hàng chưa rời shop). Máy vận đơn không có trạng thái "hủy" (đặc tả
 * §6.1) nên KHÔNG nằm trong `mapGhnStatus`: caller đưa vận đơn chưa lấy về `unfulfilled` qua các cạnh lùi hợp lệ
 * (packed → picking → unfulfilled) và hủy đơn; vận đơn đã lấy/đã giao → bỏ qua (không lùi).
 */
export const GHN_CANCELLED_STATUSES: readonly string[] = ["cancel"];

export function isGhnCancelled(status: string): boolean {
  return GHN_CANCELLED_STATUSES.includes(status);
}

export interface GhnCallback {
  orderCode: string;
  clientOrderCode: string | null;
  type: string;
  status: string;
  time: string;
  codAmount: number | null;
  /** Khóa chống lặp: OrderCode + Type + Time (+ Status). */
  eventKey: string;
}

/**
 * Đọc callback GHN. KHÔNG tin để đổi trạng thái có hệ quả tài chính: callback không có chữ ký đáng tin
 * (chưa xác minh) → caller tra lại vận đơn bằng API có token trước khi áp (S-305).
 */
export function parseCallback(body: unknown): GhnCallback | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : null);
  const orderCode = str("OrderCode");
  const type = str("Type");
  const time = str("Time");
  if (!orderCode || !type || !time || orderCode.length > 64) return null;
  const status = str("Status") ?? "";
  const cod = typeof b.CODAmount === "number" && Number.isSafeInteger(b.CODAmount) ? b.CODAmount : null;
  return {
    orderCode,
    clientOrderCode: str("ClientOrderCode"),
    type: type.toLowerCase(),
    status,
    time,
    codAmount: cod,
    eventKey: `${orderCode}|${type.toLowerCase()}|${status}|${time}`,
  };
}
