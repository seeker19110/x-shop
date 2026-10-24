import { getProductFresh } from "../catalog/client";
import type { ProductDetail } from "../catalog/types";
import { resolveDataSource, getServerEnv } from "../env";
import { clearCartId, readCartId, writeCartId } from "./cookie";
import { StoreApiError, storeApi } from "./medusa";
import {
  EMPTY_CART_VIEW,
  MAX_LINES,
  MAX_LINE_QUANTITY,
  type CartActionResult,
  type CartErrorCode,
  type CartView,
} from "./types";
import { buildCartView, CART_FIELDS, type ProductLookup, type RawCart, type RawCartLine } from "./view";

/**
 * Nghiệp vụ giỏ ở server: id giỏ ở cookie HttpOnly, thao tác qua Medusa Store API native (`/store/carts`,
 * `/line-items`). Mỗi thao tác kiểm lại biến thể bằng dữ liệu catalog KHÔNG cache (tồn/giá hiện hành) trước khi ghi.
 */

const fail = (code: CartErrorCode, message: string): CartActionResult => ({ ok: false, code, message });

const DISABLED = fail("CART_DISABLED", "Giỏ hàng chưa khả dụng ở môi trường này. Vui lòng quay lại sau.");
const UNAVAILABLE = fail("UNAVAILABLE", "Không kết nối được máy chủ. Vui lòng thử lại sau ít phút.");

export const cartEnabled = (): boolean => resolveDataSource() === "backend";

/* ------------------------------------------------------------------ đọc */

let regionCache: { id: string; at: number } | null = null;
const REGION_TTL_MS = 10 * 60 * 1000;

/** Region tiền VND (kênh bán gắn theo publishable key). Cache ngắn trong tiến trình. */
export async function getVnRegionId(now = Date.now()): Promise<string> {
  if (regionCache && now - regionCache.at < REGION_TTL_MS) return regionCache.id;
  const { data } = await storeApi<{ regions?: { id: string; currency_code?: string }[] }>("/store/regions");
  const region = (data.regions ?? []).find((r) => r.currency_code?.toLowerCase() === "vnd");
  if (!region) throw new StoreApiError(500, "Chưa cấu hình region VND", "NO_REGION");
  regionCache = { id: region.id, at: now };
  return region.id;
}

export function resetCartServiceCacheForTests(): void {
  regionCache = null;
}

/** Đọc giỏ; không có/đã hoàn tất/id sai → null. Lỗi mạng/5xx → ném. */
export async function fetchRawCart(cartId: string): Promise<RawCart | null> {
  try {
    const { data } = await storeApi<{ cart?: RawCart }>(
      `/store/carts/${encodeURIComponent(cartId)}?fields=${CART_FIELDS}`,
    );
    const cart = data.cart ?? null;
    return cart && !cart.completed_at ? cart : null;
  } catch (e) {
    if (e instanceof StoreApiError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

async function lookupProducts(raw: RawCart): Promise<ProductLookup> {
  const handles = [
    ...new Set((raw.items ?? []).flatMap((i) => (i?.product_handle ? [i.product_handle] : []))),
  ];
  const entries = await Promise.all(
    handles.map(async (h): Promise<[string, ProductDetail | null | undefined]> => {
      try {
        return [h, await getProductFresh(h)];
      } catch {
        return [h, undefined];
      }
    }),
  );
  return new Map(entries);
}

/** Giỏ của phiên hiện tại cho trang giỏ/thanh toán. Không có cookie hoặc backend tắt → giỏ rỗng. */
export async function loadCartView(): Promise<CartView> {
  if (!cartEnabled()) return EMPTY_CART_VIEW;
  const id = await readCartId();
  if (!id) return EMPTY_CART_VIEW;
  const raw = await fetchRawCart(id);
  if (!raw) return EMPTY_CART_VIEW;
  return buildCartView(raw, await lookupProducts(raw), getServerEnv().MEDUSA_BACKEND_URL);
}

/** Tổng số lượng cho badge header; mọi lỗi → 0 (header không được làm hỏng trang). */
export async function loadCartCount(): Promise<number> {
  if (!cartEnabled()) return 0;
  try {
    const id = await readCartId();
    if (!id) return 0;
    const raw = await fetchRawCart(id);
    return countOf(raw);
  } catch {
    return 0;
  }
}

const countOf = (raw: RawCart | null): number =>
  (raw?.items ?? []).reduce(
    (s, i) => s + (Number.isFinite(Number(i?.quantity)) ? Number(i?.quantity) : 0),
    0,
  );

/* ------------------------------------------------------------------ ghi */

async function createCart(): Promise<RawCart> {
  const region_id = await getVnRegionId();
  const { data } = await storeApi<{ cart: RawCart }>("/store/carts", { method: "POST", body: { region_id } });
  await writeCartId(data.cart.id);
  return { ...data.cart, items: data.cart.items ?? [] };
}

async function loadOrCreateCart(): Promise<RawCart> {
  const id = await readCartId();
  const existing = id ? await fetchRawCart(id) : null;
  return existing ?? (await createCart());
}

/** Lỗi Medusa → thông báo người dùng hiểu (hết hàng / chung). */
export function describeStoreError(e: unknown): CartActionResult {
  if (e instanceof StoreApiError) {
    if (e.status === 0 || e.status >= 500) return UNAVAILABLE;
    if (/inventory|stock/i.test(e.message)) {
      return fail("OUT_OF_STOCK", "Số lượng yêu cầu vượt quá tồn kho hiện có. Vui lòng giảm số lượng.");
    }
    if (e.status === 404) return fail("NOT_FOUND", "Không tìm thấy dòng trong giỏ. Hãy tải lại trang.");
  }
  return fail("INVALID_INPUT", "Không cập nhật được giỏ hàng. Vui lòng thử lại.");
}

const ID_RE = /^[\w-]{1,128}$/;

function findLine(cart: RawCart, lineId: string): RawCartLine | undefined {
  return (cart.items ?? []).find((i): i is RawCartLine => i !== null && i.id === lineId);
}

const qtyOf = (l: RawCartLine | undefined): number => (l ? Number(l.quantity) || 0 : 0);

async function ok(cartId: string, message: string): Promise<CartActionResult> {
  const raw = await fetchRawCart(cartId);
  return { ok: true, count: countOf(raw), message };
}

const labelOf = (p: ProductDetail, variantId: string): string => {
  const v = p.variants.find((x) => x.variant_id === variantId);
  if (!v) return p.title;
  const c = p.options.color.find((o) => o.value === v.color)?.label ?? v.color;
  const s = p.options.size.find((o) => o.value === v.size)?.label ?? v.size;
  const opts = [c, s].filter(Boolean).join(", ");
  return opts ? `${p.title} (${opts})` : p.title;
};

/** Kiểm biến thể ở server: sản phẩm còn bán, biến thể thuộc sản phẩm, còn hàng. */
async function checkVariant(
  handle: string,
  variantId: string,
): Promise<{ ok: true; product: ProductDetail } | { ok: false; result: CartActionResult }> {
  let product: ProductDetail | null;
  try {
    product = await getProductFresh(handle);
  } catch {
    return { ok: false, result: UNAVAILABLE };
  }
  if (!product) return { ok: false, result: fail("NOT_FOUND", "Sản phẩm này hiện không còn bán.") };
  const v = product.variants.find((x) => x.variant_id === variantId);
  if (!v)
    return {
      ok: false,
      result: fail("INVALID_INPUT", "Lựa chọn không hợp lệ. Vui lòng chọn lại màu và size."),
    };
  if (!v.in_stock) {
    return {
      ok: false,
      result: fail("OUT_OF_STOCK", "Phiên bản này đã hết hàng. Vui lòng chọn màu/size khác."),
    };
  }
  return { ok: true, product };
}

export async function addItem(input: {
  handle: string;
  variantId: string;
  quantity: number;
}): Promise<CartActionResult> {
  const { handle, variantId, quantity } = input ?? {};
  if (
    typeof handle !== "string" ||
    !/^[\w-]{1,200}$/.test(handle) ||
    typeof variantId !== "string" ||
    !ID_RE.test(variantId) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 10
  ) {
    return fail("INVALID_INPUT", "Lựa chọn không hợp lệ. Vui lòng chọn lại màu và size.");
  }
  if (!cartEnabled()) return DISABLED;
  try {
    const checked = await checkVariant(handle, variantId);
    if (!checked.ok) return checked.result;
    const cart = await loadOrCreateCart();
    const existing = (cart.items ?? []).find((i) => i?.variant_id === variantId) ?? undefined;
    if (!existing && (cart.items ?? []).length >= MAX_LINES) {
      return fail("LIMIT", `Giỏ hàng tối đa ${MAX_LINES} dòng. Hãy xóa bớt trước khi thêm.`);
    }
    if (qtyOf(existing ?? undefined) + quantity > MAX_LINE_QUANTITY) {
      return fail("LIMIT", `Mỗi sản phẩm tối đa ${MAX_LINE_QUANTITY} trong giỏ.`);
    }
    await storeApi(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      body: { variant_id: variantId, quantity },
    });
    return await ok(cart.id, `Đã thêm ${labelOf(checked.product, variantId)} vào giỏ.`);
  } catch (e) {
    return describeStoreError(e);
  }
}

async function withLine(
  lineId: string,
  fn: (cartId: string, line: RawCartLine, cart: RawCart) => Promise<CartActionResult>,
): Promise<CartActionResult> {
  if (typeof lineId !== "string" || !ID_RE.test(lineId))
    return fail("INVALID_INPUT", "Dòng giỏ hàng không hợp lệ.");
  if (!cartEnabled()) return DISABLED;
  try {
    const id = await readCartId();
    const cart = id ? await fetchRawCart(id) : null;
    const line = cart ? findLine(cart, lineId) : undefined;
    if (!cart || !line) return fail("NOT_FOUND", "Không tìm thấy dòng trong giỏ. Hãy tải lại trang.");
    return await fn(cart.id, line, cart);
  } catch (e) {
    return describeStoreError(e);
  }
}

export function setQuantity(lineId: string, quantity: number): Promise<CartActionResult> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    return Promise.resolve(fail("INVALID_INPUT", `Số lượng phải từ 1 đến ${MAX_LINE_QUANTITY}.`));
  }
  return withLine(lineId, async (cartId, line) => {
    await storeApi(`/store/carts/${cartId}/line-items/${encodeURIComponent(line.id)}`, {
      method: "POST",
      body: { quantity },
    });
    return ok(cartId, "Đã cập nhật số lượng.");
  });
}

/** Xóa luôn được phép — kể cả dòng lỗi (SKU ẩn/hết hàng) để người dùng gỡ được. */
export function removeLine(lineId: string): Promise<CartActionResult> {
  return withLine(lineId, async (cartId, line) => {
    await storeApi(`/store/carts/${cartId}/line-items/${encodeURIComponent(line.id)}`, { method: "DELETE" });
    return ok(cartId, "Đã xóa sản phẩm khỏi giỏ.");
  });
}

/** Đổi màu/size = thay biến thể của dòng (thêm biến thể mới với số lượng cũ, rồi gỡ dòng cũ). */
export function changeVariant(lineId: string, variantId: string): Promise<CartActionResult> {
  if (typeof variantId !== "string" || !ID_RE.test(variantId)) {
    return Promise.resolve(fail("INVALID_INPUT", "Lựa chọn không hợp lệ. Vui lòng chọn lại màu và size."));
  }
  return withLine(lineId, async (cartId, line, cart) => {
    if (!line.product_handle) return fail("NOT_FOUND", "Sản phẩm này hiện không còn bán.");
    if (line.variant_id === variantId) return ok(cartId, "Giữ nguyên lựa chọn.");
    const checked = await checkVariant(line.product_handle, variantId);
    if (!checked.ok) return checked.result;
    const target = (cart.items ?? []).find((i) => i?.variant_id === variantId) ?? undefined;
    if (qtyOf(target ?? undefined) + qtyOf(line) > MAX_LINE_QUANTITY) {
      return fail("LIMIT", `Mỗi sản phẩm tối đa ${MAX_LINE_QUANTITY} trong giỏ.`);
    }
    // Thêm trước, gỡ sau: nếu thêm lỗi (hết hàng) dòng cũ còn nguyên.
    await storeApi(`/store/carts/${cartId}/line-items`, {
      method: "POST",
      body: { variant_id: variantId, quantity: qtyOf(line) },
    });
    await storeApi(`/store/carts/${cartId}/line-items/${encodeURIComponent(line.id)}`, { method: "DELETE" });
    return ok(cartId, `Đã đổi sang ${labelOf(checked.product, variantId)}.`);
  });
}

/** Cập nhật giá dòng về giá hiện hành: gỡ rồi thêm lại cùng biến thể/số lượng (sau khi kiểm biến thể còn bán). */
export function refreshLinePrice(lineId: string): Promise<CartActionResult> {
  return withLine(lineId, async (cartId, line) => {
    if (!line.product_handle || !line.variant_id)
      return fail("NOT_FOUND", "Sản phẩm này hiện không còn bán.");
    const checked = await checkVariant(line.product_handle, line.variant_id);
    if (!checked.ok) return checked.result;
    await storeApi(`/store/carts/${cartId}/line-items/${encodeURIComponent(line.id)}`, { method: "DELETE" });
    await storeApi(`/store/carts/${cartId}/line-items`, {
      method: "POST",
      body: { variant_id: line.variant_id, quantity: qtyOf(line) },
    });
    return ok(cartId, "Đã cập nhật giá.");
  });
}

/** Bỏ cookie giỏ sau khi đặt đơn thành công (giỏ mới cho lần mua sau). */
export async function forgetCart(): Promise<void> {
  await clearCartId();
}
