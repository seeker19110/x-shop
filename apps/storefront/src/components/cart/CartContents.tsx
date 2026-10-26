"use client";

import Image from "next/image";
import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import {
  changeLineVariant,
  refreshCartLine,
  removeCartLine,
  updateLineQuantity,
} from "../../lib/cart/actions";
import { emitCartChanged } from "../../lib/cart/events";
import {
  MAX_LINE_QUANTITY,
  type CartActionResult,
  type CartLineView,
  type CartView,
} from "../../lib/cart/types";
import { formatVnd } from "../../lib/format-vnd";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { InlineError } from "../ui/InlineError";
import styles from "./Cart.module.css";
import { isNonEmpty } from "../../lib/presence";

export interface CartContentsProps {
  cart: CartView;
}

function productHref(line: CartLineView): string {
  if (!isNonEmpty(line.handle)) return "/";
  const qs = new URLSearchParams();
  const c = line.choices;
  if (c && isNonEmpty(c.color)) qs.set("color", c.color);
  if (c && isNonEmpty(c.size)) qs.set("size", c.size);
  const q = qs.toString();
  return `/san-pham/${encodeURIComponent(line.handle)}${q ? `?${q}` : ""}`;
}

/**
 * Nội dung giỏ: số lượng, đổi màu/size, xóa, lỗi từng dòng (CHK01). Tổng tạm tính luôn là số server đã tính — sau mỗi
 * thao tác trang được dựng lại từ server (revalidate), client không tự cộng tiền. Lỗi một dòng hiện NGAY tại dòng đó
 * và không ảnh hưởng dòng khác; chỉ nút thanh toán bị chặn tới khi xử lý.
 */
export function CartContents({ cart }: CartContentsProps) {
  const [pending, startTransition] = useTransition();
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  const run = (
    lineId: string,
    op: () => Promise<CartActionResult>,
    opts: { focusHeading?: boolean } = {},
  ) => {
    setBusyLine(lineId);
    startTransition(async () => {
      const r = await op();
      setBusyLine(null);
      if (!r.ok) {
        setLineErrors((e) => ({ ...e, [lineId]: r.message }));
        return;
      }
      setLineErrors((e) => Object.fromEntries(Object.entries(e).filter(([id]) => id !== lineId)));
      setAnnounce(r.message);
      emitCartChanged(r.count);
      if (opts.focusHeading === true) headingRef.current?.focus();
    });
  };

  const setLineError = (lineId: string, message: string) =>
    setLineErrors((e) => ({ ...e, [lineId]: message }));

  if (cart.lines.length === 0) {
    return (
      <EmptyState
        title="Giỏ hàng của bạn đang trống"
        description="Hãy chọn sản phẩm bạn thích, chúng tôi sẽ giữ giỏ cho bạn."
        action={<Button href="/tim-kiem">Tiếp tục mua sắm</Button>}
      />
    );
  }

  const issueCount = cart.lines.filter((l) => l.issue).length;

  return (
    <div className={styles.layout}>
      <section aria-labelledby="gio-hang-tieu-de" className={styles.lines}>
        <h1 id="gio-hang-tieu-de" ref={headingRef} tabIndex={-1} className={styles.title}>
          {`Giỏ hàng (${cart.itemCount})`}
        </h1>
        <p role="status" aria-live="polite" className="visually-hidden">
          {announce}
        </p>
        <ul className={styles.list}>
          {cart.lines.map((line) => {
            const busy = pending && busyLine === line.id;
            const errId = `loi-${line.id}`;
            const msg = lineErrors[line.id];
            const describedBy = [line.issue ? `${errId}-van-de` : null, isNonEmpty(msg) ? errId : null]
              .filter(Boolean)
              .join(" ");
            const c = line.choices;
            const sizesForColor = c
              ? c.sizes.filter((s) => c.variants.some((v) => v.color === c.color && v.size === s.value))
              : [];
            return (
              <li
                key={line.id}
                className={styles.line}
                data-line-id={line.id}
                data-issue={line.issue?.code}
                aria-busy={busy || undefined}
                aria-describedby={describedBy || undefined}
              >
                <div className={styles.thumb}>
                  {line.thumbnail ? (
                    <Image src={line.thumbnail.url} alt={line.thumbnail.alt} width={96} height={120} />
                  ) : null}
                </div>
                <div className={styles.info}>
                  <p className={styles.name}>
                    {isNonEmpty(line.handle) ? (
                      <Link href={productHref(line)}>{line.title}</Link>
                    ) : (
                      line.title
                    )}
                  </p>
                  {isNonEmpty(line.variantLabel) ? (
                    <p className={styles.variant}>{line.variantLabel}</p>
                  ) : null}
                  <p className={styles.unit}>{formatVnd(line.unitPrice)}</p>

                  {c && c.colors.length > 0 && c.sizes.length > 0 ? (
                    <div className={styles.choices}>
                      <label>
                        <span className={styles.fieldLabel}>Màu</span>
                        <select
                          className={styles.select}
                          value={c.color ?? ""}
                          disabled={busy}
                          onChange={(e) => {
                            const color = e.target.value;
                            const target = c.variants.find((v) => v.color === color && v.size === c.size);
                            if (!target) {
                              const name = c.colors.find((x) => x.value === color)?.label ?? color;
                              const sz = c.sizes.find((x) => x.value === c.size)?.label ?? "";
                              setLineError(
                                line.id,
                                `Màu ${name} không có size ${sz} — vui lòng chọn lại size.`,
                              );
                              return;
                            }
                            run(line.id, () => changeLineVariant(line.id, target.id));
                          }}
                        >
                          {c.color === null ? <option value="">Chọn màu</option> : null}
                          {c.colors.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        <span className={styles.fieldLabel}>Size</span>
                        <select
                          className={styles.select}
                          value={c.size ?? ""}
                          disabled={busy}
                          onChange={(e) => {
                            const target = c.variants.find(
                              (v) => v.color === c.color && v.size === e.target.value,
                            );
                            if (target) run(line.id, () => changeLineVariant(line.id, target.id));
                          }}
                        >
                          {c.size === null ? <option value="">Chọn size</option> : null}
                          {sizesForColor.map((o) => {
                            const v = c.variants.find((x) => x.color === c.color && x.size === o.value);
                            return (
                              <option
                                key={o.value}
                                value={o.value}
                                disabled={v?.inStock === false && o.value !== c.size}
                              >
                                {v?.inStock === false ? `${o.label} (hết hàng)` : o.label}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                    </div>
                  ) : null}

                  <div className={styles.qtyRow}>
                    <div role="group" aria-label={`Số lượng ${line.title}`} className={styles.qty}>
                      <button
                        type="button"
                        className={styles.qtyBtn}
                        aria-label={`Giảm số lượng ${line.title}`}
                        disabled={busy || line.quantity <= 1}
                        onClick={() => run(line.id, () => updateLineQuantity(line.id, line.quantity - 1))}
                      >
                        <span aria-hidden="true">−</span>
                      </button>
                      <span className={styles.qtyValue}>{line.quantity}</span>
                      <button
                        type="button"
                        className={styles.qtyBtn}
                        aria-label={`Tăng số lượng ${line.title}`}
                        disabled={busy || line.quantity >= MAX_LINE_QUANTITY}
                        onClick={() => run(line.id, () => updateLineQuantity(line.id, line.quantity + 1))}
                      >
                        <span aria-hidden="true">+</span>
                      </button>
                    </div>
                    <button
                      type="button"
                      className={styles.remove}
                      disabled={busy}
                      onClick={() => run(line.id, () => removeCartLine(line.id), { focusHeading: true })}
                    >
                      Xóa<span className="visually-hidden">{` ${line.title}`}</span>
                    </button>
                  </div>

                  {line.issue ? (
                    <div className={styles.issue}>
                      <InlineError id={`${errId}-van-de`}>{line.issue.message}</InlineError>
                      {line.issue.code === "PRICE_CHANGED" ? (
                        <Button
                          variant="secondary"
                          loading={busy}
                          onClick={() => run(line.id, () => refreshCartLine(line.id))}
                        >
                          Cập nhật giá
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {isNonEmpty(msg) ? (
                    <InlineError id={errId} alert>
                      {msg}
                    </InlineError>
                  ) : null}
                </div>
                <p className={styles.lineTotal}>{formatVnd(line.lineTotal)}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <aside aria-labelledby="tom-tat-tieu-de" className={styles.summary}>
        <h2 id="tom-tat-tieu-de" className={styles.summaryTitle}>
          Tóm tắt
        </h2>
        <dl className={styles.totals}>
          <div>
            <dt>Tạm tính</dt>
            <dd>{formatVnd(cart.subtotal)}</dd>
          </div>
        </dl>
        <p className={styles.note}>Phí vận chuyển và mã giảm giá được tính ở bước thanh toán.</p>
        {cart.blocked ? (
          <>
            <Button fullWidth size="lg" disabled aria-describedby="chan-thanh-toan">
              Thanh toán
            </Button>
            <InlineError id="chan-thanh-toan">
              {`Có ${issueCount} sản phẩm cần xử lý (đổi phiên bản, cập nhật giá hoặc xóa) trước khi thanh toán.`}
            </InlineError>
          </>
        ) : (
          <Button fullWidth size="lg" href="/thanh-toan">
            Thanh toán
          </Button>
        )}
        <p className={styles.note}>Mua không cần tài khoản.</p>
      </aside>
    </div>
  );
}
