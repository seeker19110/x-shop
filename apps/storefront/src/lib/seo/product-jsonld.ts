import { colorLabel, sizeLabel, variantQuery } from "../../components/product/selection";
import type { ProductDetail } from "../catalog/types";

const SCHEMA = "https://schema.org";

export function productPath(handle: string): string {
  return `/san-pham/${encodeURIComponent(handle)}`;
}

function absolute(siteUrl: string, pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${siteUrl}${pathOrUrl}`;
}

/**
 * JSON-LD `ProductGroup` + `hasVariant` (`Product` + `Offer`) — đặc tả §12.1, S-506. Giá và availability lấy từ CÙNG dữ liệu
 * biến thể mà UI dùng (không tính lại) nên luôn khớp. Không có `aggregateRating`/`review` (không dữ liệu thật).
 * `variesBy` chỉ liệt kê chiều thật sự có nhiều giá trị.
 */
export function buildProductJsonLd(p: ProductDetail, siteUrl: string): Record<string, unknown> {
  const base = siteUrl.replace(/\/+$/, "");
  const url = absolute(base, productPath(p.handle));
  const varies: string[] = [];
  if (p.options.color.length > 1) varies.push(`${SCHEMA}/color`);
  if (p.options.size.length > 1) varies.push(`${SCHEMA}/size`);

  const hasVariant = p.variants.map((v) => {
    const variantUrl = `${url}?${variantQuery({ color: v.color, size: v.size })}`;
    const image =
      p.images.find((i) => i.color === v.color) ?? p.images.find((i) => i.color === null) ?? p.images[0];
    return {
      "@type": "Product",
      sku: v.sku,
      name: `${p.title} – ${colorLabel(p, v.color)}, size ${sizeLabel(p, v.size)}`,
      color: colorLabel(p, v.color),
      size: sizeLabel(p, v.size),
      ...(image ? { image: absolute(base, image.url) } : {}),
      url: variantUrl,
      offers: {
        "@type": "Offer",
        url: variantUrl,
        price: v.price,
        priceCurrency: "VND",
        availability: `${SCHEMA}/${v.in_stock ? "InStock" : "OutOfStock"}`,
      },
    };
  });

  return {
    "@context": SCHEMA,
    "@type": "ProductGroup",
    productGroupID: p.product_id,
    name: p.title,
    description: p.description,
    url,
    ...(p.images[0] ? { image: p.images.slice(0, 6).map((i) => absolute(base, i.url)) } : {}),
    ...(varies.length > 0 ? { variesBy: varies } : {}),
    hasVariant,
  };
}

/** Chuỗi an toàn để nhúng vào `<script type="application/ld+json">`: chặn `</script>` và ký tự phân tách dòng. */
const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}
