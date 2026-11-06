import type { Metadata } from "next";
import Link from "next/link";
import { t } from "../lib/i18n";

export const metadata: Metadata = { title: t("static.notFound.title") };

export default function NotFound() {
  return (
    <section aria-labelledby="tieu-de-404">
      <h1 id="tieu-de-404">{t("static.notFound.title")}</h1>
      <p>{t("static.notFound.description")}</p>
      <p>
        <Link href="/">{t("static.notFound.home")}</Link>
      </p>
    </section>
  );
}
