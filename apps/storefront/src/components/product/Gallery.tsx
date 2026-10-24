"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import type { ProductImage } from "../../lib/catalog/types";
import { Dialog } from "../ui/Dialog";
import styles from "./Product.module.css";

/** Ảnh trong gallery: rộng ~60% ở desktop, 100% ở mobile. */
const GALLERY_SIZES = "(min-width: 64em) 36vw, 100vw";

/**
 * Gallery theo màu. Ảnh đầu `priority` (không lazy, ứng viên LCP), các ảnh sau lazy mặc định của `next/image`.
 * Phóng ảnh: bấm ảnh → `Dialog` (ảnh lớn chỉ được dựng/tải khi mở). Không dùng thư viện carousel/zoom.
 */
export function Gallery({ images }: { images: readonly ProductImage[] }) {
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const zoomed = zoomIndex === null ? null : (images[zoomIndex] ?? null);

  return (
    <div className={styles.gallery}>
      {images.length > 1 ? (
        <p className={styles.swipeHint}>{`Vuốt ngang để xem ${images.length} ảnh`}</p>
      ) : null}
      <ul className={styles.track} aria-label="Ảnh sản phẩm">
        {images.map((img, i) => (
          <li key={img.url} className={styles.slide}>
            <button
              type="button"
              className={styles.zoomButton}
              aria-haspopup="dialog"
              aria-label={`Phóng ảnh ${i + 1}/${images.length}: ${img.alt}`}
              onClick={(e) => {
                openerRef.current = e.currentTarget;
                setZoomIndex(i);
              }}
            >
              <Image
                src={img.url}
                alt={img.alt}
                width={img.width}
                height={img.height}
                sizes={GALLERY_SIZES}
                priority={i === 0}
                fetchPriority={i === 0 ? "high" : undefined}
                className={styles.image}
              />
            </button>
          </li>
        ))}
      </ul>
      <Dialog
        open={zoomed !== null}
        onClose={() => setZoomIndex(null)}
        title="Phóng ảnh"
        returnFocusRef={openerRef}
        closeLabel="Đóng ảnh"
      >
        {zoomed ? (
          <Image
            src={zoomed.url}
            alt={zoomed.alt}
            width={zoomed.width}
            height={zoomed.height}
            sizes="(min-width: 48em) 60vw, 100vw"
            className={styles.zoomImage}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
