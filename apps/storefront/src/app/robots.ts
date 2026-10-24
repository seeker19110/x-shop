import type { MetadataRoute } from "next";
import { getClientEnv } from "../lib/env";
import { PRIVATE_DISALLOW, sitemapUrls } from "../lib/seo/robots";

/**
 * Công khai trừ đường riêng tư. KHÔNG disallow URL lọc/tìm kiếm: chúng dùng `noindex,follow` trong meta — chặn robots
 * thì bot không đọc được noindex (đặc tả §12.1).
 */
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const site = getClientEnv().NEXT_PUBLIC_SITE_URL;
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...PRIVATE_DISALLOW] }],
    sitemap: await sitemapUrls(site),
    host: site,
  };
}
