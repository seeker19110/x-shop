import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { listProvinces } from "@x-shop/domain";
import { PUBLIC_ADDRESS_CACHE } from "../../../../../lib/address/cache";

/** GET /store/x/addresses/provinces — danh mục tỉnh/thành 2 cấp (CHK03). Dữ liệu tĩnh theo bản phát hành → cache dài. */
export const GET = async (_req: MedusaStoreRequest, res: MedusaResponse) => {
  res.setHeader("Cache-Control", PUBLIC_ADDRESS_CACHE);
  res.json({ provinces: listProvinces() });
};
