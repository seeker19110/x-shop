import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProductDetails } from "../../../../components/product/ProductDetails";
import { ProductExperience } from "../../../../components/product/ProductExperience";
import { initialSelection } from "../../../../components/product/selection";
import { Breadcrumb } from "../../../../components/ui/Breadcrumb";
import { getProduct } from "../../../../lib/catalog/client";
import { categoryHref } from "../../../../lib/content/navigation";
import { getClientEnv } from "../../../../lib/env";
import { buildProductJsonLd, productPath, serializeJsonLd } from "../../../../lib/seo/product-jsonld";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function shorten(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const p = await getProduct(slug);
  if (!p) return { title: "Không tìm thấy sản phẩm", robots: { index: false } };
  const image = p.images[0];
  return {
    title: p.title,
    description: shorten(p.description || `${p.title} tại X-Shop.`),
    // Mọi biến thể (?color=&size=) cùng một canonical: trang sản phẩm gốc (đặc tả §12.1, mô hình một PDP).
    alternates: { canonical: productPath(p.handle) },
    openGraph: {
      type: "website",
      title: p.title,
      description: shorten(p.description || p.title),
      url: productPath(p.handle),
      ...(image
        ? { images: [{ url: image.url, width: image.width, height: image.height, alt: image.alt }] }
        : {}),
    },
  };
}

export default async function ProductPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const product = await getProduct(slug);
  if (!product) notFound();
  const initial = initialSelection(product, await searchParams);
  const jsonLd = serializeJsonLd(buildProductJsonLd(product, getClientEnv().NEXT_PUBLIC_SITE_URL));

  return (
    <>
      <Breadcrumb
        items={[
          { label: "Trang chủ", href: "/" },
          ...(product.category
            ? [{ label: product.category.name, href: categoryHref(product.category.handle) }]
            : []),
          { label: product.title },
        ]}
      />
      <ProductExperience product={product} initial={initial}>
        <ProductDetails product={product} />
      </ProductExperience>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
    </>
  );
}
