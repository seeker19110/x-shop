import { Text } from "@medusajs/ui";
import { useState, type ReactNode } from "react";
import { checkCsvFile } from "../lib/csv-file";
import { isNonEmpty } from "../lib/presence";

/** Chọn file CSV, kiểm đuôi/cỡ ngay, đọc nội dung UTF-8 (server kiểm lại). Báo `null` khi bỏ chọn/không hợp lệ. */
export function CsvPicker(props: {
  label: string;
  maxBytes: number;
  disabled?: boolean;
  onText: (picked: { name: string; text: string } | null) => void;
}): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-y-1">
      <label className="txt-compact-small text-ui-fg-subtle">
        {props.label}
        <input
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          disabled={props.disabled}
          className="txt-compact-small mt-1 block"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            setProblem(null);
            if (!file) return props.onText(null);
            const bad = checkCsvFile(file, props.maxBytes);
            if (bad !== null) {
              setProblem(bad);
              return props.onText(null);
            }
            props.onText({ name: file.name, text: await file.text() });
          }}
        />
      </label>
      {isNonEmpty(problem) && <Text className="text-ui-fg-error">{problem}</Text>}
    </div>
  );
}
