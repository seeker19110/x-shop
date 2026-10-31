import type { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { listWards } from "@x-shop/domain";
import { PUBLIC_ADDRESS_CACHE } from "../../../../../../../lib/address/cache";
import { sendProblem } from "../../../../../../../lib/http/problem";
import { z } from "zod";
import { readParams } from "../../../../../../../lib/http/request-input";

/** GET /store/x/addresses/provinces/:code/wards — phường/xã của một tỉnh/thành; mã không có → 404. */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const params = readParams(req, z.object({ code: z.string().regex(/^[0-9]{1,10}$/) }));
  const code = params.ok ? params.data.code : "";
  const wards = params.ok ? listWards(code) : [];
  if (wards.length === 0) return sendProblem(res, 404, "NOT_FOUND", "Không tìm thấy tỉnh/thành phố");
  res.setHeader("Cache-Control", PUBLIC_ADDRESS_CACHE);
  res.json({ province_code: code, wards: wards.map(({ code: c, name }) => ({ code: c, name })) });
};
