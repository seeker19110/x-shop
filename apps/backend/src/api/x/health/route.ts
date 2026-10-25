import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

/**
 * GET /x/health — kiểm sống tối giản của x-shop (ngoài `/health` native của Medusa). Công khai, không chạm DB,
 * không lộ phiên bản/cấu hình.
 */
export const GET = (_req: MedusaRequest, res: MedusaResponse): void => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "ok" });
};
