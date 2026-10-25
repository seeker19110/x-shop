import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { POLICY_PAGES, POLICY_PENDING_NOTICE, type PolicyPageContent } from "../../lib/content/site";
import styles from "./PolicyPage.module.css";

export function policyContent(slug: PolicyPageContent["slug"]): PolicyPageContent {
  const page = POLICY_PAGES.find((p) => p.slug === slug);
  if (!page) notFound();
  return page;
}

export function policyMetadata(slug: PolicyPageContent["slug"]): Metadata {
  const page = policyContent(slug);
  return { title: page.title, description: page.description, alternates: { canonical: `/${slug}` } };
}

/** Trang chính sách tĩnh: nội dung giữ chỗ + cảnh báo rõ ràng cho tới khi chủ shop duyệt. */
export function PolicyPage({ slug }: { slug: PolicyPageContent["slug"] }) {
  const page = policyContent(slug);
  return (
    <article className={styles.article} aria-labelledby="tieu-de-chinh-sach">
      <h1 id="tieu-de-chinh-sach">{page.title}</h1>
      <p role="note" className={styles.warning}>
        <strong>Chưa chính thức.</strong> {POLICY_PENDING_NOTICE}
      </p>
      {page.sections.map((s) => (
        <section key={s.heading} className={styles.section}>
          <h2>{s.heading}</h2>
          <p>{s.text}</p>
        </section>
      ))}
    </article>
  );
}
