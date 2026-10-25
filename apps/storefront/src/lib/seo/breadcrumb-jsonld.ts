export interface Crumb {
  name: string;
  /** Đường dẫn gốc-tương-đối (`/danh-muc/ao`). Mục cuối (trang hiện tại) cũng có `path`. */
  path: string;
}

/** JSON-LD `BreadcrumbList` (đường dẫn tuyệt đối, vị trí từ 1). */
export function buildBreadcrumbJsonLd(crumbs: readonly Crumb[], siteUrl: string): Record<string, unknown> {
  const base = siteUrl.replace(/\/+$/, "");
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${base}${c.path}`,
    })),
  };
}
