import { revalidateTag } from "next/cache";
import { handleRevalidate, NonceStore, REVALIDATE_PROFILE } from "../../../lib/catalog/revalidate";
import { getServerEnv } from "../../../lib/env";

export const dynamic = "force-dynamic";

/** Nonce đã dùng của tiến trình này (chống phát lại trong cửa sổ lệch giờ). */
const nonces = new NonceStore();

/**
 * Webhook vô hiệu hoá cache catalog từ backend (T-142, D-070): chữ ký HMAC + chống phát lại, rồi `revalidateTag` các tag
 * sản phẩm/danh sách với hết hạn ngay. Mã trả về: lib/catalog/revalidate.ts `handleRevalidate`.
 */
export async function POST(req: Request): Promise<Response> {
  return handleRevalidate(req, {
    secret: getServerEnv().CATALOG_REVALIDATE_SECRET,
    nonces,
    revalidate: (tag) => revalidateTag(tag, REVALIDATE_PROFILE),
  });
}
