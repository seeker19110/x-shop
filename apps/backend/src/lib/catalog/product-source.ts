import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CURRENCY, FASHION_KINDS, OPTION_COLOR, OPTION_SIZE, type FashionKind } from "./constants";

/**
 * Ảnh chụp đầy đủ một sản phẩm từ nguồn có thẩm quyền (Product/Pricing/Fashion qua Query) — một đường đọc duy nhất
 * cho kiểm xuất bản, read model, PDP và export, để bốn nơi không tự hiểu dữ liệu theo bốn kiểu.
 */
export interface SourceImage {
  id: string;
  url: string;
  rank: number;
  alt: string | null;
  /** Màu của ảnh: `metadata.color`, nếu thiếu thì màu chung của các biến thể được gắn ảnh (variant images native). */
  color: string | null;
  width: number | null;
  height: number | null;
  /** Bộ ảnh (`metadata.set`) — nối với số đo người mẫu. */
  set: string | null;
}

export interface SourceVariant {
  id: string;
  sku: string;
  rank: number;
  color: string | null;
  size: string | null;
  manageInventory: boolean;
  allowBackorder: boolean;
  /** Giá niêm yết VND (price set không rule, không price list) — dùng cho kiểm xuất bản và export. */
  basePrice: number | null;
}

export interface SourceSizeChart {
  id: string;
  code: string;
  version: number;
  name: string;
  garmentType: string;
  unit: string;
  columns: unknown;
  rows: unknown;
}

export interface SourceModelMeasurement {
  imageSet: string;
  color: string | null;
  heightCm: number;
  chestCm: number | null;
  waistCm: number | null;
  hipCm: number | null;
  sizeWorn: string;
  note: string | null;
}

export interface SourceAttributes {
  id: string;
  kind: FashionKind;
  material: string | null;
  materialLabel: string | null;
  composition: string | null;
  stretch: string | null;
  fit: string | null;
  care: string | null;
  origin: string | null;
  imageExceptionBy: string | null;
  modelMeasurements: SourceModelMeasurement[];
}

export interface SourceCategory {
  id: string;
  handle: string;
  name: string;
  /** Handle của chính danh mục và các danh mục cha (tối đa 2 cấp) — trang danh mục cha liệt kê cả sản phẩm con. */
  lineage: string[];
}

export interface ProductSource {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  status: string;
  thumbnail: string | null;
  createdAt: Date;
  updatedAt: Date;
  categories: SourceCategory[];
  salesChannelIds: string[];
  images: SourceImage[];
  variants: SourceVariant[];
  attributes: SourceAttributes | null;
  sizeChart: SourceSizeChart | null;
}

export const PRODUCT_SOURCE_FIELDS = [
  "id",
  "handle",
  "title",
  "description",
  "status",
  "thumbnail",
  "created_at",
  "updated_at",
  "categories.id",
  "categories.handle",
  "categories.name",
  "categories.rank",
  "categories.parent_category.handle",
  "categories.parent_category.parent_category.handle",
  "sales_channels.id",
  "images.id",
  "images.url",
  "images.rank",
  "images.metadata",
  "images.variants.id",
  "variants.id",
  "variants.sku",
  "variants.variant_rank",
  "variants.manage_inventory",
  "variants.allow_backorder",
  "variants.options.value",
  "variants.options.option.title",
  "variants.prices.amount",
  "variants.prices.currency_code",
  "variants.prices.rules_count",
  "variants.prices.price_list_id",
  "fashion_product_attributes.*",
  "fashion_product_attributes.model_measurements.*",
  "size_chart.*",
];

/* Hình tối thiểu đọc từ query.graph (kiểu sinh trong .medusa/types chỉ có sau build). */
type Nullable<T> = T | null | undefined;
type RawCategory = {
  id: string;
  handle: string;
  name: string;
  rank?: Nullable<number>;
  parent_category?: Nullable<{
    handle?: Nullable<string>;
    parent_category?: Nullable<{ handle?: Nullable<string> }>;
  }>;
};
type RawPrice = {
  amount?: Nullable<number | string>;
  currency_code?: Nullable<string>;
  rules_count?: Nullable<number>;
  price_list_id?: Nullable<string>;
};
type RawVariant = {
  id: string;
  sku?: Nullable<string>;
  variant_rank?: Nullable<number>;
  manage_inventory?: Nullable<boolean>;
  allow_backorder?: Nullable<boolean>;
  options?: Nullable<
    Nullable<{ value?: Nullable<string>; option?: Nullable<{ title?: Nullable<string> }> }>[]
  >;
  prices?: Nullable<Nullable<RawPrice>[]>;
};
type RawImage = {
  id: string;
  url: string;
  rank?: Nullable<number>;
  metadata?: Nullable<Record<string, unknown>>;
  variants?: Nullable<Nullable<{ id?: Nullable<string> }>[]>;
};
type RawMeasurement = {
  image_set: string;
  color?: Nullable<string>;
  height_cm: number;
  chest_cm?: Nullable<number>;
  waist_cm?: Nullable<number>;
  hip_cm?: Nullable<number>;
  size_worn: string;
  note?: Nullable<string>;
};
type RawAttributes = {
  id: string;
  kind: string;
  material?: Nullable<string>;
  material_label?: Nullable<string>;
  composition?: Nullable<string>;
  stretch?: Nullable<string>;
  fit?: Nullable<string>;
  care?: Nullable<string>;
  origin?: Nullable<string>;
  image_exception_by?: Nullable<string>;
  model_measurements?: Nullable<Nullable<RawMeasurement>[]>;
};
type RawSizeChart = {
  id: string;
  code: string;
  version: number;
  name: string;
  garment_type: string;
  unit: string;
  columns: unknown;
  rows: unknown;
};
export type RawProduct = {
  id: string;
  handle: string;
  title: string;
  description?: Nullable<string>;
  status: string;
  thumbnail?: Nullable<string>;
  created_at: string | Date;
  updated_at: string | Date;
  categories?: Nullable<Nullable<RawCategory>[]>;
  sales_channels?: Nullable<Nullable<{ id?: Nullable<string> }>[]>;
  images?: Nullable<Nullable<RawImage>[]>;
  variants?: Nullable<Nullable<RawVariant>[]>;
  fashion_product_attributes?: Nullable<RawAttributes>;
  size_chart?: Nullable<RawSizeChart>;
};

const compact = <T>(xs: Nullable<Nullable<T>[]>): T[] => (xs ?? []).filter((x): x is T => x != null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;

function optionValue(v: RawVariant, title: string): string | null {
  const opt = compact(v.options).find((o) => o.option?.title === title);
  return str(opt?.value ?? null);
}

/** Số tiền VND: chỉ nhận số nguyên an toàn (PRICE01); giá lẻ/hỏng → null để kiểm xuất bản báo PRICE_INVALID. */
export function toVnd(amount: unknown): number | null {
  const n = typeof amount === "string" ? Number(amount) : amount;
  return typeof n === "number" && Number.isSafeInteger(n) ? n : null;
}

function basePrice(v: RawVariant): number | null {
  const p = compact(v.prices).find(
    (x) => x.currency_code === CURRENCY && !x.price_list_id && (x.rules_count ?? 0) === 0,
  );
  if (!p) return null;
  // Giá có phần lẻ vẫn trả về (không làm tròn) để kiểm xuất bản thấy PRICE_INVALID thay vì PRICE_MISSING.
  const n = typeof p.amount === "string" ? Number(p.amount) : p.amount;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export function toProductSource(p: RawProduct): ProductSource {
  const variants: SourceVariant[] = compact(p.variants)
    .map((v) => ({
      id: v.id,
      sku: v.sku ?? "",
      rank: v.variant_rank ?? 0,
      color: optionValue(v, OPTION_COLOR),
      size: optionValue(v, OPTION_SIZE),
      manageInventory: v.manage_inventory !== false,
      allowBackorder: v.allow_backorder === true,
      basePrice: basePrice(v),
    }))
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
  const colorOfVariant = new Map(variants.map((v) => [v.id, v.color]));
  const images: SourceImage[] = compact(p.images)
    .map((img) => {
      const meta = img.metadata ?? {};
      let color = str(meta.color);
      if (color === null) {
        const linked = new Set(
          compact(img.variants)
            .map((v) => (v.id ? colorOfVariant.get(v.id) : null))
            .filter((c): c is string => !!c),
        );
        if (linked.size === 1) color = [...linked][0] ?? null;
      }
      return {
        id: img.id,
        url: img.url,
        rank: img.rank ?? 0,
        alt: str(meta.alt),
        color,
        width: int(meta.width),
        height: int(meta.height),
        set: str(meta.set),
      };
    })
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1));
  const categories: SourceCategory[] = compact(p.categories)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || (a.handle < b.handle ? -1 : 1))
    .map((c) => ({
      id: c.id,
      handle: c.handle,
      name: c.name,
      lineage: [
        c.handle,
        c.parent_category?.handle ?? null,
        c.parent_category?.parent_category?.handle ?? null,
      ].filter((h): h is string => !!h),
    }));
  const a = p.fashion_product_attributes;
  const attributes: SourceAttributes | null = a
    ? {
        id: a.id,
        kind: (FASHION_KINDS as readonly string[]).includes(a.kind) ? (a.kind as FashionKind) : "apparel",
        material: str(a.material),
        materialLabel: str(a.material_label),
        composition: str(a.composition),
        stretch: str(a.stretch),
        fit: str(a.fit),
        care: str(a.care),
        origin: str(a.origin),
        imageExceptionBy: str(a.image_exception_by),
        modelMeasurements: compact(a.model_measurements)
          .map((m) => ({
            imageSet: m.image_set,
            color: str(m.color),
            heightCm: m.height_cm,
            chestCm: m.chest_cm ?? null,
            waistCm: m.waist_cm ?? null,
            hipCm: m.hip_cm ?? null,
            sizeWorn: m.size_worn,
            note: str(m.note),
          }))
          .sort((x, y) => (x.imageSet < y.imageSet ? -1 : x.imageSet > y.imageSet ? 1 : 0)),
      }
    : null;
  const sc = p.size_chart;
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    description: str(p.description),
    status: p.status,
    thumbnail: str(p.thumbnail),
    createdAt: new Date(p.created_at),
    updatedAt: new Date(p.updated_at),
    categories,
    salesChannelIds: compact(p.sales_channels)
      .map((s) => s.id)
      .filter((id): id is string => !!id),
    images,
    variants,
    attributes,
    sizeChart: sc
      ? {
          id: sc.id,
          code: sc.code,
          version: sc.version,
          name: sc.name,
          garmentType: sc.garment_type,
          unit: sc.unit,
          columns: sc.columns,
          rows: sc.rows,
        }
      : null,
  };
}

export async function loadProductSources(
  container: MedusaContainer,
  filters: { id?: string[]; handle?: string },
): Promise<ProductSource[]> {
  if (filters.id !== undefined && filters.id.length === 0) return [];
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "product",
    fields: PRODUCT_SOURCE_FIELDS,
    filters: filters.id !== undefined ? { id: filters.id } : { handle: filters.handle },
  });
  const rows = data as unknown as RawProduct[];
  return rows.map(toProductSource);
}
