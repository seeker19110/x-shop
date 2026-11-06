import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { sendProblem } from "../http/problem";
import { IdParams, readParams } from "../http/request-input";

/**
 * Chặn đổi kho của reservation qua route native `POST /admin/reservations/:id` (T-224, hậu kiểm T-185).
 *
 * Lỗi gốc Medusa 2.22.1 (`@medusajs/inventory` dist/services/inventory-module.js, `updateReservationItems_`): khi
 * `location_id` đổi, bảng điều chỉnh ghi −q cho kho cũ và +q cho kho mới trong CÙNG map theo inventory item, nhưng chỉ
 * các dòng level của cặp (item, kho MỚI) được cập nhật — kho cũ giữ nguyên `reserved_quantity` trong khi reservation đã
 * rời đi → `reserved ≠ Σ reservation` ở kho cũ, hàng rào DB (vế `drift`, migration Migration20261028150000) luôn từ chối
 * lúc commit. Thử lại vô ích; trả 400 rõ ràng TRƯỚC khi tới Medusa thay vì 409/500 khó hiểu. Muốn chuyển kho: xoá
 * reservation rồi tạo lại ở kho mới.
 *
 * Gắn SAU cổng RBAC (`adminSecurityGuard` toàn cục chạy trước middleware theo method): người không có quyền ghi vẫn nhận
 * 401/403 như cũ, không dò được reservation tồn tại hay không. Reservation không tồn tại → để route gốc trả 404.
 */
export const RESERVATION_LOCATION_CHANGE = {
  status: 400,
  code: "RESERVATION_LOCATION_CHANGE_UNSUPPORTED",
  title: "Không đổi được kho của reservation — hãy xoá reservation rồi tạo lại ở kho mới",
} as const;

/**
 * Thuần: thân yêu cầu có đổi kho so với kho hiện tại không. Không gửi `location_id` → không đổi; gửi giá trị khác (kể cả
 * `null`/không phải chuỗi — fail-closed, không để Medusa diễn giải) → đổi.
 */
export function changesReservationLocation(currentLocationId: string, body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("location_id" in body)) return false;
  const next = (body as { location_id?: unknown }).location_id;
  return next !== undefined && next !== currentLocationId;
}

export async function reservationLocationGuard(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const body: unknown = req.body;
  // Id sai dạng: để route native của Medusa tự trả lỗi gốc (không đổi hành vi).
  const params = readParams(req, IdParams);
  if (!params.ok) return next();
  const id = params.data.id;
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { location_id?: unknown }).location_id === undefined
  ) {
    return next();
  }
  const [current] = await req.scope
    .resolve(Modules.INVENTORY)
    .listReservationItems({ id }, { select: ["id", "location_id"] });
  if (!current || !changesReservationLocation(current.location_id, body)) return next();
  return sendProblem(
    res,
    RESERVATION_LOCATION_CHANGE.status,
    RESERVATION_LOCATION_CHANGE.code,
    RESERVATION_LOCATION_CHANGE.title,
    [{ param: "location_id", reason: "location_change_unsupported" }],
    { detail: { reservation_id: id, location_id: current.location_id } },
  );
}
