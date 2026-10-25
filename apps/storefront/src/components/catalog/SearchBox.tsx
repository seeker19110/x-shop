import { MAX_QUERY_LENGTH } from "@x-shop/domain";
import { SearchCombobox } from "./SearchCombobox";

/** Ô tìm kiếm của trang /tim-kiem: server truyền giới hạn độ dài từ domain; phần tương tác ở `SearchCombobox`. */
export function SearchBox({ defaultValue }: { defaultValue: string | null }) {
  return <SearchCombobox defaultValue={defaultValue} maxLength={MAX_QUERY_LENGTH} />;
}
