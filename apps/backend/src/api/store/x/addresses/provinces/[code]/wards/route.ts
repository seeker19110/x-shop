import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { listWards } from "@x-shop/domain";
import { PUBLIC_ADDRESS_CACHE } from "../../../../../../../lib/address/cache";
import { sendProblem } from "../../../../../../../lib/http/problem";

/** GET /store/x/addresses/provinces/:code/wards — phường/xã của một tỉnh/thành; mã không có → 404. */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const code = String(req.params.code ?? "");
  const wards = /^[0-9]{1,10}$/.test(code) ? listWards(code) : [];
  if (wards.length === 0) return sendProblem(res, 404, "NOT_FOUND", "Không tìm thấy tỉnh/thành phố");
  res.setHeader("Cache-Control", PUBLIC_ADDRESS_CACHE);
  res.json({ province_code: code, wards: wards.map(({ code: c, name }) => ({ code: c, name })) });
};
