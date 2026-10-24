import { chunkCount, sitemapEntries } from "./sitemap";

export const PRIVATE_DISALLOW = ["/gio-hang", "/thanh-toan", "/don-hang", "/tra-cuu-don", "/api/"] as const;

/** Danh sách sitemap; nguồn dữ liệu lỗi → vẫn trả tệp đầu tiên (robots không được 500). */
export async function sitemapUrls(siteUrl: string): Promise<string[]> {
  const base = siteUrl.replace(/\/+$/, "");
  let n = 1;
  try {
    n = chunkCount((await sitemapEntries()).length);
  } catch {
    // giữ n = 1
  }
  return Array.from({ length: n }, (_, i) => `${base}/sitemap/${i}.xml`);
}
