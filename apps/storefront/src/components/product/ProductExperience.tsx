"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { track } from "../../lib/analytics/track";
import { addToCart } from "../../lib/cart/actions";
import { emitCartChanged } from "../../lib/cart/events";
import type { ProductDetail, ProductVariant } from "../../lib/catalog/types";
import { PDP_SUMMARY } from "../../lib/content/site";
import { Button } from "../ui/Button";
import { ColorSwatchGroup } from "../ui/ColorSwatch";
import { InlineError } from "../ui/InlineError";
import { Price } from "../ui/Price";
import { SizeSelector } from "../ui/SizeSelector";
import { Gallery } from "./Gallery";
import styles from "./Product.module.css";
import { SizeChartDialog, modelSentence } from "./SizeChartDialog";
import { StickyCta } from "./StickyCta";
import {
  colorInStock,
  ctaFor,
  findVariant,
  galleryFor,
  modelFor,
  priceFor,
  replaceVariantUrl,
  selectColor,
  sizeOptionsFor,
  type Selection,
} from "./selection";
import { formatVnd } from "../../lib/format-vnd";

export interface ProductExperienceProps {
  product: ProductDetail;
  /** Lựa chọn ban đầu đã giải từ `?color=&size=` ở server (HTML đầu tiên đã đúng biến thể). */
  initial: Selection;
  /** Chi tiết (chất liệu, bảo quản…) dựng ở server, đặt sau khối mua. */
  children?: ReactNode;
}

/** Mục sự kiện: `item_id` = handle (khớp danh sách/giỏ), `sku` khi đã chọn đủ biến thể; không tên/PII. */
function trackItem(product: ProductDetail, variant: ProductVariant | null, quantity?: number) {
  return [
    {
      item_id: product.handle,
      ...(variant ? { sku: variant.sku, price: variant.price } : {}),
      ...(quantity ? { quantity } : {}),
    },
  ];
}

/**
 * Gallery + khối mua. Client component duy nhất của PDP (giữ JS gọn): chọn màu/size, giá theo SKU, CTA, sticky CTA,
 * bảng size. Dữ liệu và chi tiết tĩnh là Server Component truyền vào.
 */
export function ProductExperience({ product, initial, children }: ProductExperienceProps) {
  const [sel, setSel] = useState<Selection>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [cartError, setCartError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [chartOpen, setChartOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const buyRef = useRef<HTMLDivElement>(null);
  const chartOpenerRef = useRef<HTMLElement | null>(null);

  const cta = ctaFor(product, sel);
  const price = priceFor(product, sel);
  const model = modelFor(product, sel.color);
  const hasSizes = product.options.size.length > 0;

  useEffect(() => {
    track({ event: "view_item", items: trackItem(product, findVariant(product, initial)) });
    // Một lần mỗi lần mở trang sản phẩm.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy lại theo khoá ổn định đã liệt kê; thêm phụ thuộc còn lại gây lặp/gửi trùng sự kiện
  }, [product.handle]);

  const update = (next: Selection) => {
    setSel(next);
    replaceVariantUrl(next);
    const v = findVariant(product, next);
    track({ event: "select_variant", items: trackItem(product, v) });
  };

  const onColor = (color: string) => {
    const r = selectColor(product, sel, color);
    update(r.selection);
    setNotice(r.notice);
    setSizeError(null);
    setCartError(null);
  };

  const onSize = (size: string) => {
    update({ ...sel, size });
    setNotice(null);
    setSizeError(null);
    setCartError(null);
  };

  const focusSizes = () => {
    const box = buyRef.current;
    box?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    box?.querySelector<HTMLElement>("[data-size-group] [aria-pressed]")?.focus({ preventScroll: true });
  };

  const onCta = () => {
    if (cta.kind === "choose-size") {
      const msg = "Vui lòng chọn size trước khi thêm vào giỏ.";
      setSizeError(msg);
      setNotice(msg);
      focusSizes();
      return;
    }
    if (cta.kind !== "add" || !cta.variant) return;
    const chosen = cta.variant;
    const variantId = chosen.variant_id;
    setCartError(null);
    setAdded(false);
    startTransition(async () => {
      const r = await addToCart({ handle: product.handle, variantId, quantity: 1 });
      if (!r.ok) {
        setCartError(r.message);
        return;
      }
      // Thông báo qua vùng aria-live (không chuyển focus) + cập nhật số ở header.
      setNotice(r.message);
      setAdded(true);
      track({
        event: "add_to_cart",
        value: chosen.price,
        items: trackItem(product, chosen, 1),
      });
      emitCartChanged(r.count);
    });
  };

  const colorOptions = product.options.color.map((c) => ({
    value: c.value,
    name: c.label,
    hex: c.hex,
    available: colorInStock(product, c.value),
  }));

  return (
    <div className={styles.root}>
      <Gallery images={galleryFor(product, sel.color)} />

      <div className={styles.info}>
        <div ref={buyRef} className={styles.buy}>
          <h1 className={styles.title}>{product.title}</h1>
          <p className={styles.price}>
            <Price current={price.current} max={price.max} original={price.original} />
          </p>

          <ColorSwatchGroup options={colorOptions} value={sel.color} onChange={onColor} />

          {hasSizes ? (
            <div data-size-group>
              <SizeSelector
                options={sizeOptionsFor(product, sel.color)}
                value={sel.size}
                onChange={onSize}
                error={sizeError}
                onSizeGuide={
                  product.size_chart
                    ? () => {
                        chartOpenerRef.current =
                          document.activeElement instanceof HTMLElement ? document.activeElement : null;
                        setChartOpen(true);
                        track({ event: "view_size_guide", items: trackItem(product, null) });
                      }
                    : undefined
                }
              />
            </div>
          ) : null}
          {model ? <p className={styles.modelNote}>{modelSentence(model)}</p> : null}

          {/* Vùng aria-live luôn có trong DOM để thông báo (vd. AT02) được đọc khi nội dung đổi. */}
          <p role="status" aria-live="polite" className={styles.notice}>
            {notice}
          </p>

          <Button
            size="lg"
            fullWidth
            loading={pending}
            disabled={cta.disabled}
            onClick={onCta}
            data-cta={cta.kind}
          >
            {cta.label}
          </Button>
          {cartError ? <InlineError alert>{cartError}</InlineError> : null}
          {added ? (
            <p className={styles.notice}>
              <Link href="/gio-hang" prefetch={false}>
                Xem giỏ hàng
              </Link>
            </p>
          ) : null}

          <ul className={styles.summary} aria-label="Giao hàng và đổi trả">
            {PDP_SUMMARY.map((s) => (
              <li key={s.title}>
                <strong>{s.title}.</strong> {s.text}{" "}
                <Link href={s.href} prefetch={false}>
                  {s.linkLabel}
                </Link>
              </li>
            ))}
          </ul>
        </div>

        {children}
      </div>

      <StickyCta
        target={buyRef}
        label={cta.label}
        priceLabel={price.max !== null ? `Từ ${formatVnd(price.current)}` : formatVnd(price.current)}
        disabled={cta.disabled}
        loading={pending}
        onClick={onCta}
      />

      {product.size_chart ? (
        <SizeChartDialog
          open={chartOpen}
          onClose={() => setChartOpen(false)}
          chart={product.size_chart}
          model={model}
          returnFocusRef={chartOpenerRef}
        />
      ) : null}
    </div>
  );
}
