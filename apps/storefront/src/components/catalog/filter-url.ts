import type { CatalogFilter } from "@x-shop/domain";

/**
 * Phần dựng URL an toàn cho CLIENT bundle.
 *
 * `@x-shop/domain` không khai báo `sideEffects` và chứa mã Node (crypto của VNPAY): import giá trị từ nó trong một
 * client component kéo cả gói (~139 KiB gzip) vào JS tải đầu — phá ngân sách 200 KiB (đặc tả §10.2). Vì vậy client chỉ
 * được `import type` từ domain; bản serialize dưới đây phản chiếu `serializeFilter` và được test đối chiếu với bản
 * domain (`filter-url.test.ts`) để không trôi khác nhau. Server dùng thẳng `serializeFilter` của domain.
 */
export function serializeQuery(f: CatalogFilter): string {
  const p = new URLSearchParams();
  if (f.q !== null) p.set("q", f.q);
  if (f.colors.length) p.set("color", [...f.colors].sort().join(","));
  if (f.sizes.length) p.set("size", [...f.sizes].sort().join(","));
  if (f.materials.length) p.set("material", [...f.materials].sort().join(","));
  if (f.priceMin !== null) p.set("price_min", String(f.priceMin));
  if (f.priceMax !== null) p.set("price_max", String(f.priceMax));
  if (f.inStock) p.set("in_stock", "1");
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.page > 1) p.set("page", String(f.page));
  return p.toString();
}

export function hrefFor(basePath: string, filter: CatalogFilter): string {
  const qs = serializeQuery(filter);
  return qs ? `${basePath}?${qs}` : basePath;
}

/** "Xóa tất cả": bỏ mọi điều kiện, giữ thứ tự sắp xếp (không phải điều kiện lọc). */
export function withoutConditions(filter: CatalogFilter, opts: { keepQuery?: boolean } = {}): CatalogFilter {
  return {
    q: opts.keepQuery ? filter.q : null,
    colors: [],
    sizes: [],
    materials: [],
    priceMin: null,
    priceMax: null,
    inStock: false,
    sort: filter.sort,
    page: 1,
  };
}
