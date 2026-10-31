"use server";

import { redirect } from "next/navigation";
import { cancelOrder, lookupOrder, recheckOrder, redeemLink } from "./service";
import type { LookupState, OrderResult } from "./types";
import { isNonEmpty } from "../presence";

/**
 * Server Actions của trang đơn/tra cứu — mỏng, logic ở `service.ts`. Token phiên đơn chỉ nằm trong cookie HttpOnly;
 * client chỉ gửi mã đơn (đã kiểm hình dạng ở server).
 */

export async function recheckOrderAction(ref: string): Promise<OrderResult> {
  return recheckOrder(String(ref ?? ""));
}

export async function cancelOrderAction(ref: string): Promise<OrderResult & { refundRequested?: boolean }> {
  return cancelOrder(String(ref ?? ""));
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

export async function lookupOrderAction(_prev: LookupState, form: FormData): Promise<LookupState> {
  const ref = field(form, "ma").toUpperCase();
  const phone = field(form, "sdt");
  if (ref === "") return { status: "invalid", field: "ref", message: "Vui lòng nhập mã đơn hàng" };
  if (phone === "") return { status: "invalid", field: "phone", message: "Vui lòng nhập số điện thoại" };
  return lookupOrder(ref, phone);
}

/**
 * Đổi liên kết tra cứu thành cookie phiên đơn rồi chuyển tới URL KHÔNG chứa token. Chạy khi khách bấm nút (POST) —
 * trình quét liên kết của email/SMS chỉ GET trang nên không "tiêu" mất liên kết một lần.
 */
export async function redeemLinkAction(form: FormData): Promise<void> {
  const ref = await redeemLink(field(form, "token"));
  redirect(isNonEmpty(ref) ? `/don-hang/${encodeURIComponent(ref)}` : "/tra-cuu-don?loi=lien-ket");
}
