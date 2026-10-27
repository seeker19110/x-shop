import type { MedusaContainer } from "@medusajs/framework/types";
import { drainCatalogIndexForJob, markExpiredPrices } from "../lib/catalog/indexer";

/**
 * Mỗi phút: đánh dấu sản phẩm có giá khuyến mãi vừa hết hạn (read model theo price_valid_until — SPEC-catalog §3) và
 * xả mọi dấu còn sót (sự kiện mà lượt xả trước bỏ lỡ hoặc lỗi tạm thời) — giữ độ trễ index ≤ ~60 giây (§7.4). Khoá
 * đang bị giữ → không chờ trong khe job worker; giao lượt chờ nền (`drainCatalogIndexForJob`, D-081).
 */
export default async function catalogIndexDrainJob(container: MedusaContainer) {
  await markExpiredPrices(container);
  await drainCatalogIndexForJob(container);
}

export const config = {
  name: "x-catalog-index-drain",
  schedule: "* * * * *",
};
