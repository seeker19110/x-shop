// @vitest-environment node
import { FIXTURE_PRODUCTS } from "../../lib/catalog/fixtures";
import type { ProductDetail } from "../../lib/catalog/types";
import { buildProductJsonLd, serializeJsonLd } from "../../lib/seo/product-jsonld";
import { ctaFor, priceFor } from "./selection";

const SITE = "https://shop.example.vn/";

interface LdVariant {
  "@type": string;
  sku: string;
  color: string;
  size: string;
  url: string;
  image?: string;
  offers: { "@type": string; price: number; priceCurrency: string; availability: string; url: string };
}
interface Ld {
  "@context": string;
  "@type": string;
  productGroupID: string;
  url: string;
  variesBy?: string[];
  hasVariant: LdVariant[];
  [k: string]: unknown;
}

const ld = (p: ProductDetail) => buildProductJsonLd(p, SITE) as unknown as Ld;
const byHandle = (h: string) => FIXTURE_PRODUCTS.find((p) => p.handle === h)!;

describe("JSON-LD ProductGroup (product)", () => {
  const p = byHandle("ao-so-mi-oxford");
  const data = ld(p);

  it("ProductGroup + hasVariant: mỗi biến thể là Product kèm Offer giá VND", () => {
    expect(data["@context"]).toBe("https://schema.org");
    expect(data["@type"]).toBe("ProductGroup");
    expect(data.productGroupID).toBe(p.product_id);
    expect(data.url).toBe("https://shop.example.vn/san-pham/ao-so-mi-oxford");
    expect(data.hasVariant).toHaveLength(p.variants.length);
    for (const v of data.hasVariant) {
      expect(v["@type"]).toBe("Product");
      expect(v.offers["@type"]).toBe("Offer");
      expect(v.offers.priceCurrency).toBe("VND");
    }
  });

  it("variesBy: màu và size (chỉ chiều có nhiều giá trị)", () => {
    expect(data.variesBy).toEqual(["https://schema.org/color", "https://schema.org/size"]);
    expect(ld(byHandle("tui-tote-vai-canvas")).variesBy).toEqual(["https://schema.org/color"]);
  });

  it("giá và availability KHỚP UI cho từng SKU (cùng nguồn priceFor/ctaFor)", () => {
    for (const prod of FIXTURE_PRODUCTS) {
      for (const v of ld(prod).hasVariant) {
        const src = prod.variants.find((x) => x.sku === v.sku)!;
        const sel = { color: src.color, size: src.size };
        expect(v.offers.price).toBe(priceFor(prod, sel).current);
        const soldOut = ctaFor(prod, sel).kind === "sold-out";
        expect(v.offers.availability).toBe(
          soldOut ? "https://schema.org/OutOfStock" : "https://schema.org/InStock",
        );
      }
    }
  });

  it("biến thể hết hàng (navy-L) là OutOfStock, biến thể còn là InStock", () => {
    const navyL = data.hasVariant.find((v) => v.sku === "OXF-XANH-NAVY-L")!;
    expect(navyL.offers.availability).toBe("https://schema.org/OutOfStock");
    expect(data.hasVariant.find((v) => v.sku === "OXF-DEN-M")!.offers.availability).toBe(
      "https://schema.org/InStock",
    );
  });

  it("URL biến thể có ?color=&size= đúng; ảnh tuyệt đối theo màu", () => {
    const v = data.hasVariant.find((x) => x.sku === "OXF-TRANG-M")!;
    expect(v.url).toBe("https://shop.example.vn/san-pham/ao-so-mi-oxford?color=trang&size=m");
    expect(v.offers.url).toBe(v.url);
    expect(v.image).toBe("https://shop.example.vn/demo/top-trang-front.svg");
    expect(v.color).toBe("Trắng");
    expect(v.size).toBe("M");
  });

  it("KHÔNG có rating/review (không dữ liệu thật)", () => {
    const text = serializeJsonLd(data);
    expect(text).not.toMatch(/aggregateRating|review|ratingValue/i);
  });

  it("giá nguyên VND, không âm, ở mọi sản phẩm demo", () => {
    for (const prod of FIXTURE_PRODUCTS)
      for (const v of ld(prod).hasVariant) {
        expect(Number.isInteger(v.offers.price)).toBe(true);
        expect(v.offers.price).toBeGreaterThan(0);
      }
  });

  it("sản phẩm không có ảnh / không có chiều thay đổi vẫn sinh JSON hợp lệ", () => {
    const bare: ProductDetail = {
      ...p,
      images: [],
      options: { color: [p.options.color[0]!], size: [p.options.size[0]!] },
      variants: [p.variants[0]!],
    };
    const d = ld(bare);
    expect(d.variesBy).toBeUndefined();
    expect(d.image).toBeUndefined();
    expect(d.hasVariant[0]!.image).toBeUndefined();
  });
});

describe("serializeJsonLd — chống chèn script (product)", () => {
  it("escape '<' để '</script>' trong dữ liệu không đóng thẻ; phân tách dòng Unicode được escape; parse lại đúng", () => {
    const evil = "Áo </script><script>alert(1)</script>    ";
    const out = serializeJsonLd({ name: evil });
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(" ");
    expect(JSON.parse(out)).toEqual({ name: evil });
  });
});
