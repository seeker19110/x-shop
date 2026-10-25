import type { Metadata } from "next";
import { CatalogView } from "../../../components/catalog/CatalogView";
import { SearchBox } from "../../../components/catalog/SearchBox";
import { CATALOG_PAGE_SIZE } from "../../../lib/catalog/client";
import { loadListing, toQueryString, type RawParams } from "../../../lib/catalog/listing";
import { catalogMetadata } from "../../../lib/seo/catalog-meta";

interface Props {
  searchParams: Promise<RawParams>;
}

const BASE = "/tim-kiem";

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { filter, result } = await loadListing("search", "", toQueryString(await searchParams));
  return catalogMetadata({
    basePath: BASE,
    filter,
    title: filter.q ? `Tìm kiếm: ${filter.q}` : "Tìm kiếm",
    description: "Tìm sản phẩm theo tên, mã SKU hoặc danh mục.",
    total: result?.total ?? null,
    pageSize: result?.page_size ?? CATALOG_PAGE_SIZE,
    search: true, // mọi URL tìm kiếm: noindex,follow
  });
}

export default async function SearchPage({ searchParams }: Props) {
  const { filter, issues, result, error, suggestions } = await loadListing(
    "search",
    "",
    toQueryString(await searchParams),
  );
  return (
    <CatalogView
      basePath={BASE}
      heading={filter.q ? `Kết quả cho “${filter.q}”` : "Tất cả sản phẩm"}
      header={<SearchBox defaultValue={filter.q} />}
      filter={filter}
      issues={issues}
      result={result}
      error={error}
      suggestions={suggestions}
      isSearch
    />
  );
}
