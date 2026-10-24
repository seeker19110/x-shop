import type { ProductListItem } from "../../lib/catalog/types";
import { ProductCard } from "../product-card/ProductCard";

/** Lưới thẻ sản phẩm (2/3/4 cột theo token). `priorityCount` thẻ đầu nạp ưu tiên (ảnh LCP của trang). */
export function ProductGrid({
  items,
  priorityCount = 0,
}: {
  items: readonly ProductListItem[];
  priorityCount?: number;
}) {
  return (
    <ul className="product-grid">
      {items.map((p, i) => (
        <li key={p.product_id}>
          <ProductCard
            slug={p.handle}
            name={p.title}
            image={{ src: p.thumbnail.url, alt: p.thumbnail.alt }}
            price={p.price_min}
            maxPrice={p.price_max}
            originalPrice={p.compare_at_max}
            colors={p.colors.map((c) => ({ value: c.value, name: c.label, hex: c.hex }))}
            soldOut={!p.in_stock}
            priority={i < priorityCount}
          />
        </li>
      ))}
    </ul>
  );
}
