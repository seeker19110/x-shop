import type { Metadata } from "next";
import { CatalogView } from "../../../components/catalog/CatalogView";
import { SearchBox } from "../../../components/catalog/SearchBox";
import { CATALOG_PAGE_SIZE } from "../../../lib/catalog/client";
import { loadListing, toQueryString, type RawParams } from "../../../lib/catalog/listing";
import { catalogMetadata } from "../../../lib/seo/catalog-meta";
import { t } from "../../../lib/i18n";
import { isNonEmpty } from "../../../lib/presence";

interface Props {
  searchParams: Promise<RawParams>;
}

const BASE = "/tim-kiem";

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { filter, result } = await loadListing("search", "", toQueryString(await searchParams));
  return catalogMetadata({
    basePath: BASE,
    filter,
    title: isNonEmpty(filter.q) ? t("search.titleWithQuery", { q: filter.q }) : t("search.title"),
    description: t("search.description"),
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
      heading={isNonEmpty(filter.q) ? t("search.headingWithQuery", { q: filter.q }) : t("search.headingAll")}
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
