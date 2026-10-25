import { Select } from "@medusajs/ui";
import type { ReactNode } from "react";

const ALL = "__all__";

export interface FilterOption {
  value: string;
  label: string;
}

/** Ô lọc một giá trị; "" = tất cả (Radix không cho giá trị rỗng nên ánh xạ sang hằng nội bộ). */
export function FilterSelect(props: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <div className="flex w-44 flex-col gap-y-1">
      <span className="txt-compact-small text-ui-fg-subtle">{props.label}</span>
      <Select
        size="small"
        value={props.value === "" ? ALL : props.value}
        onValueChange={(v) => props.onChange(v === ALL ? "" : v)}
      >
        <Select.Trigger>
          <Select.Value />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value={ALL}>Tất cả</Select.Item>
          {props.options.map((o) => (
            <Select.Item key={o.value} value={o.value}>
              {o.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select>
    </div>
  );
}
