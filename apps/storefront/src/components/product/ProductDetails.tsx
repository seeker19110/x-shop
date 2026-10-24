import type { ProductDetail } from "../../lib/catalog/types";
import styles from "./Product.module.css";

/** Chất liệu / thành phần / co giãn / form / bảo quản / xuất xứ (PDP04). Trường không có dữ liệu thì KHÔNG hiện (không bịa). */
export function attributeRows(p: ProductDetail): Array<[label: string, value: string]> {
  const a = p.attributes;
  const rows: Array<[string, string | null]> = [
    ["Chất liệu", a.material],
    ["Thành phần", a.composition],
    ["Độ co giãn", a.stretch],
    ["Form", a.fit],
    ["Bảo quản", a.care],
    ["Xuất xứ", a.origin],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null && r[1].trim() !== "");
}

export function ProductDetails({ product }: { product: ProductDetail }) {
  const rows = attributeRows(product);
  return (
    <section aria-labelledby="chi-tiet-san-pham" className={styles.details}>
      <h2 id="chi-tiet-san-pham">Chi tiết sản phẩm</h2>
      {product.description ? <p>{product.description}</p> : null}
      {rows.length > 0 ? (
        <dl className={styles.attrs}>
          {rows.map(([label, value]) => (
            <div key={label} className={styles.attrRow}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
