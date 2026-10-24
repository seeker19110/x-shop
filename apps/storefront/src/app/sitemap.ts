import type { MetadataRoute } from "next";
import { chunkCount, SITEMAP_CHUNK, sitemapEntries } from "../lib/seo/sitemap";

// Dữ liệu thật tại thời điểm yêu cầu (backend có thể chưa chạy lúc build); lớp catalog đã cache 60 giây.
export const dynamic = "force-dynamic";

/** Một tệp mỗi 5.000 URL: `/sitemap/0.xml`, `/sitemap/1.xml`… */
export async function generateSitemaps(): Promise<{ id: number }[]> {
  let total = 0;
  try {
    total = (await sitemapEntries()).length;
  } catch {
    // nguồn lỗi lúc build: giữ tệp 0, nội dung dựng lúc yêu cầu
  }
  return Array.from({ length: chunkCount(total) }, (_, id) => ({ id }));
}

export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const id = Number(await props.id);
  const all = await sitemapEntries();
  return all.slice(id * SITEMAP_CHUNK, (id + 1) * SITEMAP_CHUNK);
}
