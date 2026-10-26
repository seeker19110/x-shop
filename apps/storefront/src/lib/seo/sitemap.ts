import { EMPTY_FILTER } from "@x-shop/domain";
import type { MetadataRoute } from "next";
import { getCategories, listProducts } from "../catalog/client";
import { categoryHref } from "../content/navigation";
import { getClientEnv } from "../env";
import { productPath } from "./product-jsonld";
import { isNonEmpty } from "../presence";

/** Giới hạn của giao thức sitemap là 50.000 URL; ta cắt ở 5.000 cho mỗi tệp (nhẹ, dễ gỡ lỗi). */
export const SITEMAP_CHUNK = 5000;
/** Backend kẹp `page_size` ≤ 48. */
const PAGE = 48;

export interface SitemapSource {
  categories: { handle: string; product_count: number }[];
  products: { handle: string; updated_at?: string }[];
}

type Entry = MetadataRoute.Sitemap[number];

/** `lastmod` chỉ khi là ngày hợp lệ; thiếu/sai → bỏ (không bịa). */
function lastmod(iso: string | undefined): Date | undefined {
  if (!isNonEmpty(iso)) return undefined;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Trang chủ, danh mục CÓ sản phẩm, sản phẩm publish — thứ tự ổn định (cắt tệp không xê dịch). */
export function buildSitemapEntries(src: SitemapSource, siteUrl: string): Entry[] {
  const base = siteUrl.replace(/\/+$/, "");
  const seen = new Set<string>();
  const out: Entry[] = [{ url: `${base}/` }];
  const push = (path: string, mod?: Date) => {
    const url = `${base}${path}`;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, ...(mod ? { lastModified: mod } : {}) });
  };
  for (const c of src.categories) if (c.product_count > 0) push(categoryHref(c.handle));
  for (const p of src.products) if (p.handle) push(productPath(p.handle), lastmod(p.updated_at));
  return out;
}

export function chunkCount(total: number): number {
  return Math.max(1, Math.ceil(total / SITEMAP_CHUNK));
}

/** Đọc toàn bộ sản phẩm qua lớp catalog (phân trang tối đa); nguồn lỗi → ném để sitemap không phát dữ liệu cụt. */
export async function loadSitemapSource(): Promise<SitemapSource> {
  const categories = await getCategories();
  const products: SitemapSource["products"] = [];
  for (let page = 1; ; page += 1) {
    const r = await listProducts({ ...EMPTY_FILTER, page }, { pageSize: PAGE });
    for (const i of r.items) products.push({ handle: i.handle, updated_at: i.updated_at });
    if (r.items.length === 0 || products.length >= r.total) break;
  }
  return { categories, products };
}

export async function sitemapEntries(): Promise<Entry[]> {
  return buildSitemapEntries(await loadSitemapSource(), getClientEnv().NEXT_PUBLIC_SITE_URL);
}
