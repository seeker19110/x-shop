import type { ModelMeasurement, ProductDetail, ProductImage, ProductVariant } from "../../lib/catalog/types";

/**
 * Logic chọn biến thể của PDP — hàm thuần, không phụ thuộc React (test được từng ca; dùng chung cho gallery, giá, CTA,
 * URL và JSON-LD để UI/structured data không lệch nhau).
 */

export interface Selection {
  color: string | null;
  size: string | null;
}

type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | null =>
  (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase() || null;

export function colorLabel(p: ProductDetail, value: string): string {
  return p.options.color.find((c) => c.value === value)?.label ?? value;
}

export function sizeLabel(p: ProductDetail, value: string): string {
  return p.options.size.find((s) => s.value === value)?.label ?? value.toUpperCase();
}

export function findVariant(p: ProductDetail, sel: Selection): ProductVariant | null {
  if (sel.color === null || sel.size === null) return null;
  return p.variants.find((v) => v.color === sel.color && v.size === sel.size) ?? null;
}

export function colorInStock(p: ProductDetail, color: string): boolean {
  return p.variants.some((v) => v.color === color && v.in_stock);
}

/**
 * Lựa chọn ban đầu từ URL (`?color=&size=`, S-506): màu/size lạ bị bỏ; tổ hợp không tồn tại → bỏ size (không đoán).
 * Không có màu hợp lệ → màu đầu tiên còn hàng (hoặc màu đầu). Biến thể hết hàng vẫn được mở đúng (CTA "Hết hàng").
 */
export function initialSelection(p: ProductDetail, params: Params = {}): Selection {
  const wantedColor = first(params.color);
  const color = p.options.color.some((c) => c.value === wantedColor)
    ? wantedColor
    : (p.options.color.find((c) => colorInStock(p, c.value))?.value ?? p.options.color[0]?.value ?? null);
  const wantedSize = first(params.size);
  const size =
    color !== null &&
    wantedSize !== null &&
    p.variants.some((v) => v.color === color && v.size === wantedSize)
      ? wantedSize
      : null;
  return { color, size };
}

/**
 * Đổi màu (AT02/S-501). Size đang chọn không có ở màu mới → BỎ chọn size + thông báo (aria-live), KHÔNG tự chọn size khác.
 * Có nhưng hết hàng cũng bỏ (nút size hết hàng không chọn được — S-502).
 */
export function selectColor(
  p: ProductDetail,
  sel: Selection,
  color: string,
): { selection: Selection; notice: string | null } {
  if (sel.size === null) return { selection: { color, size: null }, notice: null };
  const v = p.variants.find((x) => x.color === color && x.size === sel.size);
  if (v?.in_stock) return { selection: { color, size: sel.size }, notice: null };
  const c = colorLabel(p, color);
  const s = sizeLabel(p, sel.size);
  return {
    selection: { color, size: null },
    notice: v
      ? `Size ${s} đã hết hàng ở màu ${c} — vui lòng chọn lại size`
      : `Màu ${c} không có size ${s} — vui lòng chọn lại size`,
  };
}

export interface SizeChoice {
  value: string;
  label: string;
  available: boolean;
}

/** Nút size theo màu đang chọn: còn hàng = có SKU (màu, size) và `in_stock`. */
export function sizeOptionsFor(p: ProductDetail, color: string | null): SizeChoice[] {
  return p.options.size.map((s) => ({
    value: s.value,
    label: s.label,
    available: p.variants.some((v) => v.color === color && v.size === s.value && v.in_stock),
  }));
}

export interface PriceView {
  current: number;
  max: number | null;
  original: number | null;
}

/** Giá theo SKU đang chọn; chưa chọn đủ → khoảng giá các SKU còn khớp (không quảng cáo giá thấp nhất như giá của SKU khác). */
export function priceFor(p: ProductDetail, sel: Selection): PriceView {
  const exact = findVariant(p, sel);
  if (exact) return { current: exact.price, max: null, original: exact.compare_at };
  const pool = p.variants.filter(
    (v) => (sel.color === null || v.color === sel.color) && (sel.size === null || v.size === sel.size),
  );
  const list = pool.length > 0 ? pool : p.variants;
  const prices = list.map((v) => v.price);
  const current = Math.min(...prices);
  const max = Math.max(...prices);
  const same = list.every((v) => v.price === list[0]!.price && v.compare_at === list[0]!.compare_at);
  return { current, max: max > current ? max : null, original: same ? list[0]!.compare_at : null };
}

export type CtaKind = "choose-color" | "choose-size" | "sold-out" | "add";

export interface Cta {
  kind: CtaKind;
  label: string;
  /** Hết hàng: không bấm được. "Chọn size" vẫn bấm được để chỉ ra chỗ cần chọn. */
  disabled: boolean;
  variant: ProductVariant | null;
}

/** CTA phản ánh đúng tình trạng (PDP05): "Chọn size" / "Hết hàng" / "Thêm vào giỏ". */
export function ctaFor(p: ProductDetail, sel: Selection): Cta {
  if (sel.color === null) {
    return { kind: "choose-color", label: "Chọn màu", disabled: false, variant: null };
  }
  const variant = findVariant(p, sel);
  if (variant) {
    return variant.in_stock
      ? { kind: "add", label: "Thêm vào giỏ", disabled: false, variant }
      : { kind: "sold-out", label: "Hết hàng", disabled: true, variant };
  }
  // Chưa chọn size: cả màu đã hết hàng thì nói thẳng "Hết hàng" thay vì bắt chọn size vô ích.
  if (!colorInStock(p, sel.color))
    return { kind: "sold-out", label: "Hết hàng", disabled: true, variant: null };
  return { kind: "choose-size", label: "Chọn size", disabled: false, variant: null };
}

/** Ảnh của màu đang chọn (+ ảnh dùng chung); không có ảnh theo màu → toàn bộ ảnh. */
export function galleryFor(p: ProductDetail, color: string | null): ProductImage[] {
  const own = p.images.filter((i) => i.color === null || i.color === color);
  return own.length > 0 ? own : p.images;
}

export function modelFor(p: ProductDetail, color: string | null): ModelMeasurement | null {
  return p.model_measurements.find((m) => m.image_set === color) ?? null;
}

/** `color=den&size=m` (chỉ phần đã chọn). */
export function variantQuery(sel: Selection): string {
  const q = new URLSearchParams();
  if (sel.color !== null) q.set("color", sel.color);
  if (sel.size !== null) q.set("size", sel.size);
  return q.toString();
}

/** Cập nhật URL theo lựa chọn mà không thêm lịch sử và không tải lại (history.replaceState tích hợp router của Next). */
export function replaceVariantUrl(sel: Selection): void {
  const qs = variantQuery(sel);
  const url = `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`;
  window.history.replaceState(window.history.state, "", url);
}
