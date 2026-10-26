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
  return (
    <section className={styles.empty}>
      <Heading className={styles.title}>{title}</Heading>
      {isNonEmpty(description) ? <p className={styles.description}>{description}</p> : null}
      {action !== undefined && action !== null ? <div className={styles.action}>{action}</div> : null}
    </section>
  );
}
