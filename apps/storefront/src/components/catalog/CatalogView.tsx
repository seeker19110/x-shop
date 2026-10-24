import { activeFilterCount, type CatalogFilter, type FilterParseIssue } from "@x-shop/domain";
import Link from "next/link";
import type { ReactNode } from "react";
import type { ProductListResponse, SearchSuggestion } from "../../lib/catalog/types";
import { categoryHref } from "../../lib/content/navigation";
import { Button } from "../ui/Button";
import { ChipLinks } from "../ui/ChipLinks";
import { EmptyState } from "../ui/EmptyState";
import { InlineError } from "../ui/InlineError";
import styles from "./CatalogView.module.css";
import { FilterDrawer } from "./FilterDrawer";
import { FilterSidebar } from "./FilterSidebar";
import { chipsFor, describeIssues, hrefFor, totalPages, withoutConditions } from "./filter-state";
import { Pagination } from "./Pagination";
import { ScrollRestorer } from "./ScrollRestorer";
import { ProductGrid } from "./ProductGrid";
import { SortForm } from "./SortForm";

export interface CatalogViewProps {
  basePath: string;
  heading: string;
  /** Dòng giới thiệu dưới tiêu đề (tùy chọn). */
  intro?: string;
  /** Ô tìm kiếm (trang /tim-kiem). */
  header?: ReactNode;
  filter: CatalogFilter;
  issues: readonly FilterParseIssue[];
  /** `null` khi không tải được (lỗi nguồn dữ liệu hoặc tham số sai) — trang vẫn hiển thị, giữ điều kiện. */
  result: ProductListResponse | null;
  /** Thông báo lỗi nhẹ khi `result === null`. */
  error?: string | null;
  suggestions?: readonly SearchSuggestion[];
  category?: string | null;
  /** Trang tìm kiếm: từ khóa nằm ở ô tìm, không hiện thành chip. */
  isSearch?: boolean;
}

/** Khung chung của trang danh mục và tìm kiếm: toolbar, chip, lưới, phân trang, trạng thái rỗng/lỗi. */
export function CatalogView({
  basePath,
  heading,
  intro,
  header,
  filter,
  issues,
  result,
  error,
  suggestions,
  category,
  isSearch = false,
}: CatalogViewProps) {
  const chips = chipsFor(basePath, filter, result?.facets, { includeQuery: !isSearch });
  const conditions = activeFilterCount(isSearch ? { ...filter, q: null } : filter);
  const issueMessages = describeIssues(issues);
  const lastPage = result ? totalPages(result.total, result.page_size) : 1;
  const clearAll = hrefFor(basePath, withoutConditions(filter, { keepQuery: isSearch }));

  return (
    <div className={styles.page}>
      <ScrollRestorer />
      <header className={styles.head}>
        <h1>{heading}</h1>
        {intro ? <p className={styles.intro}>{intro}</p> : null}
        {header}
      </header>

      {issueMessages.length > 0 ? (
        <div className={styles.issues} role="alert">
          {issueMessages.map((m) => (
            <InlineError key={m}>{m}</InlineError>
          ))}
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <FilterDrawer
          basePath={basePath}
          applied={filter}
          facets={result?.facets ?? null}
          total={result?.total ?? 0}
          activeCount={conditions}
          category={category}
        />
        <p className={styles.count} aria-live="polite">
          {result ? `${result.total} sản phẩm` : "Chưa có số liệu"}
        </p>
        <SortForm basePath={basePath} filter={filter} />
      </div>

      <ChipLinks items={chips} clearAllHref={clearAll} />

      <div className={styles.layout}>
        <FilterSidebar basePath={basePath} filter={filter} facets={result?.facets ?? null} />
        <section aria-labelledby="ds-san-pham" className={styles.results}>
          <h2 id="ds-san-pham" className="visually-hidden">
            Danh sách sản phẩm
          </h2>
          {result === null ? (
            <div role="alert" className={styles.errorBox}>
              <InlineError>{error ?? "Không tải được danh sách sản phẩm. Vui lòng thử lại."}</InlineError>
              <Button href={hrefFor(basePath, filter)} variant="secondary">
                Thử lại
              </Button>
            </div>
          ) : result.items.length > 0 ? (
            <>
              <ProductGrid items={result.items} priorityCount={2} />
              <Pagination basePath={basePath} filter={filter} lastPage={lastPage} />
            </>
          ) : result.total > 0 ? (
            <EmptyState
              title="Trang này không có sản phẩm"
              description={`Bộ lọc hiện có ${result.total} sản phẩm, trong ${lastPage} trang.`}
              action={<Button href={hrefFor(basePath, { ...filter, page: 1 })}>Về trang 1</Button>}
            />
          ) : (
            <EmptyState
              title="Không tìm thấy sản phẩm phù hợp"
              description={
                chips.length > 0
                  ? "Các điều kiện bạn chọn được giữ nguyên. Gỡ từng điều kiện bên dưới để mở rộng kết quả."
                  : "Hãy thử từ khóa khác hoặc xem các danh mục dưới đây."
              }
              action={
                <div className={styles.noResults}>
                  {chips.length > 0 ? (
                    <ul className={styles.removeList} aria-label="Gỡ điều kiện">
                      {chips.map((c) => (
                        <li key={c.key}>
                          <Link href={c.href} prefetch={false}>
                            {`Bỏ lọc: ${c.label}`}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {suggestions && suggestions.length > 0 ? (
                    <ul className={styles.removeList} aria-label="Danh mục gợi ý">
                      {suggestions.map((s) => (
                        <li key={s.handle}>
                          <Link href={categoryHref(s.handle)} prefetch={false}>
                            {s.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              }
            />
          )}
        </section>
      </div>
    </div>
  );
}
