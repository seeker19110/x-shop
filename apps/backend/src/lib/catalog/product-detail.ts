import type { MedusaContainer } from "@medusajs/framework/types";
import { colorOf, loadDictionary, sizeOf } from "./dictionary";
import { loadProductSources } from "./product-source";
import { loadInStock, loadVariantPrices, resolvePricingContext } from "./sell-state";

/**
 * Hợp đồng PDP (storefront T-018 dựng theo đúng shape này — giữ tên trường). Giá/tồn tính trực tiếp từ nguồn có
 * thẩm quyền lúc đọc (không qua read model), cùng hàm với read model nên hai nơi không lệch cách tính.
 */
export interface ProductDetail {
  product_id: string;
  handle: string;
  title: string;
  description: string | null;
  kind: "apparel" | "shoes" | "accessory" | null;
  attributes: {
    material: string | null;
    composition: string | null;
    stretch: string | null;
    fit: string | null;
    care: string | null;
    origin: string | null;
  };
  category: { handle: string; name: string } | null;
  options: {
    colors: { value: string; label: string; hex: string | null }[];
    sizes: { value: string; label: string }[];
  };
  variants: {
    variant_id: string;
    sku: string;
    color: string | null;
    size: string | null;
    price: number;
    compare_at: number | null;
    in_stock: boolean;
  }[];
  images: {
    url: string;
    alt: string | null;
    color: string | null;
    width: number | null;
    height: number | null;
  }[];
  size_chart: {
    code: string;
    name: string;
    version: number;
    unit: string;
    columns: unknown;
    rows: unknown;
  } | null;
  model_measurements: {
    image_set: string;
    color: string | null;
    height_cm: number;
    chest_cm: number | null;
    waist_cm: number | null;
    hip_cm: number | null;
    size_worn: string;
    note: string | null;
  }[];
  updated_at: string;
}

/**
 * Chi tiết sản phẩm công khai theo handle — chỉ sản phẩm `published` thuộc một kênh của publishable key; còn lại null
 * (route trả 404, không lộ sự tồn tại của bản nháp). SKU không có giá bán VND không được trả (không bán được).
 */
export async function loadProductDetail(
  container: MedusaContainer,
  handle: string,
  channelIds: string[],
): Promise<ProductDetail | null> {
  const [p] = await loadProductSources(container, { handle });
  if (!p || p.status !== "published") return null;
  const channelId = p.salesChannelIds.find((id) => channelIds.includes(id));
  if (!channelId) return null;
  const [dict, pricing] = await Promise.all([loadDictionary(container), resolvePricingContext(container)]);
  const [prices, stock] = await Promise.all([
    loadVariantPrices(
      container,
      p.variants.map((v) => v.id),
      pricing,
    ),
    loadInStock(container, p.variants, channelId),
  ]);
  const variants = p.variants.flatMap((v) => {
    const price = prices.get(v.id);
    if (!price || v.sku === "") return [];
    return [
      {
        variant_id: v.id,
        sku: v.sku,
        color: v.color,
        size: v.size,
        price: price.price,
        compare_at: price.compareAt,
        in_stock: stock.get(v.id) ?? false,
      },
    ];
  });
  const colors = [...new Set(variants.map((v) => v.color).filter((c): c is string => c !== null))]
    .map((c) => colorOf(dict, c))
    .sort((a, b) => a.rank - b.rank || (a.value < b.value ? -1 : 1));
  const sizes = [...new Set(variants.map((v) => v.size).filter((s): s is string => s !== null))]
    .map((s) => sizeOf(dict, s))
    .sort((a, b) => a.rank - b.rank || (a.value < b.value ? -1 : 1));
  const a = p.attributes;
  const cat = p.categories[0];
  return {
    product_id: p.id,
    handle: p.handle,
    title: p.title,
    description: p.description,
    kind: a?.kind ?? null,
    attributes: {
      material: a?.materialLabel ?? a?.material ?? null,
      composition: a?.composition ?? null,
      stretch: a?.stretch ?? null,
      fit: a?.fit ?? null,
      care: a?.care ?? null,
      origin: a?.origin ?? null,
    },
    category: cat ? { handle: cat.handle, name: cat.name } : null,
    options: {
      colors: colors.map(({ value, label, hex }) => ({ value, label, hex })),
      sizes: sizes.map(({ value, label }) => ({ value, label })),
    },
    variants,
    images: p.images.map((i) => ({
      url: i.url,
      alt: i.alt,
      color: i.color,
      width: i.width,
      height: i.height,
    })),
    size_chart: p.sizeChart
      ? {
          code: p.sizeChart.code,
          name: p.sizeChart.name,
          version: p.sizeChart.version,
          unit: p.sizeChart.unit,
          columns: p.sizeChart.columns,
          rows: p.sizeChart.rows,
        }
      : null,
    model_measurements: (a?.modelMeasurements ?? []).map((m) => ({
      image_set: m.imageSet,
      color: m.color,
      height_cm: m.heightCm,
      chest_cm: m.chestCm,
      waist_cm: m.waistCm,
      hip_cm: m.hipCm,
      size_worn: m.sizeWorn,
      note: m.note,
    })),
    updated_at: p.updatedAt.toISOString(),
  };
}
