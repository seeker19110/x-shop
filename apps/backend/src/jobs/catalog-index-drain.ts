import type { MedusaContainer } from "@medusajs/framework/types";
import { DRAIN_JOB_WAIT_MS, drainCatalogIndex, markExpiredPrices } from "../lib/catalog/indexer";

/**
 * Mỗi phút: đánh dấu sản phẩm có giá khuyến mãi vừa hết hạn (read model theo price_valid_until — SPEC-catalog §3) và
 * xả mọi dấu còn sót (sự kiện mà lượt xả trước bỏ lỡ hoặc lỗi tạm thời) — giữ độ trễ index ≤ ~60 giây (§7.4). Khoá
 * đang bị giữ (rebuild/sync/lượt xả khác) → chờ khoá trong lượt này (≤ DRAIN_JOB_WAIT_MS) thay vì bỏ lượt tới phút sau.
 */
export default async function catalogIndexDrainJob(container: MedusaContainer) {
  await markExpiredPrices(container);
  await drainCatalogIndex(container, { waitMs: DRAIN_JOB_WAIT_MS });
}

export const config = {
  name: "x-catalog-index-drain",
  schedule: "* * * * *",
};
