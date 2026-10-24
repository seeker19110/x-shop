import Image from "next/image";
import Link from "next/link";
import { Swatch, type SwatchOption } from "../ui/ColorSwatch";
import { Price, discountPercent } from "../ui/Price";
import styles from "./ProductCard.module.css";

export const PRODUCT_CARD_MAX_SWATCHES = 5;

/** Lưới 2/3/4 cột theo token --grid-cols (breakpoint 48em / 72em). */
export const PRODUCT_CARD_IMAGE_SIZES = "(min-width: 72em) 25vw, (min-width: 48em) 33vw, 50vw";

export interface ProductCardImage {
  src: string;
  /** Mô tả ảnh có ý nghĩa (vd. "Áo thun cotton màu đen, mặt trước"). */
  alt: string;
}

export interface ProductCardProps {
  slug: string;
  name: string;
  image: ProductCardImage;
  /** Ảnh thứ hai chỉ hiện khi hover trên thiết bị có hover; trang trí. */
  hoverImage?: { src: string };
  /** Giá hiện tại, hoặc giá thấp nhất khi có `maxPrice`. */
  price: number;
  maxPrice?: number | null;
  originalPrice?: number | null;
  colors?: readonly SwatchOption[];
  soldOut?: boolean;
  /** true cho thẻ đầu trang (LCP). */
  priority?: boolean;
}

/** Thẻ sản phẩm: một link chính (tên) phủ toàn thẻ, không lồng link. */
export function ProductCard({
  slug,
  name,
  image,
  hoverImage,
  price,
  maxPrice,
  originalPrice,
  colors = [],
  soldOut = false,
  priority = false,
}: ProductCardProps) {
  const isRange = maxPrice != null && maxPrice > price;
  const pct = soldOut || isRange ? null : discountPercent(price, originalPrice);
  const shown = colors.slice(0, PRODUCT_CARD_MAX_SWATCHES);
  const more = colors.length - shown.length;

  return (
    <article className={styles.card}>
      <div className={styles.media}>
        <Image
          src={image.src}
          alt={image.alt}
          fill
          sizes={PRODUCT_CARD_IMAGE_SIZES}
          priority={priority}
          className={styles.image}
        />
        {hoverImage ? (
          <Image
            src={hoverImage.src}
            alt=""
            fill
            sizes={PRODUCT_CARD_IMAGE_SIZES}
            className={styles.hoverImage}
          />
        ) : null}
        {soldOut ? <span className={styles.badge}>Hết hàng</span> : null}
        {pct !== null ? <span className={`${styles.badge} ${styles.sale}`}>Giảm {pct}%</span> : null}
      </div>
      <div className={styles.info}>
        <h3 className={styles.name}>
          <Link href={`/san-pham/${encodeURIComponent(slug)}`} prefetch={false} className={styles.link}>
            {name}
          </Link>
        </h3>
        <Price current={price} max={maxPrice} original={originalPrice} />
        {shown.length > 0 ? (
          <ul className={styles.swatches} aria-label="Màu có sẵn">
            {shown.map((c) => (
              <li key={c.value} className={styles.swatchItem}>
                <span role="img" aria-label={c.name} className={styles.swatchItem}>
                  <Swatch option={c} className={styles.swatch} />
                </span>
              </li>
            ))}
            {more > 0 ? (
              <li className={styles.more}>
                <span aria-hidden="true">+{more}</span>
                <span className="visually-hidden">{`và ${more} màu khác`}</span>
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </article>
  );
}
