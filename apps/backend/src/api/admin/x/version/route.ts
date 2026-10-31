import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { buildInfo } from "../../../../lib/ops/version";

/**
 * GET /admin/x/version — phiên bản build đang chạy `{ version, commit?, built_at? }` (D-050, WF-REL-007). CÓ xác thực admin +
 * RBAC (quyền `report.read`, permissions.ts): `/x/health` công khai cố ý không lộ phiên bản cho kẻ dò lỗ hổng theo phiên bản.
 * `scripts/load/smoke.mjs --expect-version` gọi route này sau deploy.
 */
export const GET = (_req: MedusaRequest, res: MedusaResponse): void => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(buildInfo());
};
