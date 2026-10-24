import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { preload } from "react-dom";
import { ProductGrid } from "../components/catalog/ProductGrid";
import { Button } from "../components/ui";
import { getMenuCategories, listProducts } from "../lib/catalog/client";
import type { ProductListItem } from "../lib/catalog/types";
import { HOME_CONTENT } from "../lib/content/home";
import { categoryHref } from "../lib/content/navigation";
import { EMPTY_FILTER } from "@x-shop/domain";
import styles from "./home.module.css";

export const revalidate = 60;

async function loadNewArrivals(limit: number): Promise<ProductListItem[]> {
  try {
    return (await listProducts(EMPTY_FILTER, { pageSize: limit })).items;
  } catch {
    return []; // Lỗi nguồn dữ liệu: ẩn khối thay vì hỏng cả trang chủ.
  }
}

export default async function HomePage() {
  const c = HOME_CONTENT;
  const [menu, arrivals] = await Promise.all([getMenuCategories(), loadNewArrivals(c.newArrivals.limit)]);
  // Chỉ hiện danh mục nổi bật CÓ sản phẩm (WEB02: không để khối trống/đường dẫn hỏng).
  const available = new Set(menu.map((m) => m.handle));
  const categories = c.categories.items.filter((i) => available.has(i.handle));

  const common = { alt: "", priority: true, fetchPriority: "high", sizes: "100vw" } as const;
  const desktop = getImageProps({ ...common, ...c.hero.imageDesktop }).props;
  const mobile = getImageProps({ ...common, ...c.hero.imageMobile }).props;
  // Ảnh LCP của hero: preload đúng ảnh theo breakpoint (art direction), không tải cả hai.
  preload(mobile.src, {
    as: "image",
    fetchPriority: "high",
    media: "(max-width: 47.999em)",
    imageSrcSet: mobile.srcSet,
    imageSizes: mobile.sizes,
  });
  preload(desktop.src, {
    as: "image",
    fetchPriority: "high",
    media: "(min-width: 48em)",
    imageSrcSet: desktop.srcSet,
    imageSizes: desktop.sizes,
  });

  return (
    <div className={styles.page}>
      <section aria-labelledby="hero-tieu-de" className={styles.hero}>
        <picture className={styles.heroPicture}>
          <source media="(min-width: 48em)" srcSet={desktop.srcSet ?? desktop.src} />
          <img {...mobile} alt="" className={styles.heroImage} />
        </picture>
        <div className={styles.heroCopy}>
          <h1 id="hero-tieu-de" className={styles.heroTitle}>
            {c.hero.title}
          </h1>
          <p>{c.hero.subtitle}</p>
          <Button href={c.hero.cta.href} size="lg">
            {c.hero.cta.label}
          </Button>
        </div>
      </section>

      {categories.length > 0 ? (
        <section aria-labelledby="muc-danh-muc" className={styles.section}>
          <h2 id="muc-danh-muc">{c.categories.title}</h2>
          <ul className={styles.categoryList}>
            {categories.map((i) => (
              <li key={i.handle}>
                <Link href={categoryHref(i.handle)} className={styles.tile}>
                  <Image
                    src={i.image.src}
                    alt={i.image.alt}
                    width={i.image.width}
                    height={i.image.height}
                    sizes="(min-width: 72em) 25vw, 50vw"
                    className={styles.tileImage}
                  />
                  <span className={styles.tileLabel}>{i.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {arrivals.length > 0 ? (
        <section aria-labelledby="muc-hang-moi" className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 id="muc-hang-moi">{c.newArrivals.title}</h2>
            <Link href={c.newArrivals.href} className={styles.more}>
              {c.newArrivals.linkLabel}
            </Link>
          </div>
          <ProductGrid items={arrivals} />
        </section>
      ) : null}

      <section aria-labelledby="muc-phoi-do" className={styles.section}>
        <h2 id="muc-phoi-do">{c.lookbook.title}</h2>
        <p className={styles.lead}>{c.lookbook.description}</p>
        <ul className={styles.lookList}>
          {c.lookbook.items.map((i) => (
            <li key={i.title}>
              <Link href={i.href} className={styles.tile}>
                <Image
                  src={i.image.src}
                  alt={i.image.alt}
                  width={i.image.width}
                  height={i.image.height}
                  sizes="(min-width: 48em) 33vw, 100vw"
                  className={styles.tileImage}
                />
                <span className={styles.tileLabel}>{i.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="muc-thong-tin" className={styles.section}>
        <h2 id="muc-thong-tin">{c.info.title}</h2>
        <ul className={styles.infoList}>
          {c.info.items.map((i) => (
            <li key={i.title} className={styles.infoItem}>
              <h3>{i.title}</h3>
              <p>{i.text}</p>
              <Link href={i.href}>{i.linkLabel}</Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
