import { assetUrl } from "../catalog/backend-map";
import type { ProductDetail } from "../catalog/types";
import { formatVnd } from "../format-vnd";
import type { CartLineView, CartView, LineChoices, LineIssue } from "./types";
import { isNonEmpty } from "../presence";

/** Các trường giỏ lấy từ Medusa Store API (`?fields=`) — chỉ những gì storefront dùng. */
export const CART_FIELDS = [
  "id",
  "currency_code",
  "completed_at",
  "item_subtotal",
  "subtotal",
  "total",
  "items.id",
  "items.title",
  "items.product_title",
  "items.thumbnail",
  "items.quantity",
  "items.variant_id",
  "items.product_handle",
  "items.variant_title",
  "items.unit_price",
  "items.total",
].join(",");

export interface RawCartLine {
  id: string;
  title?: string | null;
  product_title?: string | null;
  thumbnail?: string | null;
  quantity?: unknown;
  variant_id?: string | null;
  product_handle?: string | null;
  variant_title?: string | null;
  unit_price?: unknown;
  total?: unknown;
}

export interface RawCart {
  id: string;
  currency_code?: string | null;
  completed_at?: string | null;
  item_subtotal?: unknown;
  subtotal?: unknown;
  total?: unknown;
  items?: (RawCartLine | null)[] | null;
}

/** Tra cứu sản phẩm theo handle: chi tiết hiện hành, `null` = không còn bán, `undefined` = không kiểm được. */
export type ProductLookup = ReadonlyMap<string, ProductDetail | null | undefined>;

/** Số tiền/số lượng từ JSON → số nguyên không âm (dữ liệu hỏng → 0, không ném làm sập trang giỏ). */
function int(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function labelsOf(p: ProductDetail, color: string, size: string): string {
  const c = p.options.color.find((o) => o.value === color)?.label ?? color;
  const s = p.options.size.find((o) => o.value === size)?.label ?? size;
  return [c, s].filter(Boolean).join(" / ");
}

export function choicesFor(p: ProductDetail, variantId: string | null): LineChoices {
  const current = p.variants.find((v) => v.variant_id === variantId) ?? null;
  return {
    colors: p.options.color.map(({ value, label }) => ({ value, label })),
    sizes: p.options.size.map(({ value, label }) => ({ value, label })),
    variants: p.variants.map((v) => ({
      id: v.variant_id,
      color: v.color,
      size: v.size,
      inStock: v.in_stock,
    })),
    color: current?.color ?? null,
    size: current?.size ?? null,
  };
}

/** Lỗi một dòng theo thứ tự nghiêm trọng (CHK01: ẩn → hết hàng → giá đổi). */
export function issueFor(
  variantId: string | null,
  unitPrice: number,
  detail: ProductDetail | null | undefined,
): LineIssue | null {
  if (detail === undefined) return null; // không kiểm được: backend vẫn kiểm lại lúc báo giá/đặt hàng
  if (detail === null) {
    return { code: "UNAVAILABLE", message: "Sản phẩm này hiện không còn bán. Vui lòng xóa khỏi giỏ." };
  }
  const v = detail.variants.find((x) => x.variant_id === variantId);
  if (!v) {
    return {
      code: "VARIANT_GONE",
      message: "Phiên bản này không còn bán. Hãy chọn màu/size khác hoặc xóa khỏi giỏ.",
    };
  }
  if (!v.in_stock) {
    return {
      code: "OUT_OF_STOCK",
      message: "Phiên bản này đã hết hàng. Hãy chọn màu/size khác hoặc xóa khỏi giỏ.",
    };
  }
  if (v.price !== unitPrice) {
    return {
      code: "PRICE_CHANGED",
      message: `Giá đã thay đổi từ ${formatVnd(unitPrice)} thành ${formatVnd(v.price)}. Hãy cập nhật giá để tiếp tục.`,
    };
  }
  return null;
}

export function buildCartView(raw: RawCart | null, lookup: ProductLookup, backendBase: string): CartView {
  if (!raw || isNonEmpty(raw.completed_at)) return { lines: [], itemCount: 0, subtotal: 0, blocked: false };
  const lines: CartLineView[] = (raw.items ?? []).flatMap((it): CartLineView[] => {
    if (!it) return [];
    const handle = it.product_handle ?? null;
    const detail = isNonEmpty(handle) ? lookup.get(handle) : undefined;
    const unitPrice = int(it.unit_price);
    const variantId = it.variant_id ?? null;
    const variant = detail?.variants.find((v) => v.variant_id === variantId);
    const title = it.product_title ?? it.title ?? "Sản phẩm";
    return [
      {
        id: it.id,
        variantId,
        handle,
        title,
        variantLabel:
          variant && detail ? labelsOf(detail, variant.color, variant.size) : (it.variant_title ?? null),
        thumbnail: isNonEmpty(it.thumbnail) ? { url: assetUrl(it.thumbnail, backendBase), alt: title } : null,
        unitPrice,
        quantity: int(it.quantity),
        lineTotal: int(it.total),
        issue: issueFor(variantId, unitPrice, detail),
        choices: detail ? choicesFor(detail, variantId) : null,
      },
    ];
  });
  const sumLines = lines.reduce((s, l) => s + l.lineTotal, 0);
  return {
    lines,
    itemCount: lines.reduce((s, l) => s + l.quantity, 0),
    // Tạm tính do server trả; chỉ khi thiếu hẳn mới cộng các dòng (cũng là số server tính từng dòng).
    subtotal:
      raw.item_subtotal != null
        ? int(raw.item_subtotal)
        : raw.subtotal != null
          ? int(raw.subtotal)
          : sumLines,
    blocked: lines.some((l) => l.issue !== null),
  };
}
