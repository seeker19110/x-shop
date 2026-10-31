import {
  facetCounts,
  filterProducts,
  PAGE_SIZE_MAX,
  slugify,
  type CatalogFilter,
  type FacetName,
  type IndexedProduct,
} from "@x-shop/domain";
import { FIXTURE_CATEGORIES, FIXTURE_PRODUCTS } from "./fixtures";
import type {
  FacetValue,
  Facets,
  ProductDetail,
  ProductListItem,
  ProductListResponse,
  SearchResponse,
} from "./types";
import { isNonEmpty } from "../presence";

/**
 * Adapter fixture: lọc/đếm facet bằng `filterProducts` / `facetCounts` của domain — cùng "oracle" mà test tích hợp
 * backend dùng — nên hành vi (khớp trên cùng SKU, giá theo SKU khớp, sắp xếp ổn định) giống backend.
 */

const SIZE_ORDER = ["xs", "s", "m", "l", "xl", "xxl", "free"];

function index(products: readonly ProductDetail[]): IndexedProduct[] {
  return products.map((p) => ({
    productId: p.product_id,
    // Tên danh mục đưa vào văn bản tìm kiếm (CAT01: tìm theo tên, SKU, danh mục).
    title: `${p.title} ${p.category?.name ?? ""}`,
    material: isNonEmpty(p.attributes.material) ? slugify(p.attributes.material) : null,
    createdAt: p.updated_at,
    variants: p.variants.map((v) => ({
      variantId: v.variant_id,
      sku: v.sku,
      color: v.color,
      size: v.size,
      price: v.price,
      inStock: v.in_stock,
    })),
  }));
}

function inCategory(category: string | null | undefined): ProductDetail[] {
  return FIXTURE_PRODUCTS.filter((p) => !isNonEmpty(category) || p.category?.handle === category);
}

function labelsFor(products: readonly ProductDetail[], facet: FacetName): Map<string, string> {
  const labels = new Map<string, string>();
  for (const p of products) {
    if (facet === "color") for (const c of p.options.color) labels.set(c.value, c.label);
    else if (facet === "size") for (const s of p.options.size) labels.set(s.value, s.label);
    else if (isNonEmpty(p.attributes.material))
      labels.set(slugify(p.attributes.material), p.attributes.material);
  }
  return labels;
}

function facetValues(products: readonly ProductDetail[], f: CatalogFilter, facet: FacetName): FacetValue[] {
  const labels = labelsFor(products, facet);
  const counts = facetCounts(index(products), f, facet);
  const out = [...counts].map(([value, count]) => ({ value, label: labels.get(value) ?? value, count }));
  if (facet === "size") {
    out.sort(
      (a, b) => SIZE_ORDER.indexOf(a.value) - SIZE_ORDER.indexOf(b.value) || a.value.localeCompare(b.value),
    );
  } else out.sort((a, b) => a.label.localeCompare(b.label, "vi"));
  return out;
}

export function fixtureList(
  filter: CatalogFilter,
  opts: { category?: string | null; pageSize: number },
): ProductListResponse {
  const scope = inCategory(opts.category);
  const pageSize = Math.min(Math.max(1, Math.trunc(opts.pageSize)), PAGE_SIZE_MAX);
  const byId = new Map(scope.map((p) => [p.product_id, p]));
  const matches = filterProducts(index(scope), filter);
  const start = (filter.page - 1) * pageSize;
  const items: ProductListItem[] = matches.slice(start, start + pageSize).map((m) => {
    const p = byId.get(m.productId)!;
    const matched = p.variants.filter((v) => m.matchedVariantIds.includes(v.variant_id));
    const discounts = matched.filter((v) => v.compare_at !== null && v.compare_at > v.price);
    const wanted = filter.colors[0];
    const thumb = p.images.find((i) => i.color === wanted) ?? p.images[0]!;
    return {
      product_id: p.product_id,
      handle: p.handle,
      title: p.title,
      price_min: m.priceMin,
      price_max: m.priceMax,
      compare_at_max: discounts.length ? Math.max(...discounts.map((v) => v.compare_at!)) : null,
      colors: p.options.color,
      thumbnail: { url: thumb.url, alt: thumb.alt, width: thumb.width, height: thumb.height },
      in_stock: matched.some((v) => v.in_stock),
      updated_at: p.updated_at,
    };
  });
  const facets: Facets = {
    color: facetValues(scope, filter, "color"),
    size: facetValues(scope, filter, "size"),
    material: facetValues(scope, filter, "material"),
  };
  return { items, facets, total: matches.length, page: filter.page, page_size: pageSize };
}

export function fixtureSearch(filter: CatalogFilter, opts: { pageSize: number }): SearchResponse {
  const res = fixtureList(filter, { category: null, pageSize: opts.pageSize });
  if (res.total > 0) return res;
  return {
    ...res,
    suggestions: fixtureCategories().map(({ handle, name }) => ({ type: "category", handle, name })),
  };
}

export function fixtureProduct(handle: string): ProductDetail | null {
  return FIXTURE_PRODUCTS.find((p) => p.handle === handle) ?? null;
}

/** Danh mục có ít nhất một sản phẩm (nhóm trống không hiện ở menu). */
export function fixtureCategories(): { handle: string; name: string; count: number }[] {
  return FIXTURE_CATEGORIES.map((c) => ({
    handle: c.handle,
    name: c.name,
    count: FIXTURE_PRODUCTS.filter((p) => p.category?.handle === c.handle).length,
  })).filter((c) => c.count > 0);
}
