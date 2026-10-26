import type { ReactNode } from "react";
import { InlineError } from "../ui/InlineError";
import styles from "./Checkout.module.css";
import { isNonEmpty } from "../../lib/presence";

export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
}

export interface FieldProps {
  /** Tên trường — dùng dựng id ổn định: `f-<name>`, gợi ý `f-<name>-goi-y`, lỗi `f-<name>-loi`. */
  name: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** Nhãn thật + gợi ý + lỗi gắn trường qua `aria-describedby` (CHK05, S-504). */
export function Field({ name, label, required = false, hint, error, children }: FieldProps) {
  const id = `f-${name}`;
  const hintId = isNonEmpty(hint) ? `${id}-goi-y` : null;
  const errId = isNonEmpty(error) ? `${id}-loi` : null;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {required ? null : <span className={styles.optional}> (không bắt buộc)</span>}
      </label>
      {isNonEmpty(hint) ? (
        <p id={hintId ?? undefined} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {children({
        id,
        "aria-describedby": describedBy,
        "aria-invalid": isNonEmpty(error) ? true : undefined,
      })}
      {isNonEmpty(error) ? <InlineError id={errId ?? undefined}>{error}</InlineError> : null}
    </div>
  );
}
