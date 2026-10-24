import type { CatalogFilter } from "@x-shop/domain";
import type { FacetValue, Facets } from "../../lib/catalog/types";
import styles from "./Filters.module.css";

export interface FilterFieldsProps {
  /** Tiền tố id để hai bản (sidebar, drawer) cùng tồn tại trên trang không trùng id. */
  idPrefix: string;
  facets: Facets | null;
  value: CatalogFilter;
  /**
   * Có → trường được điều khiển (drawer: giữ lựa chọn NHÁP trong state, chưa đổi URL).
   * Không có → trường không điều khiển, gửi bằng `<form method="get">` (sidebar chạy được khi không có JS).
   */
  onChange?: (next: CatalogFilter) => void;
}

type ListKey = "colors" | "sizes" | "materials";

function toggle(list: string[], v: string, on: boolean): string[] {
  const next = on ? [...list, v] : list.filter((x) => x !== v);
  return [...new Set(next)].sort();
}

function parseVnd(raw: string, prev: number | null): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : prev;
}

export function FilterFields({ idPrefix, facets, value, onChange }: FilterFieldsProps) {
  const group = (legend: string, name: string, key: ListKey, values: FacetValue[] | undefined) => {
    if (!values || values.length === 0) return null;
    return (
      <fieldset className={styles.group}>
        <legend className={styles.legend}>{legend}</legend>
        <ul className={styles.options}>
          {values.map((f) => {
            const checked = value[key].includes(f.value);
            const id = `${idPrefix}-${name}-${f.value}`;
            return (
              <li key={f.value}>
                <label htmlFor={id} className={styles.option}>
                  <input
                    id={id}
                    type="checkbox"
                    name={name}
                    value={f.value}
                    {...(onChange
                      ? {
                          checked,
                          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                            onChange({ ...value, [key]: toggle(value[key], f.value, e.target.checked) }),
                        }
                      : { defaultChecked: checked })}
                  />
                  <span>{f.label}</span>
                  <span className={styles.count}>({f.count})</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    );
  };

  const priceProps = (name: "priceMin" | "priceMax") =>
    onChange
      ? {
          value: value[name] ?? "",
          onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
            onChange({ ...value, [name]: parseVnd(e.target.value, value[name]) }),
        }
      : { defaultValue: value[name] ?? "" };

  return (
    <div className={styles.fields}>
      {group("Màu", "color", "colors", facets?.color)}
      {group("Size", "size", "sizes", facets?.size)}
      {group("Chất liệu", "material", "materials", facets?.material)}
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Giá (₫)</legend>
        <div className={styles.price}>
          <label htmlFor={`${idPrefix}-price-min`} className={styles.priceField}>
            <span>Từ</span>
            <input
              id={`${idPrefix}-price-min`}
              className={styles.input}
              type="number"
              name="price_min"
              inputMode="numeric"
              min={0}
              step={1000}
              {...priceProps("priceMin")}
            />
          </label>
          <label htmlFor={`${idPrefix}-price-max`} className={styles.priceField}>
            <span>Đến</span>
            <input
              id={`${idPrefix}-price-max`}
              className={styles.input}
              type="number"
              name="price_max"
              inputMode="numeric"
              min={0}
              step={1000}
              {...priceProps("priceMax")}
            />
          </label>
        </div>
      </fieldset>
      <label htmlFor={`${idPrefix}-in-stock`} className={styles.option}>
        <input
          id={`${idPrefix}-in-stock`}
          type="checkbox"
          name="in_stock"
          value="1"
          {...(onChange
            ? {
                checked: value.inStock,
                onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
                  onChange({ ...value, inStock: e.target.checked }),
              }
            : { defaultChecked: value.inStock })}
        />
        <span>Chỉ hiện còn hàng</span>
      </label>
    </div>
  );
}
