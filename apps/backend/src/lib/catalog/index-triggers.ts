import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { CATALOG_INDEX_MODULE } from "../../modules/catalog-index";
import type CatalogIndexModuleService from "../../modules/catalog-index/service";
import { CATALOG_PRODUCTS_CHANGED } from "./constants";
import { isNonEmpty } from "@x-shop/domain";

/** Sự kiện làm read model đổi (workflow native + sự kiện nội bộ của catalog). */
export const CATALOG_INDEX_EVENTS = [
  "product.created",
  "product.updated",
  "product.deleted",
  "product-variant.created",
  "product-variant.updated",
  "product-variant.deleted",
  "product-category.updated",
  "product-category.deleted",
  "inventory-item.created",
  "inventory-item.updated",
  "inventory-item.deleted",
  "inventory-level.created",
  "inventory-level.updated",
  "inventory-level.deleted",
  "reservation-item.created",
  "reservation-item.updated",
  "reservation-item.deleted",
  "price-list.created",
  "price-list.updated",
  "price-list.deleted",
  "price-list.prices_added",
  "price-list.prices_updated",
  "price-list.prices_removed",
  CATALOG_PRODUCTS_CHANGED,
] as const;

export type IndexTarget = { rebuild: true } | { rebuild: false; productIds: string[] };

type Data = Record<string, unknown> | undefined;

const ids = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x !== "");

async function productsOfVariants(container: MedusaContainer, variantIds: string[]): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "product_id"],
    filters: { id: variantIds },
  });
  const fromSource = (data as unknown as { product_id?: string | null }[]).flatMap((v) =>
    isNonEmpty(v.product_id) ? [v.product_id] : [],
  );
  // Biến thể đã xoá không còn trong nguồn → lấy product từ chính read model.
  const index: CatalogIndexModuleService = container.resolve(CATALOG_INDEX_MODULE);
  const fromIndex = await index.productIdsForVariants(variantIds);
  return [...new Set([...fromSource, ...fromIndex])];
}

async function variantsOfInventoryItems(container: MedusaContainer, itemIds: string[]): Promise<string[]> {
  if (itemIds.length === 0) return [];
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product_variant_inventory_items",
    fields: ["variant_id"],
    filters: { inventory_item_id: itemIds },
  });
  return (data as unknown as { variant_id?: string | null }[]).flatMap((l) =>
    isNonEmpty(l.variant_id) ? [l.variant_id] : [],
  );
}

async function variantsOfPriceSets(container: MedusaContainer, priceSetIds: string[]): Promise<string[]> {
  if (priceSetIds.length === 0) return [];
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product_variant_price_set",
    fields: ["variant_id"],
    filters: { price_set_id: priceSetIds },
  });
  return (data as unknown as { variant_id?: string | null }[]).flatMap((l) =>
    isNonEmpty(l.variant_id) ? [l.variant_id] : [],
  );
}

/**
 * Ánh xạ sự kiện → sản phẩm cần đồng bộ. Sự kiện mà không truy được phạm vi an toàn (xoá danh mục, đổi/xoá cả price
 * list) → rebuild toàn phần: chậm hơn nhưng không bỏ sót.
 */
export async function targetsForEvent(
  container: MedusaContainer,
  name: string,
  data: Data,
): Promise<IndexTarget> {
  const d = data ?? {};
  if (name === CATALOG_PRODUCTS_CHANGED) return { rebuild: false, productIds: ids(d.product_ids) };
  if (name.startsWith("product.")) return { rebuild: false, productIds: ids(d.id) };
  if (name.startsWith("product-variant.")) {
    return { rebuild: false, productIds: await productsOfVariants(container, ids(d.id)) };
  }
  if (name === "product-category.updated") {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data: cats } = await query.graph({
      entity: "product_category",
      fields: ["id", "products.id", "category_children.products.id"],
      filters: { id: ids(d.id) },
    });
    const productIds = (
      cats as { products?: { id: string }[]; category_children?: { products?: { id: string }[] }[] }[]
    ).flatMap((c) => [
      ...(c.products ?? []).map((p) => p.id),
      ...(c.category_children ?? []).flatMap((cc) => (cc.products ?? []).map((p) => p.id)),
    ]);
    return { rebuild: false, productIds };
  }
  if (name.startsWith("inventory-item.")) {
    return {
      rebuild: false,
      productIds: await productsOfVariants(container, await variantsOfInventoryItems(container, ids(d.id))),
    };
  }
  if (name.startsWith("inventory-level.") || name.startsWith("reservation-item.")) {
    const inventory = container.resolve(Modules.INVENTORY);
    const recs = name.startsWith("inventory-level.")
      ? await inventory.listInventoryLevels(
          { id: ids(d.id) },
          { withDeleted: true, select: ["inventory_item_id"] },
        )
      : await inventory.listReservationItems(
          { id: ids(d.id) },
          { withDeleted: true, select: ["inventory_item_id"] },
        );
    const itemIds = [...new Set(recs.map((r) => r.inventory_item_id))];
    return {
      rebuild: false,
      productIds: await productsOfVariants(container, await variantsOfInventoryItems(container, itemIds)),
    };
  }
  if (name.startsWith("price-list.prices_")) {
    const priceSetIds = ids(d.price_set_ids);
    if (priceSetIds.length === 0) return { rebuild: true };
    return {
      rebuild: false,
      productIds: await productsOfVariants(container, await variantsOfPriceSets(container, priceSetIds)),
    };
  }
  return { rebuild: true };
}
