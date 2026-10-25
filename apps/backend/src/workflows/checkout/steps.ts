import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, generateEntityId, Modules } from "@medusajs/framework/utils";
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { diffQuotes, orderMachine, vnpay, type AddressSnapshot, type QuoteBreakdown } from "@x-shop/domain";
import { randomInt } from "node:crypto";
import { cartFingerprint, loadCheckoutCart, toSafeInteger, type CheckoutCart } from "../../lib/checkout/cart";
import {
  NO_SIZE_CHART,
  sizeChartsOfProducts,
  type LineSizeChart,
} from "../../lib/catalog/size-chart-snapshot";
import { CHECKOUT_CONFIG, getVnpayConfig } from "../../lib/checkout/config";
import { CheckoutError } from "../../lib/checkout/errors";
import { acquireOrdered, isLockUnavailable, lockKeys, releaseOwnedQuietly } from "../../lib/checkout/locks";
import { buildQuote, presentQuote, type LoadedDiscount } from "../../lib/checkout/quote";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type { PaymentMethod } from "../../modules/checkout/models/constants";
import type CheckoutModuleService from "../../modules/checkout/service";

export interface CheckoutContact {
  name: string;
  phone: string;
  email: string | null;
}

export interface SubmitCheckoutInput {
  attempt_id: string;
  cart_id: string;
  cart_version: number;
  quote_id: string;
  payment_method: PaymentMethod;
  contact: CheckoutContact;
  address: AddressSnapshot;
  /** Khách đã đăng nhập sở hữu giỏ (đã kiểm ở route); null = khách vãng lai — không tạo/gộp customer theo email. */
  customer_id: string | null;
  ip: string;
}

const checkoutService = (container: MedusaContainer) =>
  container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
const lockingOf = (container: MedusaContainer) => container.resolve(Modules.LOCKING);
const causeOf = (e: unknown) =>
  e instanceof Error && e.cause instanceof Error ? e.cause.message : String(e);

/** Lấy khóa checkout; hạ tầng khóa hỏng → ghi log nguyên nhân gốc (chỉ phía server) rồi ném `LOCK_UNAVAILABLE`. */
async function acquireCheckoutLocks(
  container: MedusaContainer,
  ownerId: string,
  keys: Iterable<string>,
  scope: string,
): Promise<string[]> {
  try {
    return await acquireOrdered(lockingOf(container), keys, {
      ownerId,
      waitMs: CHECKOUT_CONFIG.lockWaitMs,
      ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
      scope,
    });
  } catch (e) {
    if (isLockUnavailable(e)) {
      container
        .resolve(ContainerRegistrationKeys.LOGGER)
        .error(`[checkout] hạ tầng khóa không dùng được (${scope}), dừng submit ${ownerId}: ${causeOf(e)}`);
    }
    throw e;
  }
}

/**
 * Nhả khóa không ném: dùng ở bù trừ và sau khi đơn đã chốt. Redis mất lúc này thì khóa tự hết hạn theo TTL (đã ngừng gia
 * hạn) — ném lỗi ở đây sẽ làm bù trừ dừng giữa chừng hoặc kéo đổ một đơn đã chốt đúng.
 */
async function releaseLocksSafely(
  container: MedusaContainer,
  ownerId: string,
  keys: readonly string[] | null,
): Promise<void> {
  const error = await releaseOwnedQuietly(lockingOf(container), ownerId, keys);
  if (error) {
    container
      .resolve(ContainerRegistrationKeys.LOGGER)
      .warn(`[checkout] không nhả được khóa của ${ownerId} (tự hết hạn sau TTL): ${causeOf(error)}`);
  }
}

/* ---------------------------------------------------------------- khóa (bước 4) */

/**
 * Lấy khóa giỏ/tồn kho. Redis mất → `LOCK_UNAVAILABLE` (503) trước khi đọc tồn/giữ hàng: không bán bằng tồn đọc ngoài
 * khóa, không có khóa in-memory thay thế (đặc tả §13.2).
 */
export const acquireCheckoutLocksStep = createStep(
  "x-checkout-acquire-locks",
  async (input: { owner_id: string; keys: string[]; scope: string }, { container }) => {
    const held = await acquireCheckoutLocks(container, input.owner_id, input.keys, input.scope);
    return new StepResponse(held, { owner_id: input.owner_id, keys: held });
  },
  async (data, { container }) => {
    if (!data || data.keys.length === 0) return;
    await releaseLocksSafely(container, data.owner_id, data.keys);
  },
);

export const releaseCheckoutLocksStep = createStep(
  "x-checkout-release-locks",
  async (input: { owner_id: string }, { container }) => {
    await releaseLocksSafely(container, input.owner_id, null);
    return new StepResponse(true);
  },
);

/* ---------------------------------------------------------------- đọc lại + so quote (bước 5) */

export interface InventoryRequirement {
  line_item_id: string;
  variant_id: string;
  inventory_item_id: string;
  quantity: number;
  allow_backorder: boolean;
}

export interface PreparedCheckout {
  now: string;
  cart: Pick<CheckoutCart, "id" | "region_id" | "currency_code" | "sales_channel_id">;
  /** `size_chart`: bảng size (đúng phiên bản) gắn với sản phẩm lúc đặt — chụp vào dòng đơn (ADM03, T-027). */
  lines: Array<{
    id: string;
    variant_id: string;
    title: string;
    quantity: number;
    size_chart: LineSizeChart;
  }>;
  breakdown: QuoteBreakdown;
  discount: LoadedDiscount | null;
  shipping_service: string;
  requirements: InventoryRequirement[];
  location_ids: string[];
  inventory_lock_keys: string[];
}

/**
 * Đọc lại giỏ, phiên bản giỏ, quote đã xác nhận, giá/mã/phí hiện hành → `computeQuote` → `diffQuotes`. Khác → lỗi 409
 * kèm quote MỚI đã lưu để khách xác nhận lại (AT03, CHK04). Chạy dưới khóa giỏ.
 */
export const prepareCheckoutStep = createStep(
  "x-checkout-prepare",
  async (input: SubmitCheckoutInput, { container }) => {
    const service = checkoutService(container);
    const now = new Date();
    const cart = await loadCheckoutCart(container, input.cart_id);
    if (!cart || cart.completed_at) throw new CheckoutError("NOT_FOUND");

    const current = await service.currentCartVersion(cart.id);
    if (!current || current.version !== input.cart_version || current.fingerprint !== cartFingerprint(cart)) {
      throw new CheckoutError("CART_CHANGED", undefined, {
        detail: { current_cart_version: current?.version ?? null },
      });
    }

    const [stored] = await service.listCheckoutQuotes({ id: input.quote_id, cart_id: cart.id });
    if (!stored)
      throw new CheckoutError("VALIDATION", "Báo giá không hợp lệ cho giỏ này", { field: "quote_id" });
    if (stored.cart_version !== input.cart_version) throw new CheckoutError("CART_CHANGED");
    if (now.getTime() >= new Date(stored.expires_at).getTime()) throw new CheckoutError("QUOTE_EXPIRED");

    const built = await buildQuote(container, cart, input.address, stored.discount_code ?? null, now);
    const change = diffQuotes(stored.breakdown as unknown as QuoteBreakdown, built.breakdown);
    if (change !== null) {
      const fresh = await service.createCheckoutQuotes({
        cart_id: cart.id,
        cart_version: input.cart_version,
        payment_method: input.payment_method,
        discount_code: stored.discount_code ?? null,
        address: input.address as unknown as Record<string, unknown>,
        breakdown: built.breakdown as unknown as Record<string, unknown>,
        total: built.breakdown.total,
        expires_at: new Date(now.getTime() + CHECKOUT_CONFIG.quoteTtlMs),
      });
      throw new CheckoutError(change, undefined, {
        detail: {
          quote: presentQuote({
            ...fresh,
            discount_code: fresh.discount_code ?? null,
            breakdown: built.breakdown,
            address: input.address,
          }),
        },
      });
    }

    const requirements: InventoryRequirement[] = cart.items.flatMap((l) =>
      l.manage_inventory
        ? l.inventory.map((inv) => ({
            line_item_id: l.id,
            variant_id: l.variant_id as string,
            inventory_item_id: inv.inventory_item_id,
            quantity: inv.required_quantity * l.quantity,
            allow_backorder: l.allow_backorder,
          }))
        : [],
    );
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data: channels } = await query.graph({
      entity: "sales_channel",
      fields: ["id", "stock_locations.id"],
      filters: { id: cart.sales_channel_id as string },
    });
    const locationIds = (
      (channels[0] as { stock_locations?: Array<{ id?: string } | null> } | undefined)?.stock_locations ?? []
    )
      .flatMap((l) => (l?.id ? [l.id] : []))
      .sort();

    const sizeCharts = await sizeChartsOfProducts(
      container,
      cart.items.flatMap((l) => (l.product_id ? [l.product_id] : [])),
    );

    const prepared: PreparedCheckout = {
      now: now.toISOString(),
      cart: {
        id: cart.id,
        region_id: cart.region_id,
        currency_code: cart.currency_code,
        sales_channel_id: cart.sales_channel_id,
      },
      lines: cart.items.map((l) => ({
        id: l.id,
        variant_id: l.variant_id as string,
        title: l.title,
        quantity: l.quantity,
        size_chart: (l.product_id && sizeCharts.get(l.product_id)) || NO_SIZE_CHART,
      })),
      breakdown: built.breakdown,
      discount: built.discount,
      shipping_service: built.shipping.service,
      requirements,
      location_ids: locationIds,
      inventory_lock_keys: requirements.map((r) => lockKeys.inventoryItem(r.inventory_item_id)),
    };
    return new StepResponse(prepared);
  },
);

/* ---------------------------------------------------------------- kiểm tồn (bước 6) */

export interface StockAllocation {
  line_item_id: string;
  inventory_item_id: string;
  location_id: string;
  quantity: number;
  allow_backorder: boolean;
}

/**
 * available = stocked − reserved tại location bán của kênh (§6.2 bước 2). Chạy dưới khóa `inventory_item:*`. Mỗi
 * inventory item được giữ trọn ở MỘT location (location đầu tiên theo id còn đủ hàng) — thiếu → 409 INSUFFICIENT_STOCK.
 */
export const checkStockStep = createStep(
  "x-checkout-check-stock",
  async (input: { requirements: InventoryRequirement[]; location_ids: string[] }, { container }) => {
    if (input.requirements.length === 0) return new StepResponse([] as StockAllocation[]);
    const inventory = container.resolve(Modules.INVENTORY);
    const itemIds = [...new Set(input.requirements.map((r) => r.inventory_item_id))];
    const levels =
      input.location_ids.length === 0
        ? []
        : await inventory.listInventoryLevels({
            inventory_item_id: itemIds,
            location_id: input.location_ids,
          });
    const available = new Map<string, Map<string, number>>();
    for (const lv of levels) {
      const stocked = toSafeInteger(lv.stocked_quantity) ?? 0;
      const reserved = toSafeInteger(lv.reserved_quantity) ?? 0;
      const byLoc = available.get(lv.inventory_item_id) ?? new Map<string, number>();
      byLoc.set(lv.location_id, stocked - reserved);
      available.set(lv.inventory_item_id, byLoc);
    }
    const needed = new Map<string, { quantity: number; backorder: boolean }>();
    for (const r of input.requirements) {
      const cur = needed.get(r.inventory_item_id) ?? { quantity: 0, backorder: true };
      needed.set(r.inventory_item_id, {
        quantity: cur.quantity + r.quantity,
        backorder: cur.backorder && r.allow_backorder,
      });
    }
    const chosen = new Map<string, string>();
    const short: Array<{ line_item_id: string; variant_id: string; requested: number; available: number }> =
      [];
    for (const [itemId, need] of needed) {
      const byLoc = available.get(itemId) ?? new Map<string, number>();
      const loc = input.location_ids.find(
        (l) => byLoc.has(l) && (need.backorder || (byLoc.get(l) ?? 0) >= need.quantity),
      );
      if (loc) {
        chosen.set(itemId, loc);
        continue;
      }
      const best = Math.max(0, ...[...byLoc.values()]);
      for (const r of input.requirements.filter((x) => x.inventory_item_id === itemId)) {
        short.push({
          line_item_id: r.line_item_id,
          variant_id: r.variant_id,
          requested: r.quantity,
          available: best,
        });
      }
    }
    if (short.length > 0)
      throw new CheckoutError("INSUFFICIENT_STOCK", undefined, { detail: { lines: short } });
    return new StepResponse(
      input.requirements.map<StockAllocation>((r) => ({
        line_item_id: r.line_item_id,
        inventory_item_id: r.inventory_item_id,
        location_id: chosen.get(r.inventory_item_id) as string,
        quantity: r.quantity,
        allow_backorder: r.allow_backorder,
      })),
    );
  },
);

/* ---------------------------------------------------------------- mã giảm (bước 7) */

/** Đếm held+used dưới khóa `promotion:<code>`; còn lượt → giữ (held). Bù trừ: released (AT33). */
export const holdCouponStep = createStep(
  "x-checkout-hold-coupon",
  async (input: { attempt_id: string; discount: LoadedDiscount | null }, { container }) => {
    const d = input.discount;
    if (!d) return new StepResponse(false, null);
    const service = checkoutService(container);
    const owner = `${input.attempt_id}:promotion`;
    await acquireCheckoutLocks(container, owner, [lockKeys.promotion(d.code)], "promotion");
    try {
      if (d.limit !== null && (await service.countCountedCouponUsage(d.code)) >= d.limit) {
        throw new CheckoutError("DISCOUNT_EXHAUSTED", undefined, { field: "discount_code" });
      }
      await service.holdCoupon({
        promotion_code: d.code,
        promotion_id: d.promotion_id,
        attempt_id: input.attempt_id,
      });
    } finally {
      await releaseLocksSafely(container, owner, null);
    }
    return new StepResponse(true, { attempt_id: input.attempt_id });
  },
  async (data, { container }) => {
    if (!data) return;
    await checkoutService(container).releaseCouponHold(data.attempt_id);
  },
);

/* ---------------------------------------------------------------- tạo đơn native (bước 8) */

export interface VerifiedOrder {
  order_id: string;
  /** cart line item id → order line item id */
  line_map: Record<string, string>;
}

/**
 * Bất biến sau `createOrderWorkflow`: tổng đơn native = tổng quote (khuyến mãi tự động của Medusa hay thuế không được
 * làm lệch tiền phải thu); mỗi dòng giỏ đúng một dòng đơn. Lệch → lỗi, workflow bù trừ (xoá đơn).
 */
export const verifyNativeOrderStep = createStep(
  "x-checkout-verify-native-order",
  async (input: { order_id: string; expected_total: number; line_ids: string[] }, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "order",
      fields: ["id", "total", "items.id", "items.metadata"],
      filters: { id: input.order_id },
    });
    const order = data[0] as
      | {
          id: string;
          total?: unknown;
          items?: Array<{ id: string; metadata?: Record<string, unknown> | null } | null>;
        }
      | undefined;
    if (!order) throw new CheckoutError("INTERNAL", "Không đọc lại được đơn vừa tạo");
    const total = toSafeInteger(order.total);
    const lineMap: Record<string, string> = {};
    for (const it of order.items ?? []) {
      const cartLine = it?.metadata?.cart_line_item_id;
      if (it && typeof cartLine === "string") lineMap[cartLine] = it.id;
    }
    const missing = input.line_ids.filter((id) => !lineMap[id]);
    if (total !== input.expected_total || missing.length > 0) {
      throw new CheckoutError("INTERNAL", "Đơn tạo ra lệch với báo giá — đã hủy, vui lòng thử lại", {
        detail: { native_total: total, quote_total: input.expected_total, missing_lines: missing },
      });
    }
    return new StepResponse<VerifiedOrder>({ order_id: order.id, line_map: lineMap });
  },
);

/* ---------------------------------------------------------------- order_finance (bước 8) */

const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function newDisplayRef(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `XS-${s}`;
}

export const createOrderFinanceStep = createStep(
  "x-checkout-create-order-finance",
  async (
    input: {
      order_id: string;
      attempt_id: string;
      cart_id: string;
      payment_method: PaymentMethod;
      breakdown: QuoteBreakdown;
      address: AddressSnapshot;
      contact: CheckoutContact;
    },
    { container },
  ) => {
    const service = checkoutService(container);
    for (let i = 0; i < 5; i++) {
      const ref = newDisplayRef();
      const id = await service.insertOrderFinance({
        order_id: input.order_id,
        display_ref: ref,
        checkout_attempt_id: input.attempt_id,
        cart_id: input.cart_id,
        total: input.breakdown.total,
        payment_method: input.payment_method,
        policy_version: CHECKOUT_CONFIG.policyVersion,
        quote: input.breakdown,
        address: input.address,
        contact: input.contact,
      });
      if (id) return new StepResponse({ display_ref: ref }, { order_id: input.order_id });
    }
    throw new CheckoutError("INTERNAL", "Không sinh được mã đơn, vui lòng thử lại");
  },
  async (data, { container }) => {
    if (!data) return;
    await checkoutService(container).discardPreparingOrderFinance(data.order_id);
  },
);

/* ---------------------------------------------------------------- thời hạn + thanh toán (bước 9–10) */

export interface Deadlines {
  order_state: "placed" | "awaiting_payment";
  hold_expires_at: string | null;
  cod_confirm_by: string | null;
}

export function computeDeadlines(method: PaymentMethod, nowIso: string): Deadlines {
  const now = new Date(nowIso).getTime();
  if (method === "cod") {
    return {
      order_state: "placed",
      hold_expires_at: null,
      cod_confirm_by: new Date(now + CHECKOUT_CONFIG.codConfirmMs).toISOString(),
    };
  }
  return {
    order_state: "awaiting_payment",
    hold_expires_at: new Date(now + CHECKOUT_CONFIG.onlineHoldMs).toISOString(),
    cod_confirm_by: null,
  };
}

/**
 * VNPAY: payment_attempt (txn_ref PA_<ulid>) + URL đã ký, vnp_ExpireDate = hold_expires_at, vnp_ReturnUrl kèm
 * `?attempt=<checkout attempt id>`. COD: không làm gì.
 */
export const createPaymentAttemptStep = createStep(
  "x-checkout-create-payment-attempt",
  async (
    input: {
      payment_method: PaymentMethod;
      /** Checkout attempt — gắn vào `vnp_ReturnUrl` (`?attempt=`) để trang kết quả tra đúng lần đặt/thanh toán. */
      attempt_id: string;
      order_id: string;
      display_ref: string;
      amount: number;
      now: string;
      hold_expires_at: string | null;
      ip: string;
    },
    { container },
  ) => {
    if (input.payment_method !== "vnpay") return new StepResponse(null, null);
    const cfg = getVnpayConfig();
    if (!cfg)
      throw new CheckoutError("VALIDATION", "Phương thức thanh toán chưa được bật", {
        field: "payment_method",
      });
    if (!input.hold_expires_at) throw new CheckoutError("INTERNAL", "Thiếu hạn giữ hàng cho đơn online");
    const service = checkoutService(container);
    // Reference ổn định, duy nhất (UNIQUE ở DB), dạng PA_<ULID> — chỉ ký tự VNPAY chấp nhận.
    const txnRef = generateEntityId(undefined, "PA");
    const expiresAt = new Date(input.hold_expires_at);
    const id = await service.insertPaymentAttempt({
      order_id: input.order_id,
      provider: "vnpay",
      txn_ref: txnRef,
      amount: input.amount,
      expires_at: expiresAt,
    });
    const paymentUrl = vnpay.buildPaymentUrl(cfg, {
      txnRef,
      amount: input.amount,
      orderInfo: `Thanh toan don ${input.display_ref}`,
      ipAddr: input.ip,
      createdAt: new Date(input.now),
      expiresAt,
      // Storefront `/thanh-toan/ket-qua?attempt=` (API-CONTRACT): attempt của giỏ trong phiên → đúng đơn, không lấy từ URL.
      returnParams: { attempt: input.attempt_id },
    });
    await service.markPaymentAttemptPending(id, paymentUrl);
    return new StepResponse({ payment_attempt_id: id, txn_ref: txnRef, payment_url: paymentUrl }, { id });
  },
  async (data, { container }) => {
    if (!data) return;
    await checkoutService(container).failOpenPaymentAttempt(data.id);
  },
);

/* ---------------------------------------------------------------- chốt (bước 9, 11) */

export const finalizeCheckoutStep = createStep(
  "x-checkout-finalize",
  async (
    input: {
      attempt_id: string;
      order_id: string;
      display_ref: string;
      cart_id: string;
      cart_version: number;
      payment_method: PaymentMethod;
      deadlines: Deadlines;
      breakdown: QuoteBreakdown;
    },
    { container },
  ) => {
    const t = orderMachine.transition("preparing", input.deadlines.order_state);
    if (!t.ok) throw new CheckoutError("INTERNAL", t.message);
    await checkoutService(container).finalizeAttempt(
      {
        attempt_id: input.attempt_id,
        order_id: input.order_id,
        cart_id: input.cart_id,
        cart_version: input.cart_version,
        order_state: input.deadlines.order_state,
        hold_expires_at: input.deadlines.hold_expires_at ? new Date(input.deadlines.hold_expires_at) : null,
        cod_confirm_by: input.deadlines.cod_confirm_by ? new Date(input.deadlines.cod_confirm_by) : null,
        // Thông báo chỉ gửi sau finalization (AT34) — subscriber đọc outbox, không đọc order.placed native.
        outbox: {
          event_key: `order.placed_pending:${input.order_id}`,
          type: "order.placed_pending",
          payload: {
            order_id: input.order_id,
            display_ref: input.display_ref,
            payment_method: input.payment_method,
            state: input.deadlines.order_state,
          },
        },
      },
      input.breakdown,
    );
    return new StepResponse(true);
  },
);
