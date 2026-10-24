import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createPromotionsWorkflow,
  updateInventoryLevelsWorkflow,
  updateProductsWorkflow,
  updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows";
import { OPTION_COLOR, OPTION_SIZE } from "../../src/lib/catalog/constants";
import { createSizeChartWorkflow } from "../../src/workflows/fashion/size-chart";
import { setProductFashionWorkflow } from "../../src/workflows/fashion/set-product-fashion";
import { createTestProduct, TEST_CHART } from "./catalog";
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

/** Khoá fixture "Đen/M" → slug option của mô hình thời trang (T-013): màu `den|trang`, size `s|m`. */
const COLOR_SLUG: Record<string, string> = { Đen: "den", Trắng: "trang" };
const variantKey = (color: string, size: string) =>
  `${Object.keys(COLOR_SLUG).find((k) => COLOR_SLUG[k] === color)}/${size.toUpperCase()}`;

/**
 * Sản phẩm đi ĐÚNG đường xuất bản thật: tạo draft đủ dữ liệu (helper chung với test catalog-model) → gắn thuộc tính
 * thời trang + bảng size → chuyển `published` qua updateProductsWorkflow (hook kiểm trước xuất bản vẫn chạy).
 */
export async function seedCatalog(
  container: MedusaContainer,
  opts: { stock?: Partial<Record<string, number>>; title?: string } = {},
): Promise<CatalogFixture> {
  const seed = await seedXShop({ container });
  const apiKey = await container.resolve(Modules.API_KEY).retrieveApiKey(seed.publishableKeyId);
  const product = await createTestProduct(container, {
    title: opts.title ?? "Áo thun cổ tròn",
    salesChannelId: seed.salesChannelId,
    manageInventory: true,
    variants: Object.entries(PRICES).map(([key, price]) => {
      const [color, size] = key.split("/") as [string, string];
      return { color: COLOR_SLUG[color]!, size: size.toLowerCase(), price };
    }),
    images: [
      ["den", "Áo thun đen mặt trước"],
      ["den", "Áo thun đen mặt sau"],
      ["trang", "Áo thun trắng mặt trước"],
    ],
  });
  const { result: chart } = await createSizeChartWorkflow(container).run({
    input: { code: `ao-thun-${product.suffix}`, ...TEST_CHART },
  });
  await setProductFashionWorkflow(container).run({
    input: {
      product_id: product.id,
      attributes: { kind: "apparel", material: "cotton", material_label: "Cotton" },
      size_chart_id: chart.id,
    },
  });
  await updateProductsWorkflow(container).run({
    input: { selector: { id: product.id }, update: { status: "published" } },
  });

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "variant",
    fields: ["id", "options.value", "options.option.title", "inventory_items.inventory_item_id"],
    filters: { product_id: product.id },
  });
  const variants: CatalogFixture["variants"] = {};
  type Row = {
    id: string;
    options: Array<{ value: string; option?: { title?: string } | null }>;
    inventory_items: Array<{ inventory_item_id: string }>;
  };
  for (const v of data as Row[]) {
    const opt = (title: string) => v.options.find((o) => o.option?.title === title)?.value ?? "";
    const key = variantKey(opt(OPTION_COLOR), opt(OPTION_SIZE));
    variants[key] = {
      id: v.id,
      inventoryItemId: v.inventory_items[0]!.inventory_item_id,
      price: PRICES[key]!,
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
