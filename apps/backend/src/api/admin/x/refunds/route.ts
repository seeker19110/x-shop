import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { sendProblem } from "../../../../lib/http/problem";

/**
 * POST /admin/x/refunds — CHỖ GIỮ cho hoàn tiền (T-027 làm thật: theo dòng, giá thực trả, người duyệt thứ hai khi vượt
 * ngưỡng + xác thực lại qua `rejectWithoutRecentMfa`). Quyền `refund.execute` + MFA đã khai ở permissions.ts nên AT21
 * (kho gọi thẳng API hoàn tiền → 403) kiểm được ngay bây giờ.
 */
export const POST = async (_req: MedusaRequest, res: MedusaResponse) => {
  sendProblem(res, 501, "NOT_IMPLEMENTED", "Hoàn tiền chưa được triển khai (T-027)");
};
