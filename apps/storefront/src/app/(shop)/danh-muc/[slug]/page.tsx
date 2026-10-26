import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CatalogView } from "../../../../components/catalog/CatalogView";
import { CATALOG_PAGE_SIZE, getCategoryName } from "../../../../lib/catalog/client";
import { loadListing, toQueryString, type RawParams } from "../../../../lib/catalog/listing";
import { categoryHref } from "../../../../lib/content/navigation";
import { buildBreadcrumbJsonLd } from "../../../../lib/seo/breadcrumb-jsonld";
import { serializeJsonLd } from "../../../../lib/seo/product-jsonld";
import { getClientEnv } from "../../../../lib/env";
import { catalogMetadata } from "../../../../lib/seo/catalog-meta";

interface Props {
  params: Promise<{ slug: string }>;
  searchParams: Promise<RawParams>;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const name = await getCategoryName(slug);
  if (!name) return { title: "Không tìm thấy danh mục", robots: { index: false } };
  const { filter, result } = await loadListing("category", slug, toQueryString(await searchParams));
  return catalogMetadata({
    basePath: categoryHref(slug),
    filter,
    title: name,
    description: `Mua ${name.toLowerCase()} tại X-Shop: lọc theo màu, size, giá và còn hàng.`,
    total: result?.total ?? null,
    pageSize: result?.page_size ?? CATALOG_PAGE_SIZE,
  });
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const name = await getCategoryName(slug);
  if (!name) notFound();
  const { filter, issues, result, error } = await loadListing(
    "category",
    slug,
    toQueryString(await searchParams),
  );
  const crumbsLd = serializeJsonLd(
    buildBreadcrumbJsonLd(
      [
        { name: "Trang chủ", path: "/" },
        { name: name, path: categoryHref(slug) },
      ],
      getClientEnv().NEXT_PUBLIC_SITE_URL,
    ),
  );
  return (
    <>
      <CatalogView
        basePath={categoryHref(slug)}
        heading={name}
        filter={filter}
        issues={issues}
        result={result}
        error={error}
        category={slug}
      />
      {/* eslint-disable-next-line react/no-danger -- JSON-LD do serializeJsonLd tạo (thoát "<", U+2028/2029), không có dữ liệu thô */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: crumbsLd }} />
    </>
  );
}
