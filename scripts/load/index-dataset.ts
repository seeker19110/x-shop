/**
 * Dựng read model `catalog_variant_index` cho bộ dữ liệu tải, chạy bằng `medusa exec` (cần container Medusa):
 *   cd apps/backend && pnpm exec medusa exec ../../scripts/load/index-dataset.ts
 *
 * Dùng `rebuildCatalogIndex` (đường production): đọc nguồn và giá theo lô, thay cả bảng trong một giao dịch cuối. Lỗi
 * cũ "chỉ ~4.000 dòng ở 50.000 SKU" đã sửa ở T-057; từ T-059 rebuild còn từ chối thay bảng khi có SKU có giá niêm yết
 * mà không ra giá bán (`missing > 0`) — script này thoát lỗi (exit khác 0) trong trường hợp đó để bộ dữ liệu tải không
 * bao giờ dùng read model thiếu dòng. Xem docs/ops/perf/load-dataset.md §Phát hiện.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { rebuildCatalogIndex } from "../../apps/backend/src/lib/catalog/indexer";

export default async function indexDataset({ container }: Pick<ExecArgs, "container">) {
  const started = Date.now();
  const r = await rebuildCatalogIndex(container);
  console.log(
    `[load-index] ${r.products} sản phẩm → ${r.rows} dòng read model (kỳ vọng ${r.expected}, thiếu giá bán ${r.missing}, ` +
      `không giá ${r.unpriced}) trong ${Date.now() - started} ms`,
  );
  if (r.missing > 0 || r.rows !== r.expected) {
    throw new Error(
      `read model không khớp: ${r.rows}/${r.expected} dòng, ${r.missing} SKU thiếu giá bán — bảng cũ được giữ`,
    );
  }
}
