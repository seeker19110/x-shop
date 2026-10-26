/** Tên option native của Medusa dùng cho mô hình thời trang (T-013). Giá trị option là slug (vd "den", "m"). */
export const OPTION_COLOR = "Màu";
export const OPTION_SIZE = "Size";

/** Tiền tệ bán hàng: VND, số nguyên đồng (PRICE01). */
export const CURRENCY = "vnd";

export type FashionKind = "apparel" | "shoes" | "accessory";
export const FASHION_KINDS: readonly FashionKind[] = ["apparel", "shoes", "accessory"];

/**
 * Sự kiện nội bộ yêu cầu đồng bộ lại read model catalog cho một tập sản phẩm (thay đổi ngoài workflow native:
 * thuộc tính thời trang, bảng size, import). Payload: `{ product_ids: string[] }`.
 */
export const CATALOG_PRODUCTS_CHANGED = "x.catalog.products_changed";

/**
 * Số id tối đa mỗi lời gọi `query.graph`/`list*` theo danh sách id của catalog. Phải < 4.000: từ ngưỡng đó Query của
 * Medusa 2.22.1 tự chia lô và làm mất `calculated_price` ở các lô sau (xem `loadVariantPrices`, T-057).
 */
export const QUERY_ID_BATCH = 500;
