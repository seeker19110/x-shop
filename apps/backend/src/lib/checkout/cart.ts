import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { payloadHash, isNonEmpty } from "@x-shop/domain";
import { CheckoutError } from "./errors";

/**
 * Đọc giỏ native cho checkout + kiểm quyền sở hữu (đặc tả §9.1 "kiểm tra quyền sở hữu"; S-checkout ca biên "khách A
 * dùng cart_id của B → 404, không lộ tồn tại").
 */
export interface CheckoutCartLine {
  id: string;
  variant_id: string | null;
  product_id: string | null;
  title: string;
  quantity: number;
  weight_grams: number | null;
  manage_inventory: boolean;
  allow_backorder: boolean;
  product_published: boolean;
  inventory: Array<{ inventory_item_id: string; required_quantity: number }>;
}

export interface CheckoutCart {
  id: string;
  region_id: string | null;
  currency_code: string;
  sales_channel_id: string | null;
  customer_id: string | null;
  customer_has_account: boolean;
  completed_at: string | Date | null;
  items: CheckoutCartLine[];
}

export interface CartAccessContext {
  /** Kênh bán của publishable key gửi kèm request (Medusa đã xác thực key). */
  salesChannelIds: readonly string[];
  /** customer id đã xác thực (phiên/bearer); null = khách vãng lai. Không nhận customer_id từ body. */
  actorId: string | null;
}

/** Số lượng native (bigNumber) → số nguyên an toàn; khác → null. */
export function toSafeInteger(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string" && value.trim() !== "") n = Number(value);
  else if (typeof value === "object" && value !== null && "numeric" in value) {
    n = Number((value as { numeric: unknown }).numeric);
  } else return null;
  return Number.isSafeInteger(n) ? n : null;
}

const CART_FIELDS = [
  "id",
  "region_id",
  "currency_code",
  "sales_channel_id",
  "customer_id",
  "completed_at",
  "customer.has_account",
  "items.id",
  "items.title",
  "items.quantity",
  "items.variant_id",
  "items.product_id",
  "items.variant.id",
  "items.variant.weight",
  "items.variant.manage_inventory",
  "items.variant.allow_backorder",
  "items.variant.product.status",
  "items.variant.inventory_items.inventory_item_id",
  "items.variant.inventory_items.required_quantity",
];

interface RawCartItem {
  id: string;
  title?: string | null;
  quantity?: unknown;
  variant_id?: string | null;
  product_id?: string | null;
  variant?: {
    id?: string;
    weight?: unknown;
    manage_inventory?: boolean | null;
    allow_backorder?: boolean | null;
    product?: { status?: string | null } | null;
    inventory_items?: Array<{ inventory_item_id?: string | null; required_quantity?: unknown } | null> | null;
  } | null;
}

interface RawCart {
  id: string;
  region_id?: string | null;
  currency_code?: string | null;
  sales_channel_id?: string | null;
  customer_id?: string | null;
  completed_at?: string | Date | null;
  customer?: { has_account?: boolean | null } | null;
  items?: Array<RawCartItem | null> | null;
}

/** Đọc giỏ (không cache — luôn đọc DB). Không có → null. */
export async function loadCheckoutCart(
  container: MedusaContainer,
  cartId: string,
): Promise<CheckoutCart | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({ entity: "cart", fields: CART_FIELDS, filters: { id: cartId } });
  const raw = (data as RawCart[])[0];
  if (!raw) return null;
  const items: CheckoutCartLine[] = (raw.items ?? []).flatMap((it) => {
    if (!it) return [];
    const quantity = toSafeInteger(it.quantity);
    if (quantity === null) {
      throw new CheckoutError("VALIDATION", "Số lượng trong giỏ không hợp lệ", {
        field: `items.${it.id}.quantity`,
      });
    }
    const weight = toSafeInteger(it.variant?.weight);
    return [
      {
        id: it.id,
        variant_id: it.variant_id ?? null,
        product_id: it.product_id ?? null,
        title: it.title ?? "",
        quantity,
        weight_grams: weight,
        manage_inventory: it.variant?.manage_inventory === true,
        allow_backorder: it.variant?.allow_backorder === true,
        product_published: it.variant?.product?.status === "published",
        inventory: (it.variant?.inventory_items ?? []).flatMap((link) => {
          const req = toSafeInteger(link?.required_quantity) ?? 1;
          return link && isNonEmpty(link.inventory_item_id)
            ? [{ inventory_item_id: link.inventory_item_id, required_quantity: req }]
            : [];
        }),
      },
    ];
  });
  // Thứ tự dòng ổn định theo id (Medusa trả theo thứ tự tạo nhưng không cam kết).
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    id: raw.id,
    region_id: raw.region_id ?? null,
    currency_code: (raw.currency_code ?? "").toLowerCase(),
    sales_channel_id: raw.sales_channel_id ?? null,
    customer_id: raw.customer_id ?? null,
    customer_has_account: raw.customer?.has_account === true,
    completed_at: raw.completed_at ?? null,
    items,
  };
}

/**
 * Quyền dùng giỏ cho checkout. Mọi trường hợp không được phép đều trả CÙNG lỗi 404 như giỏ không tồn tại.
 * - giỏ đã hoàn tất native → 404 (không checkout lại giỏ đã thành đơn bằng đường khác);
 * - kênh bán của giỏ không thuộc publishable key → 404;
 * - giỏ gắn khách có tài khoản → chỉ chính khách đó (đã đăng nhập) dùng được;
 * - người đã đăng nhập dùng giỏ gắn khách khác → 404.
 */
export function assertCartAccess(
  cart: CheckoutCart | null,
  ctx: CartAccessContext,
): asserts cart is CheckoutCart {
  const notFound = () => new CheckoutError("NOT_FOUND");
  if (!cart || isNonEmpty(cart.completed_at)) throw notFound();
  if (!isNonEmpty(cart.sales_channel_id) || !ctx.salesChannelIds.includes(cart.sales_channel_id))
    throw notFound();
  if (isNonEmpty(cart.customer_id)) {
    if (ctx.actorId !== null && ctx.actorId !== cart.customer_id) throw notFound();
    if (ctx.actorId === null && cart.customer_has_account) throw notFound();
  }
}

/** Dấu vân tay nội dung giỏ — thay đổi dòng/biến thể/số lượng/region/tiền tệ/kênh bán → khác (cart version). */
export function cartFingerprint(cart: CheckoutCart): string {
  return payloadHash({
    region_id: cart.region_id,
    currency_code: cart.currency_code,
    sales_channel_id: cart.sales_channel_id,
    items: cart.items.map((i) => ({ id: i.id, variant_id: i.variant_id, quantity: i.quantity })),
  });
}
