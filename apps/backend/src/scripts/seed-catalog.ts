import type { ExecArgs, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  createInventoryLevelsWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows";
import { CURRENCY, OPTION_COLOR, OPTION_SIZE } from "../lib/catalog/constants";
import { withOwnedLock } from "../lib/checkout/locks";
import { rebuildCatalogIndex } from "../lib/catalog/indexer";
import { FASHION_MODULE } from "../modules/fashion";
import type FashionModuleService from "../modules/fashion/service";
import { setProductFashionWorkflow } from "../workflows/fashion/set-product-fashion";
import { createSizeChartWorkflow } from "../workflows/fashion/size-chart";
import {
  DEMO_CARE,
  DEMO_CATEGORIES,
  DEMO_COLORS,
  DEMO_MARK,
  DEMO_PRODUCTS,
  DEMO_SIZE_CHARTS,
  DEMO_SIZES,
  type DemoProduct,
} from "./catalog-demo-data";
import seedXShop, { type SeedResult } from "./seed";
import { isNonEmpty } from "@x-shop/domain";

/**
 * Seed DỮ LIỆU DEMO cho catalog (T-013) — idempotent: khoá tự nhiên là value (màu/size), handle (danh mục, sản
 * phẩm), code (bảng size); bản ghi đã có thì giữ nguyên. Chạy dưới khoá `x-shop:seed-catalog` của Locking Module.
 * Sản phẩm đi qua đúng đường admin dùng: tạo draft → đặt thuộc tính/bảng size → nhập tồn → publish (hook kiểm xuất bản).
 *
 * Chạy: `pnpm --filter @x-shop/backend seed:catalog` (= `medusa exec ./src/scripts/seed-catalog.ts`).
 */

export const CATALOG_SEED_LOCK = "x-shop:seed-catalog";

export interface CatalogSeedResult {
  base: SeedResult;
  products: Record<string, string>;
  created: number;
}

export default async function seedCatalog({
  container,
}: Pick<ExecArgs, "container">): Promise<CatalogSeedResult> {
  const base = await seedXShop({ container });
  const result = await withOwnedLock(
    container.resolve(Modules.LOCKING),
    CATALOG_SEED_LOCK,
    { waitMs: 300_000, ttlSeconds: 30, scope: "seed-catalog" },
    () => seedUnlocked(container, base),
  );
  // Read model đọc được ngay sau seed (không chờ hàng đợi sự kiện) — rebuild là idempotent.
  await rebuildCatalogIndex(container);
  container
    .resolve(ContainerRegistrationKeys.LOGGER)
    .info(
      `[seed-catalog] Xong: ${Object.keys(result.products).length} sản phẩm demo, tạo mới ${result.created}.`,
    );
  return result;
}

async function seedUnlocked(container: MedusaContainer, base: SeedResult): Promise<CatalogSeedResult> {
  const fashion: FashionModuleService = container.resolve(FASHION_MODULE);
  await ensureDictionary(fashion);
  const categoryIds = await ensureCategories(container);
  const chartIds = await ensureSizeCharts(container, fashion);
  const productService = container.resolve(Modules.PRODUCT);
  const products: Record<string, string> = {};
  let created = 0;
  for (const demo of DEMO_PRODUCTS) {
    const [existing] = await productService.listProducts({ handle: demo.handle }, { take: 1 });
    if (existing) {
      products[demo.handle] = existing.id;
      continue;
    }
    products[demo.handle] = await createDemoProduct(container, demo, {
      base,
      categoryId: categoryIds[demo.category] as string,
      sizeChartId: isNonEmpty(demo.sizeChart) ? (chartIds[demo.sizeChart] ?? null) : null,
    });
    created++;
  }
  return { base, products, created };
}

async function ensureDictionary(fashion: FashionModuleService): Promise<void> {
  const colors = await fashion.listFashionColors({}, { take: null });
  const haveColor = new Set(colors.map((c) => c.value));
  const newColors = DEMO_COLORS.map((c, i) => ({ ...c, rank: i + 1 })).filter((c) => !haveColor.has(c.value));
  if (newColors.length) await fashion.createFashionColors(newColors);
  const sizes = await fashion.listFashionSizes({}, { take: null });
  const haveSize = new Set(sizes.map((s) => s.value));
  const newSizes = DEMO_SIZES.map((s, i) => ({ ...s, rank: i + 1 })).filter((s) => !haveSize.has(s.value));
  if (newSizes.length) await fashion.createFashionSizes(newSizes);
}

async function ensureCategories(container: MedusaContainer): Promise<Record<string, string>> {
  const service = container.resolve(Modules.PRODUCT);
  const ids: Record<string, string> = {};
  // Cha trước con: DEMO_CATEGORIES đã sắp theo thứ tự đó.
  for (const c of DEMO_CATEGORIES) {
    const [existing] = await service.listProductCategories({ handle: c.handle }, { take: 1 });
    if (existing) {
      ids[c.handle] = existing.id;
      continue;
    }
    const { result } = await createProductCategoriesWorkflow(container).run({
      input: {
        product_categories: [
          {
            name: c.name,
            handle: c.handle,
            is_active: true,
            is_internal: false,
            ...(isNonEmpty(c.parent) ? { parent_category_id: ids[c.parent] as string } : {}),
            metadata: { demo: true, seed: DEMO_MARK },
          },
        ],
      },
    });
    ids[c.handle] = (result[0] as { id: string }).id;
  }
  return ids;
}

async function ensureSizeCharts(
  container: MedusaContainer,
  fashion: FashionModuleService,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const chart of DEMO_SIZE_CHARTS) {
    const [current] = await fashion.listSizeCharts(
      { code: chart.code },
      { order: { version: "DESC" }, take: 1 },
    );
    if (current) {
      ids[chart.code] = current.id;
      continue;
    }
    const { result } = await createSizeChartWorkflow(container).run({ input: chart });
    ids[chart.code] = result.id;
  }
  return ids;
}

const VIEWS = [
  ["front", "mặt trước"],
  ["back", "mặt sau"],
  ["detail", "chi tiết chất liệu"],
] as const;

function demoImages(demo: DemoProduct) {
  const colors = [...new Set(demo.variants.map((v) => v[0]))];
  const label = (c: string) => DEMO_COLORS.find((x) => x.value === c)?.label ?? c;
  // Hàng may mặc/giày: 3 góc chụp mỗi màu (PDP02); phụ kiện: 1 ảnh mỗi màu.
  const views = demo.kind === "accessory" ? VIEWS.slice(0, 1) : VIEWS;
  return colors.flatMap((c) =>
    views.map(([view, viewLabel]) => ({
      url: `/static/demo/${c}.svg?view=${view}`,
      metadata: {
        color: c,
        alt: `${demo.title} màu ${label(c).toLowerCase()} — ${viewLabel} (ảnh demo)`,
        width: 800,
        height: 1000,
        set: c,
        demo: true,
      },
    })),
  );
}

async function createDemoProduct(
  container: MedusaContainer,
  demo: DemoProduct,
  ctx: { base: SeedResult; categoryId: string; sizeChartId: string | null },
): Promise<string> {
  const colors = [...new Set(demo.variants.map((v) => v[0]))];
  const sizeOrder: string[] = DEMO_SIZES.map((s) => s.value);
  const sizes = [...new Set(demo.variants.map((v) => v[1]))].sort(
    (a, b) => sizeOrder.indexOf(a) - sizeOrder.indexOf(b),
  );
  const colorOrder: string[] = DEMO_COLORS.map((c) => c.value);
  const colorLabel = (c: string) => DEMO_COLORS.find((x) => x.value === c)?.label ?? c;
  const sizeLabel = (s: string) => DEMO_SIZES.find((x) => x.value === s)?.label ?? s;
  const images = demoImages(demo);
  const { result } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: demo.title,
          handle: demo.handle,
          description: demo.description,
          status: "draft",
          thumbnail: images[0]?.url ?? null,
          images,
          category_ids: [ctx.categoryId],
          sales_channels: [{ id: ctx.base.salesChannelId }],
          metadata: { demo: true, seed: DEMO_MARK },
          options: [
            {
              title: OPTION_COLOR,
              values: [...colors].sort((a, b) => colorOrder.indexOf(a) - colorOrder.indexOf(b)),
            },
            { title: OPTION_SIZE, values: sizes },
          ],
          variants: demo.variants.map(([color, size, price], i) => ({
            title: `${colorLabel(color)} / ${sizeLabel(size)}`,
            sku: `${demo.sku}-${color}-${size}`.toUpperCase(),
            manage_inventory: true,
            variant_rank: i,
            options: { [OPTION_COLOR]: color, [OPTION_SIZE]: size },
            prices: [{ amount: price, currency_code: CURRENCY }],
          })),
        },
      ],
    },
  });
  const productId = (result[0] as { id: string }).id;

  await setProductFashionWorkflow(container).run({
    input: {
      product_id: productId,
      attributes: {
        kind: demo.kind,
        material: demo.material[0],
        material_label: demo.material[1],
        composition: demo.composition,
        stretch: demo.stretch,
        fit: demo.fit,
        care:
          demo.material[0] === "da"
            ? "Lau bằng khăn mềm hơi ẩm, không ngâm nước, bảo quản nơi khô thoáng."
            : DEMO_CARE,
        origin: "Việt Nam",
      },
      size_chart_id: ctx.sizeChartId,
      model_measurements: demo.model
        ? [
            {
              image_set: colors[0] as string,
              color: colors[0] as string,
              ...demo.model,
              note: "Dữ liệu demo",
            },
          ]
        : [],
    },
  });

  await stockDemoVariants(container, productId, demo, ctx.base.sellableLocationId);

  await updateProductsWorkflow(container).run({
    input: { selector: { id: productId }, update: { status: "published" } },
  });
  return productId;
}

async function stockDemoVariants(
  container: MedusaContainer,
  productId: string,
  demo: DemoProduct,
  locationId: string,
): Promise<void> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "inventory_items.inventory_item_id"],
    filters: { product_id: productId },
  });
  const rows = data as unknown as {
    sku?: string | null;
    inventory_items?: ({ inventory_item_id: string } | null)[] | null;
  }[];
  const stockBySku = new Map(
    demo.variants.map(([c, s, , stock]) => [`${demo.sku}-${c}-${s}`.toUpperCase(), stock]),
  );
  const levels = rows.flatMap((r) => {
    const itemId = r.inventory_items?.[0]?.inventory_item_id;
    if (!isNonEmpty(itemId) || !isNonEmpty(r.sku)) return [];
    return [
      { inventory_item_id: itemId, location_id: locationId, stocked_quantity: stockBySku.get(r.sku) ?? 0 },
    ];
  });
  if (levels.length)
    await createInventoryLevelsWorkflow(container).run({ input: { inventory_levels: levels } });
}
