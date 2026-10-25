import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { multiplyVnd, type QuoteBreakdown } from "@x-shop/domain";
import { randomUUID } from "node:crypto";
import { toSafeInteger } from "../../lib/checkout/cart";
import { readCheckoutError } from "../../lib/checkout/errors";
import { acquireOrdered, lockKeys, releaseOwned } from "../../lib/checkout/locks";
import { CHECKOUT_CONFIG } from "../../lib/checkout/config";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { RETURNS_MODULE } from "../../modules/returns";
import { RETURNS_CONFIG } from "../../modules/returns/constants";
import type ReturnsModuleService from "../../modules/returns/service";
import type { SizeChartSnapshot } from "../../modules/returns/service";
import { SHIPPING_MODULE } from "../../modules/shipping";
import type ShippingModuleService from "../../modules/shipping/service";
import type { ShipmentRow } from "../../modules/shipping/service";
import { ReturnsError } from "./errors";

type Scope = Pick<MedusaContainer, "resolve">;

export const returnsOf = (c: Scope) => c.resolve<ReturnsModuleService>(RETURNS_MODULE);
export const checkoutOf = (c: Scope) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
export const shippingOf = (c: Scope) => c.resolve<ShippingModuleService>(SHIPPING_MODULE);

/** Một dòng đơn với số tiền KHÁCH THỰC TRẢ (sau phân bổ giảm giá — PRICE03) — căn cứ tính hoàn. */
export interface OrderLine {
  id: string;
  variant_id: string | null;
  product_id: string | null;
  title: string;
  variant_title: string | null;
  quantity: number;
  unit_price: number;
  /** Thực trả cho cả dòng (quote.lineTotal); đơn thay thế không qua quote → unit_price × quantity. */
  line_total: number;
  size_chart: SizeChartSnapshot | null;
}

export interface OrderFinanceLite {
  id: string;
  order_id: string;
  display_ref: string;
  checkout_attempt_id: string;
  cart_id: string;
  state: string;
  total: number;
  payment_method: string;
  quote: QuoteBreakdown;
  address: unknown;
  contact: unknown;
}

export interface OrderContext {
  fin: OrderFinanceLite;
  lines: OrderLine[];
  shipment: ShipmentRow | null;
  native: {
    region_id: string | null;
    sales_channel_id: string | null;
    currency_code: string;
    customer_id: string | null;
    shipping_address: Record<string, unknown> | null;
  };
}

function sizeChartOf(meta: Record<string, unknown> | null | undefined): SizeChartSnapshot | null {
  const id = meta?.size_chart_id;
  const code = meta?.size_chart_code;
  const version = meta?.size_chart_version;
  return typeof id === "string" && typeof code === "string" && Number.isSafeInteger(version)
    ? { id, code, version: Number(version) }
    : null;
}

/** Đọc đơn: order_finance (snapshot tiền), dòng native + thực trả theo quote, vận đơn. Không có → 404. */
export async function loadOrderContext(container: Scope, orderId: string): Promise<OrderContext> {
  const [fin] = await checkoutOf(container).listOrderFinances({ order_id: orderId });
  if (!fin) throw new ReturnsError("NOT_FOUND", "Không tìm thấy đơn hàng");
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: [
      "id",
      "region_id",
      "sales_channel_id",
      "currency_code",
      "customer_id",
      "shipping_address.*",
      "items.id",
      "items.title",
      "items.product_title",
      "items.variant_title",
      "items.variant_id",
      "items.product_id",
      "items.quantity",
      "items.unit_price",
      "items.metadata",
    ],
    filters: { id: orderId },
  });
  type Item = {
    id: string;
    title?: string | null;
    product_title?: string | null;
    variant_title?: string | null;
    variant_id?: string | null;
    product_id?: string | null;
    quantity?: unknown;
    unit_price?: unknown;
    metadata?: Record<string, unknown> | null;
  };
  const order = data[0] as
    | {
        region_id?: string | null;
        sales_channel_id?: string | null;
        currency_code?: string | null;
        customer_id?: string | null;
        shipping_address?: Record<string, unknown> | null;
        items?: Array<Item | null> | null;
      }
    | undefined;
  if (!order) throw new ReturnsError("NOT_FOUND", "Không tìm thấy đơn hàng");
  const quote = fin.quote as unknown as QuoteBreakdown;
  const quoteLines = new Map((quote?.lines ?? []).map((l) => [l.lineId, l]));
  const lines: OrderLine[] = (order.items ?? [])
    .flatMap((i) => (i ? [i] : []))
    .map((i) => {
      const quantity = toSafeInteger(i.quantity) ?? 0;
      const unitPrice = toSafeInteger(i.unit_price) ?? 0;
      const cartLine = i.metadata?.cart_line_item_id;
      const q = typeof cartLine === "string" ? quoteLines.get(cartLine) : undefined;
      return {
        id: i.id,
        variant_id: i.variant_id ?? null,
        product_id: i.product_id ?? null,
        title: i.product_title ?? i.title ?? "Sản phẩm",
        variant_title: i.variant_title ?? null,
        quantity,
        unit_price: unitPrice,
        line_total: q && q.quantity === quantity ? q.lineTotal : multiplyVnd(unitPrice, quantity),
        size_chart: sizeChartOf(i.metadata),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    fin: {
      id: fin.id,
      order_id: fin.order_id,
      display_ref: fin.display_ref,
      checkout_attempt_id: fin.checkout_attempt_id,
      cart_id: fin.cart_id,
      state: fin.state,
      total: Number(fin.total),
      payment_method: fin.payment_method,
      quote,
      address: fin.address,
      contact: fin.contact,
    },
    lines,
    shipment: await shippingOf(container).shipmentOfOrder(orderId),
    native: {
      region_id: order.region_id ?? null,
      sales_channel_id: order.sales_channel_id ?? null,
      currency_code: (order.currency_code ?? "vnd").toLowerCase(),
      customer_id: order.customer_id ?? null,
      shipping_address: order.shipping_address ?? null,
    },
  };
}

/**
 * Đơn nhận đổi/trả khi đã GIAO THÀNH CÔNG (vận đơn `delivered`, đã đối chiếu API hãng — S-305). Chưa giao → hủy đơn
 * (POST02) chứ không trả hàng; hết hạn chính sách (nếu chủ shop cấu hình) → 409.
 */
export function assertReturnable(ctx: OrderContext, now: Date): void {
  if (!["confirmed", "completed"].includes(ctx.fin.state) || ctx.shipment?.state !== "delivered") {
    throw new ReturnsError("NOT_RETURNABLE", "Chỉ đổi/trả được đơn đã giao thành công", {
      order_state: ctx.fin.state,
      shipment_state: ctx.shipment?.state ?? "unfulfilled",
    });
  }
  const days = RETURNS_CONFIG.returnWindowDays;
  const deliveredAt = ctx.shipment.delivered_at;
  if (days !== null && deliveredAt && now.getTime() > deliveredAt.getTime() + days * 24 * 3600_000) {
    throw new ReturnsError("RETURN_WINDOW_EXPIRED", `Đã quá ${days} ngày kể từ khi nhận hàng`);
  }
}

/** Chạy `fn` dưới khóa `order:<id>` (chung với IPN, hủy, vận đơn); không lấy được trong hạn → 409 BUSY_RETRY. */
export async function withOrderLock<T>(container: Scope, orderId: string, fn: () => Promise<T>): Promise<T> {
  const locking = container.resolve(Modules.LOCKING);
  const owner = `returns:${randomUUID()}`;
  try {
    await acquireOrdered(locking, [lockKeys.order(orderId)], {
      ownerId: owner,
      waitMs: RETURNS_CONFIG.lockWaitMs,
      ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
      scope: "order",
    });
  } catch (e) {
    if (readCheckoutError(e)?.code === "BUSY_RETRY") {
      throw new ReturnsError("BUSY_RETRY", "Đơn đang được xử lý, vui lòng thử lại sau giây lát");
    }
    throw e;
  }
  try {
    return await fn();
  } finally {
    await releaseOwned(locking, owner, null);
  }
}
