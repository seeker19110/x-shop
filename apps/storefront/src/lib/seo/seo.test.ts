// @vitest-environment node
import { buildBreadcrumbJsonLd } from "./breadcrumb-jsonld";
import robots from "../../app/robots";
import sitemap, { generateSitemaps } from "../../app/sitemap";
import { buildSitemapEntries, chunkCount, SITEMAP_CHUNK } from "./sitemap";

const SITE = "https://shop.example.vn/";

describe("seo: buildSitemapEntries", () => {
  it("trang chủ + danh mục có sản phẩm + sản phẩm; bỏ danh mục rỗng; không trùng; lastmod từ updated_at", () => {
    const e = buildSitemapEntries(
      {
        categories: [
          { handle: "ao", product_count: 3 },
          { handle: "rong", product_count: 0 },
        ],
        products: [
          { handle: "a", updated_at: "2026-10-01T09:00:00Z" },
          { handle: "a", updated_at: "2026-10-02T09:00:00Z" },
          { handle: "b" },
          { handle: "c", updated_at: "không-phải-ngày" },
        ],
      },
      SITE,
    );
    expect(e.map((x) => x.url)).toEqual([
      "https://shop.example.vn/",
      "https://shop.example.vn/danh-muc/ao",
      "https://shop.example.vn/san-pham/a",
      "https://shop.example.vn/san-pham/b",
      "https://shop.example.vn/san-pham/c",
    ]);
    expect(e[2]!.lastModified).toEqual(new Date("2026-10-01T09:00:00Z"));
    expect(e[3]!.lastModified).toBeUndefined();
    expect(e[4]!.lastModified).toBeUndefined();
  });

  it("rỗng: chỉ còn trang chủ; handle có ký tự đặc biệt được mã hóa", () => {
    expect(buildSitemapEntries({ categories: [], products: [] }, SITE)).toHaveLength(1);
    const e = buildSitemapEntries({ categories: [], products: [{ handle: "áo đẹp" }] }, SITE);
    expect(e[1]!.url).toBe("https://shop.example.vn/san-pham/%C3%A1o%20%C4%91%E1%BA%B9p");
  });

  it("phân trang: > 5.000 URL tách tệp, ranh giới đúng", () => {
    expect(chunkCount(0)).toBe(1);
    expect(chunkCount(SITEMAP_CHUNK)).toBe(1);
    expect(chunkCount(SITEMAP_CHUNK + 1)).toBe(2);
    expect(chunkCount(12000)).toBe(3);
  });
});

describe("seo: sitemap route (fixtures)", () => {
  it("chỉ URL công khai của sản phẩm/danh mục có thật; không có tìm kiếm/giỏ/lọc", async () => {
    const ids = await generateSitemaps();
    expect(ids).toEqual([{ id: 0 }]);
    const urls = (await sitemap({ id: Promise.resolve("0") })).map((x) => x.url);
    expect(urls[0]).toBe("http://localhost:3000/");
    expect(urls).toContain("http://localhost:3000/danh-muc/ao");
    expect(urls).toContain("http://localhost:3000/san-pham/ao-so-mi-oxford");
    expect(urls.some((u) => /tim-kiem|gio-hang|thanh-toan|don-hang|\?/.test(u))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
    expect((await sitemap({ id: Promise.resolve("5") })).length).toBe(0);
  });

  it("sản phẩm có lastmod từ updated_at", async () => {
    const e = await sitemap({ id: Promise.resolve("0") });
    const p = e.find((x) => x.url.endsWith("/san-pham/ao-so-mi-oxford"))!;
    expect(p.lastModified).toBeInstanceOf(Date);
  });
});

describe("seo: robots", () => {
  it("chặn đường riêng tư, KHÔNG chặn URL lọc/tìm kiếm, trỏ sitemap", async () => {
    const r = await robots();
    const rule = (Array.isArray(r.rules) ? r.rules[0] : r.rules)!;
    expect(rule.allow).toBe("/");
    expect(rule.disallow).toEqual(["/gio-hang", "/thanh-toan", "/don-hang", "/tra-cuu-don", "/api/"]);
    for (const d of rule.disallow as string[]) {
      expect(d).not.toMatch(/\?|\*|tim-kiem|danh-muc/);
    }
    expect(r.sitemap).toEqual(["http://localhost:3000/sitemap/0.xml"]);
  });
});

describe("seo: BreadcrumbList JSON-LD", () => {
  it("vị trí từ 1, URL tuyệt đối", () => {
    const ld = buildBreadcrumbJsonLd(
      [
        { name: "Trang chủ", path: "/" },
        { name: "Áo", path: "/danh-muc/ao" },
      ],
      SITE,
    ) as { itemListElement: { position: number; item: string }[] };
    expect(ld.itemListElement.map((i) => [i.position, i.item])).toEqual([
      [1, "https://shop.example.vn/"],
      [2, "https://shop.example.vn/danh-muc/ao"],
    ]);
  });
});
