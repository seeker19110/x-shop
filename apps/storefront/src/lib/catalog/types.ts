/** Kiểu dữ liệu theo docs/design/API-CONTRACT.md (§Catalog). Tiền: số nguyên VND. */

export interface ColorOption {
  value: string;
  label: string;
  hex: string;
}

export interface SizeOption {
  value: string;
  label: string;
}

export interface ImageRef {
  url: string;
  alt: string;
  width: number;
  height: number;
}

export interface ProductListItem {
  product_id: string;
  handle: string;
  title: string;
  price_min: number;
  price_max: number;
  compare_at_max: number | null;
  colors: ColorOption[];
  thumbnail: ImageRef;
  in_stock: boolean;
  /** Lần sửa gần nhất (ISO UTC) — dùng cho `lastmod` của sitemap; nguồn không có thì bỏ trống (không bịa). */
  updated_at?: string;
}

export interface FacetValue {
  value: string;
  label: string;
  count: number;
}

export interface Facets {
  color: FacetValue[];
  size: FacetValue[];
  material: FacetValue[];
}

export interface ProductListResponse {
  items: ProductListItem[];
  facets: Facets;
  total: number;
  page: number;
  page_size: number;
}

export interface SearchSuggestion {
  type: "category";
  handle: string;
  name: string;
}

export interface SearchResponse extends ProductListResponse {
  suggestions?: SearchSuggestion[];
}

export interface ProductAttributes {
  material: string | null;
  composition: string | null;
  stretch: string | null;
  fit: string | null;
  care: string | null;
  origin: string | null;
}

export interface ProductVariant {
  variant_id: string;
  sku: string;
  color: string;
  size: string;
  price: number;
  compare_at: number | null;
  in_stock: boolean;
}

export interface ProductImage extends ImageRef {
  /** Giá trị màu; null = ảnh dùng chung mọi màu. */
  color: string | null;
}

export interface SizeChart {
  version: number;
  unit: "cm";
  columns: string[];
  rows: string[][];
}

export interface ModelMeasurement {
  image_set: string;
  height_cm: number;
  bust_cm: number | null;
  wearing_size: string;
}

export interface ProductDetail {
  product_id: string;
  handle: string;
  title: string;
  description: string;
  kind: string;
  attributes: ProductAttributes;
  category: { handle: string; name: string } | null;
  options: { color: ColorOption[]; size: SizeOption[] };
  variants: ProductVariant[];
  images: ProductImage[];
  size_chart: SizeChart | null;
  model_measurements: ModelMeasurement[];
  updated_at: string;
}

export type CatalogErrorCode = "VALIDATION" | "INVALID_RANGE" | "NOT_FOUND" | "UNAVAILABLE";

/** Lỗi từ nguồn dữ liệu (problem+json hoặc mạng); trang bắt và hiển thị lỗi nhẹ, không 500. */
export class CatalogError extends Error {
  override readonly name = "CatalogError";
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly status: number = 0,
  ) {
    super(message);
  }
}
