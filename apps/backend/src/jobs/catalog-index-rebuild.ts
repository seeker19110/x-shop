import type { MedusaContainer } from "@medusajs/framework/types";
import { rebuildCatalogIndex } from "../lib/catalog/indexer";
import { isDraining } from "../lib/lifecycle/shutdown";

/**
 * Đường tái tạo read model (đặc tả §7.4): rebuild toàn phần định kỳ, bắt mọi thay đổi không phát sự kiện (link kho ↔
 * kênh, bảng màu/size, price list bắt đầu hiệu lực). Thay bảng trong một giao dịch nên người đọc không thấy nửa vời.
 * Đang tắt (T-094): không bắt đầu (rebuild ~50 s ở 50k SKU vượt trần tắt êm); lần chạy sau làm.
 */
export default async function catalogIndexRebuildJob(container: MedusaContainer) {
  if (isDraining()) return;
  await rebuildCatalogIndex(container);
}

export const config = {
  name: "x-catalog-index-rebuild",
  schedule: "*/30 * * * *",
};
