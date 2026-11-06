import type { ProductDetail } from "../../lib/catalog/types";
import { t } from "../../lib/i18n";
import styles from "./Product.module.css";

/** Chất liệu / thành phần / co giãn / form / bảo quản / xuất xứ (PDP04). Trường không có dữ liệu thì KHÔNG hiện (không bịa). */
export function attributeRows(p: ProductDetail): Array<[label: string, value: string]> {
  const a = p.attributes;
  const rows: Array<[string, string | null]> = [
    [t("product.details.material"), a.material],
    [t("product.details.composition"), a.composition],
    [t("product.details.stretch"), a.stretch],
    [t("product.details.fit"), a.fit],
    [t("product.details.care"), a.care],
    [t("product.details.origin"), a.origin],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null && r[1].trim() !== "");
}

export function ProductDetails({ product }: { product: ProductDetail }) {
  const rows = attributeRows(product);
  return (
    <section aria-labelledby="chi-tiet-san-pham" className={styles.details}>
      <h2 id="chi-tiet-san-pham">{t("product.details.heading")}</h2>
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
