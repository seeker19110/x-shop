import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createPromotionsWorkflow,
  updateInventoryLevelsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows";
import seedXShop, { type SeedResult } from "../../src/scripts/seed";

/**
 * Dữ liệu test checkout: seed nền (store VND, region VN, kênh bán, kho chính, publishable key) + một sản phẩm thời
 * trang có biến thể Màu × Size, inventory item + level ở kho chính, giá VND nguyên đồng.
 */
export interface CatalogFixture extends SeedResult {
  publishableKey: string;
  productId: string;
  /** "Đen/M" → variant */
  variants: Record<string, { id: string; inventoryItemId: string; price: number }>;
}

export const PRICES: Record<string, number> = {
  "Đen/S": 700_000,
  "Đen/M": 700_000,
  "Trắng/S": 300_000,
  "Trắng/M": 300_000,
};

/** Địa chỉ hợp lệ theo danh mục 2 cấp: Thành phố Hà Nội / Phường Ba Đình. */
export const HANOI_ADDRESS = { province_code: "01", ward_code: "00004", line: "12 Phố Điện Biên Phủ" };

export async function seedCatalog(
  container: MedusaContainer,
  opts: { stock?: Partial<Record<string, number>>; title?: string } = {},
): Promise<CatalogFixture> {
  const seed = await seedXShop({ container });
  const apiKey = await container.resolve(Modules.API_KEY).retrieveApiKey(seed.publishableKeyId);
  const title = opts.title ?? "Áo thun cổ tròn";
  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title,
          handle: `ao-thun-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          status: "published",
          options: [
            { title: "Màu", values: ["Đen", "Trắng"] },
            { title: "Size", values: ["S", "M"] },
          ],
          sales_channels: [{ id: seed.salesChannelId }],
          variants: Object.entries(PRICES).map(([key, amount]) => {
            const [color, size] = key.split("/") as [string, string];
            return {
              title: key,
              sku: `AT-${color === "Đen" ? "DEN" : "TRANG"}-${size}-${Math.floor(Math.random() * 1e9)}`,
              options: { Màu: color, Size: size },
              manage_inventory: true,
              allow_backorder: false,
              prices: [{ amount, currency_code: "vnd" }],
            };
          }),
        },
      ],
    },
  });
  const product = result[0]!;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "variant",
    fields: ["id", "title", "inventory_items.inventory_item_id"],
    filters: { product_id: product.id },
  });
  const variants: CatalogFixture["variants"] = {};
  for (const v of data as Array<{
    id: string;
    title: string;
    inventory_items: Array<{ inventory_item_id: string }>;
  }>) {
    variants[v.title] = {
      id: v.id,
      inventoryItemId: v.inventory_items[0]!.inventory_item_id,
      price: PRICES[v.title]!,
    };
  }
  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: Object.entries(variants).map(([key, v]) => ({
        inventory_item_id: v.inventoryItemId,
        location_id: seed.sellableLocationId,
        stocked_quantity: opts.stock?.[key] ?? 10,
      })),
    },
  });
  return { ...seed, publishableKey: apiKey.token, productId: product.id, variants };
}

export async function setStock(container: MedusaContainer, fx: CatalogFixture, key: string, stocked: number) {
  await updateInventoryLevelsWorkflow(container).run({
    input: {
      updates: [
        {
          inventory_item_id: fx.variants[key]!.inventoryItemId,
          location_id: fx.sellableLocationId,
          stocked_quantity: stocked,
        },
      ],
    },
  });
}

export async function setPrice(container: MedusaContainer, variantId: string, amount: number) {
  await updateProductVariantsWorkflow(container).run({
    input: { selector: { id: variantId }, update: { prices: [{ amount, currency_code: "vnd" }] } },
  });
}

export async function createPromotion(
  container: MedusaContainer,
  code: string,
  opts: { limit: number | null; percent: number },
) {
  await createPromotionsWorkflow(container).run({
    input: {
      promotionsData: [
        {
          code,
          type: "standard",
          status: "active",
          is_automatic: false,
          ...(opts.limit !== null && { limit: opts.limit }),
          application_method: {
            type: "percentage",
            target_type: "order",
            allocation: "across",
            value: opts.percent,
            currency_code: "vnd",
          },
        },
      ],
    },
  });
}

export async function inventoryLevel(container: MedusaContainer, fx: CatalogFixture, key: string) {
  const [level] = await container.resolve(Modules.INVENTORY).listInventoryLevels({
    inventory_item_id: fx.variants[key]!.inventoryItemId,
    location_id: fx.sellableLocationId,
  });
  return { stocked: Number(level!.stocked_quantity), reserved: Number(level!.reserved_quantity) };
}

export async function countOrders(container: MedusaContainer): Promise<number> {
  const [, count] = await container.resolve(Modules.ORDER).listAndCountOrders({}, { take: 1 });
  return count;
}

export async function reservationsOf(container: MedusaContainer, fx: CatalogFixture, key: string) {
  return container
    .resolve(Modules.INVENTORY)
    .listReservationItems({ inventory_item_id: fx.variants[key]!.inventoryItemId });
}
