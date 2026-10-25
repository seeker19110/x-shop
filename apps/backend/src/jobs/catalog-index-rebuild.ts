import type { MedusaContainer } from "@medusajs/framework/types";
import { rebuildCatalogIndex } from "../lib/catalog/indexer";

/**
 * Đường tái tạo read model (đặc tả §7.4): rebuild toàn phần định kỳ, bắt mọi thay đổi không phát sự kiện (link kho ↔
 * kênh, bảng màu/size, price list bắt đầu hiệu lực). Thay bảng trong một giao dịch nên người đọc không thấy nửa vời.
 */
export default async function catalogIndexRebuildJob(container: MedusaContainer) {
  await rebuildCatalogIndex(container);
}

export const config = {
  name: "x-catalog-index-rebuild",
  schedule: "*/30 * * * *",
};
