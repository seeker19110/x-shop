/**
 * Dựng read model `catalog_variant_index` cho bộ dữ liệu tải, chạy bằng `medusa exec` (cần container Medusa):
 *   cd apps/backend && pnpm exec medusa exec ../../scripts/load/index-dataset.ts
 *
 * Dùng `syncCatalogProducts` (đường đồng bộ theo sự kiện của production: đọc nguồn và ghi theo lô 100 sản phẩm, mỗi lô
 * một giao dịch) thay cho `rebuildCatalogIndex`: ở quy mô 10.000 sản phẩm / 50.000 SKU `rebuildCatalogIndex` gom MỌI
 * sản phẩm vào MỘT lần `buildIndexRows` (một truy vấn giá/tồn cho 50.000 biến thể) và chỉ cho ra ~4.000 dòng — xem
 * docs/ops/perf/load-dataset.md §Phát hiện. Khi lỗi đó được sửa, đổi lại sang `rebuildCatalogIndex`.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import { syncCatalogProducts } from "../../apps/backend/src/lib/catalog/indexer";

export default async function indexDataset({ container }: Pick<ExecArgs, "container">) {
  const products = await container
    .resolve(Modules.PRODUCT)
    .listProducts({ status: "published" }, { select: ["id"], take: null });
  const started = Date.now();
  const rows = await syncCatalogProducts(
    container,
    products.map((p) => p.id),
  );
  console.log(
    `[load-index] ${products.length} sản phẩm → ${rows} dòng read model trong ${Date.now() - started} ms`,
  );
}
