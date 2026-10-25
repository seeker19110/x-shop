import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CATALOG_INDEX_EVENTS, targetsForEvent } from "../lib/catalog/index-triggers";
import { markCatalogDirty, REBUILD_MARK, scheduleCatalogDrain } from "../lib/catalog/indexer";

/**
 * Đồng bộ read model `catalog_variant_index` theo sự kiện (nhất quán cuối cùng, đặc tả §7.4: mục tiêu ≤ 60 giây):
 * đánh dấu sản phẩm bẩn (một câu INSERT) rồi hẹn một lượt xả gom lô. Lỗi được ghi log; dấu còn lại được job mỗi phút
 * xả tiếp — index chỉ là bản đọc, checkout luôn đọc nguồn có thẩm quyền.
 */
export default async function catalogIndexSync({
  event,
  container,
}: SubscriberArgs<Record<string, unknown>>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  try {
    const target = await targetsForEvent(container, event.name, event.data);
    await markCatalogDirty(container, target.rebuild ? [REBUILD_MARK] : target.productIds);
    scheduleCatalogDrain(container);
  } catch (e) {
    logger.error(`[catalog-index] Đồng bộ lỗi sau sự kiện ${event.name}: ${(e as Error).message}`);
  }
}

export const config: SubscriberConfig = {
  event: [...CATALOG_INDEX_EVENTS],
  context: { subscriberId: "x-catalog-index-sync" },
};
