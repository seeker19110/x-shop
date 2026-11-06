import type { ReactNode } from "react";
import styles from "./EmptyState.module.css";
import { isNonEmpty } from "../../lib/presence";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Hành động tiếp theo (vd. Button href="/"). */
  action?: ReactNode;
  /** Cấp tiêu đề cho đúng cấu trúc trang; mặc định h2. */
  headingLevel?: 2 | 3;
}

export function EmptyState({ title, description, action, headingLevel = 2 }: EmptyStateProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  // ReactNode "rỗng" (null/undefined/false/""/0) → không dựng khung hành động, như kiểm truthy cũ.
  const hasAction =
    action !== undefined && action !== null && action !== false && action !== "" && action !== 0;
  return (
    <section className={styles.empty}>
      <Heading className={styles.title}>{title}</Heading>
      {isNonEmpty(description) ? <p className={styles.description}>{description}</p> : null}
      {hasAction ? <div className={styles.action}>{action}</div> : null}
    </section>
  );
}
