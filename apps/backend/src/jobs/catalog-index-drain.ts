import type { MedusaContainer } from "@medusajs/framework/types";
import { drainCatalogIndexForJob, markExpiredPrices } from "../lib/catalog/indexer";
import { isDraining } from "../lib/lifecycle/shutdown";

/**
 * Mỗi phút: đánh dấu sản phẩm có giá khuyến mãi vừa hết hạn (read model theo price_valid_until — SPEC-catalog §3) và
 * xả mọi dấu còn sót (sự kiện mà lượt xả trước bỏ lỡ hoặc lỗi tạm thời) — giữ độ trễ index ≤ ~60 giây (§7.4). Khoá
 * đang bị giữ → không chờ trong khe job worker; giao lượt chờ nền (`drainCatalogIndexForJob`, D-081).
 *
 * Đang tắt (T-094): job worker vẫn nhận tick trong lúc readiness 503 (`drainDelayMs`), và Medusa chờ job đang chạy xong
 * trước khi đóng pool → không bắt đầu việc gì (kể cả câu đọc `markExpiredPrices`: đọc bị chặn thì cả tiến trình vượt
 * trần tắt). Dấu hết hạn/dấu bẩn còn trong DB cho tiến trình khác/lần chạy sau.
 */
export default async function catalogIndexDrainJob(container: MedusaContainer) {
  if (isDraining()) return;
  await markExpiredPrices(container);
  await drainCatalogIndexForJob(container);
}

export const config = {
  name: "x-catalog-index-drain",
  schedule: "* * * * *",
};
