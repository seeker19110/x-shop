import type { ExecArgs } from "@medusajs/framework/types";
import { rebuildCatalogIndex } from "../lib/catalog/indexer";

/** Tái tạo read model catalog thủ công: `pnpm --filter @x-shop/backend catalog:reindex`. */
export default async function rebuildCatalogIndexScript({ container }: Pick<ExecArgs, "container">) {
  return rebuildCatalogIndex(container);
}
