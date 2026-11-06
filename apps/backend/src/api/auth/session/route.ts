import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { establishAdminSession, type SessionCarrier } from "../../../lib/admin-security/session-regenerate";

/**
 * Ghi đè `POST /auth/session` của Medusa 2.22.1 (D-059, T-133): tạo lại session ID trước khi gắn auth context
 * (chống session fixation, BE-AUTH-004). RoutesLoader ghi đè theo (matcher, method) → `DELETE /auth/session` native
 * (huỷ phiên + xoá cookie) và middleware native `authenticate("*", "bearer", { allowUnregistered, requireMfa: false })`
 * của route này giữ nguyên. Phản hồi giữ đúng native: 200 `{ user: auth_context }`.
 *
 * Đường lùi: xoá file này khi Medusa tự gọi `req.session.regenerate` trong route native.
 */
export const POST = async (req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> => {
  const user = await establishAdminSession(req as AuthenticatedMedusaRequest & SessionCarrier);
  res.status(200).json({ user });
};
