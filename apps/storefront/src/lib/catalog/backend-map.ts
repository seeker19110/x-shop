import type {
  ColorOption,
  Facets,
  FacetValue,
  ImageRef,
  ModelMeasurement,
  ProductDetail,
  ProductImage,
  ProductListItem,
  ProductListResponse,
  SearchResponse,
  SearchSuggestion,
  SizeChart,
} from "./types";

/**
 * Lớp ánh xạ từ shape THẬT của backend (`apps/backend/src/lib/catalog/{listing,product-detail}.ts`, kiểm bằng fixture
 * JSON lấy từ phản hồi thật ở `__fixtures__/backend/`) sang kiểu storefront. Backend là nguồn chuẩn — không sửa
 * backend để khớp contract cũ. Hàm thuần, không I/O; dữ liệu thiếu/null được đưa về giá trị an toàn có chủ đích.
 */

/** Kích thước ảnh khi backend không báo (ảnh demo 800×1000): tỷ lệ 4:5 theo DESIGN.md. */
const FALLBACK_W = 800;
const FALLBACK_H = 1000;
const FALLBACK_HEX = "#9ca3af"; // hex-ok: màu swatch dự phòng của dữ liệu sản phẩm, không phải màu giao diện

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `/static/...` (đường dẫn tương đối của backend, chỉ có ở dev) → URL tuyệt đối; URL đầy đủ giữ nguyên. */
export function assetUrl(url: string, backendBase: string): string {
  return url.startsWith("/") && !url.startsWith("//") ? `${backendBase}${url}` : url;
}

function mapColor(raw: unknown): ColorOption {
  const c = isObj(raw) ? raw : {};
  return { value: str(c.value), label: str(c.label, str(c.value)), hex: str(c.hex, FALLBACK_HEX) };
}

function mapFacet(raw: unknown): FacetValue[] {
  return arr(raw).flatMap((f) =>
    isObj(f) ? [{ value: str(f.value), label: str(f.label, str(f.value)), count: num(f.count) }] : [],
  );
}

function mapFacets(raw: unknown): Facets {
  const f = isObj(raw) ? raw : {};
  return { color: mapFacet(f.color), size: mapFacet(f.size), material: mapFacet(f.material) };
}

function mapItem(raw: unknown, base: string): ProductListItem[] {
  if (!isObj(raw)) return [];
  const title = str(raw.title);
  // Backend trả `thumbnail` là chuỗi URL (hoặc null); storefront cần ảnh có alt/kích thước.
  const thumb = str(raw.thumbnail);
  const thumbnail: ImageRef = {
    url: thumb ? assetUrl(thumb, base) : "",
    alt: title,
    width: FALLBACK_W,
    height: FALLBACK_H,
  };
  return [
    {
      product_id: str(raw.product_id),
      handle: str(raw.handle),
      title,
      price_min: num(raw.price_min),
      price_max: num(raw.price_max),
      // Backend: `compare_at` (giá gạch của SKU rẻ nhất khớp); contract cũ gọi `compare_at_max`.
      compare_at_max: numOrNull(raw.compare_at ?? raw.compare_at_max),
      colors: arr(raw.colors).map(mapColor),
      thumbnail,
      in_stock: raw.in_stock === true,
      ...(typeof raw.updated_at === "string" && raw.updated_at ? { updated_at: raw.updated_at } : {}),
    },
  ];
}

export function mapList(raw: unknown, base: string): ProductListResponse {
  const r = isObj(raw) ? raw : {};
  return {
    items: arr(r.items).flatMap((i) => mapItem(i, base)),
    facets: mapFacets(r.facets),
    total: num(r.total),
    page: num(r.page, 1),
    page_size: num(r.page_size, 12),
  };
}

/** Backend: `suggestions: { categories: [{handle,name}] }`; storefront: mảng `{type:"category",…}`. */
export function mapSearch(raw: unknown, base: string): SearchResponse {
  const out: SearchResponse = mapList(raw, base);
  const s = isObj(raw) && isObj(raw.suggestions) ? raw.suggestions : null;
  const cats: SearchSuggestion[] = arr(s?.categories).flatMap((c) =>
    isObj(c) ? [{ type: "category" as const, handle: str(c.handle), name: str(c.name) }] : [],
  );
  if (out.total === 0 && cats.length > 0) out.suggestions = cats;
  return out;
}

function cell(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number")) {
    return v[0] === v[1] ? String(v[0]) : `${v[0]}–${v[1]}`;
  }
  return "—";
}

/** Bảng size backend: cột `{key,label}`, dòng `{label, values:{key: số | [min,max]}}` → bảng chuỗi (cột đầu "Size"). */
export function mapSizeChart(raw: unknown): SizeChart | null {
  if (!isObj(raw)) return null;
  const cols = arr(raw.columns).flatMap((c) => (isObj(c) ? [{ key: str(c.key), label: str(c.label) }] : []));
  const rows = arr(raw.rows).flatMap((r) => {
    if (!isObj(r)) return [];
    const values = isObj(r.values) ? r.values : {};
    return [[str(r.label, str(r.size).toUpperCase()), ...cols.map((c) => cell(values[c.key]))]];
  });
  if (cols.length === 0 || rows.length === 0) return null;
  return {
    version: num(raw.version, 1),
    unit: "cm",
    columns: ["Size", ...cols.map((c) => c.label)],
    rows,
  };
}

function mapModel(raw: unknown): ModelMeasurement[] {
  if (!isObj(raw)) return [];
  const height = numOrNull(raw.height_cm);
  if (height === null) return [];
  return [
    {
      image_set: str(raw.image_set, str(raw.color)),
      height_cm: height,
      bust_cm: numOrNull(raw.chest_cm ?? raw.bust_cm),
      wearing_size: str(raw.size_worn ?? raw.wearing_size),
    },
  ];
}

function mapImage(raw: unknown, base: string): ProductImage[] {
  if (!isObj(raw) || !str(raw.url)) return [];
  return [
    {
      url: assetUrl(str(raw.url), base),
      alt: str(raw.alt),
      color: typeof raw.color === "string" ? raw.color : null,
      width: num(raw.width, FALLBACK_W),
      height: num(raw.height, FALLBACK_H),
    },
  ];
}

export function mapProduct(raw: unknown, base: string): ProductDetail | null {
  if (!isObj(raw) || !str(raw.product_id) || !str(raw.handle)) return null;
  const a = isObj(raw.attributes) ? raw.attributes : {};
  const opts = isObj(raw.options) ? raw.options : {};
  const cat = isObj(raw.category) ? raw.category : null;
  const sizes = arr(opts.sizes ?? opts.size).flatMap((s) =>
    isObj(s) ? [{ value: str(s.value), label: str(s.label, str(s.value)) }] : [],
  );
  return {
    product_id: str(raw.product_id),
    handle: str(raw.handle),
    title: str(raw.title),
    description: str(raw.description),
    kind: str(raw.kind),
    attributes: {
      material: typeof a.material === "string" ? a.material : null,
      composition: typeof a.composition === "string" ? a.composition : null,
      stretch: typeof a.stretch === "string" ? a.stretch : null,
      fit: typeof a.fit === "string" ? a.fit : null,
      care: typeof a.care === "string" ? a.care : null,
      origin: typeof a.origin === "string" ? a.origin : null,
    },
    category: cat ? { handle: str(cat.handle), name: str(cat.name) } : null,
    options: { color: arr(opts.colors ?? opts.color).map(mapColor), size: sizes },
    variants: arr(raw.variants).flatMap((v) =>
      isObj(v) && str(v.variant_id)
        ? [
            {
              variant_id: str(v.variant_id),
              sku: str(v.sku),
              color: str(v.color),
              size: str(v.size),
              price: num(v.price),
              compare_at: numOrNull(v.compare_at),
              in_stock: v.in_stock === true,
            },
          ]
        : [],
    ),
    images: arr(raw.images).flatMap((i) => mapImage(i, base)),
    size_chart: mapSizeChart(raw.size_chart),
    model_measurements: arr(raw.model_measurements).flatMap(mapModel),
    updated_at: str(raw.updated_at),
  };
}

export interface CategoryEntry {
  handle: string;
  name: string;
  parent_handle: string | null;
  product_count: number;
}

export function mapCategories(raw: unknown): CategoryEntry[] {
  const list = isObj(raw) ? arr(raw.categories) : [];
  return list.flatMap((c) =>
    isObj(c) && str(c.handle)
      ? [
          {
            handle: str(c.handle),
            name: str(c.name, str(c.handle)),
            parent_handle: typeof c.parent_handle === "string" ? c.parent_handle : null,
            product_count: num(c.product_count),
          },
        ]
      : [],
  );
}
