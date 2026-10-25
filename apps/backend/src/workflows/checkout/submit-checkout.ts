import type { CreateOrderWorkflowInput } from "@medusajs/medusa/core-flows";
import {
  createHook,
  createWorkflow,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { createOrderWorkflow, createReservationsWorkflow } from "@medusajs/medusa/core-flows";
import { attemptReservationDescription } from "../../lib/checkout/jobs";
import { lockKeys } from "../../lib/checkout/locks";
import {
  acquireCheckoutLocksStep,
  checkStockStep,
  computeDeadlines,
  createOrderFinanceStep,
  createPaymentAttemptStep,
  finalizeCheckoutStep,
  holdCouponStep,
  prepareCheckoutStep,
  releaseCheckoutLocksStep,
  verifyNativeOrderStep,
  type PreparedCheckout,
  type StockAllocation,
  type SubmitCheckoutInput,
  type VerifiedOrder,
} from "./steps";

export const SUBMIT_CHECKOUT_WORKFLOW_ID = "x-submit-checkout";

export interface SubmitCheckoutResult {
  order_id: string;
  display_ref: string;
  order_state: "placed" | "awaiting_payment";
  total: number;
  hold_expires_at: string | null;
  cod_confirm_by: string | null;
  payment_url: string | null;
}

/** Đầu vào createOrderWorkflow: giá/giảm/phí lấy từ quote đã so khớp (snapshot), không để Medusa tự tính lại. */
function toOrderInput(input: SubmitCheckoutInput, prepared: PreparedCheckout): CreateOrderWorkflowInput {
  const b = prepared.breakdown;
  const byLine = new Map(b.lines.map((l) => [l.lineId, l]));
  const promotionId = prepared.discount?.promotion_id;
  const code = prepared.discount?.code ?? null;
  return {
    region_id: prepared.cart.region_id ?? undefined,
    sales_channel_id: prepared.cart.sales_channel_id ?? undefined,
    currency_code: prepared.cart.currency_code,
    // Chỉ gắn khách đã xác thực; KHÔNG truyền email (findOrCreateCustomer sẽ gộp đơn khách vãng lai vào tài khoản
    // trùng email — CHK02 cấm). Email liên hệ nằm ở snapshot order_finance + metadata.
    ...(input.customer_id && { customer_id: input.customer_id }),
    status: "pending",
    no_notification: true,
    shipping_address: {
      first_name: input.contact.name,
      last_name: "",
      phone: input.contact.phone,
      address_1: input.address.line,
      city: input.address.wardName,
      province: input.address.provinceName,
      country_code: "vn",
      metadata: {
        province_code: input.address.provinceCode,
        ward_code: input.address.wardCode,
        dataset_version: input.address.datasetVersion,
      },
    },
    items: prepared.lines.map((l) => {
      const q = byLine.get(l.id);
      if (!q) throw new Error(`quote thiếu dòng ${l.id}`);
      return {
        variant_id: l.variant_id,
        title: l.title,
        quantity: l.quantity,
        unit_price: q.unitPrice,
        // Giá bán lẻ VND đã gồm VAT; không có tax line → tổng = giá niêm yết.
        is_tax_inclusive: true,
        // Mã null: Medusa không tính lại/gỡ điều chỉnh này (refresh promotion chỉ xử lý adjustment có code).
        adjustments:
          q.allocatedDiscount > 0
            ? [{ amount: q.allocatedDiscount, description: `Mã giảm ${code}`, promotion_id: promotionId }]
            : [],
        metadata: { cart_line_item_id: l.id },
      };
    }),
    shipping_methods: [
      {
        name: "Giao hàng tiêu chuẩn",
        amount: b.shippingFee,
        is_tax_inclusive: true,
        data: { service: prepared.shipping_service },
        adjustments:
          b.shippingDiscountTotal > 0
            ? [{ amount: b.shippingDiscountTotal, description: `Mã giảm ${code}`, promotion_id: promotionId }]
            : [],
      },
    ],
    metadata: {
      x_checkout_attempt_id: input.attempt_id,
      x_cart_id: input.cart_id,
      x_quote_total: b.total,
      x_contact_email: input.contact.email,
    },
  } as CreateOrderWorkflowInput;
}

/**
 * Submit checkout tùy biến (docs/design/checkout-flow.md §3 bước 4–11). KHÔNG gọi completeCartWorkflow (nó tự giữ hàng +
 * tạo đơn; webhook payment native lại gọi nó — AT35). Bước 1–3 (quyền, idempotency, INSERT attempt) ở route.
 *
 * Thứ tự khóa toàn cục: `cart:<id>` → `inventory_item:<id>` (tăng dần) → `promotion:<code>`. Báo giá được so lại dưới
 * khóa giỏ trước khi lấy khóa tồn kho để rút ngắn đoạn tranh chấp tồn kho (AT04).
 *
 * Bù trừ (ngược thứ tự) khi một bước lỗi: payment attempt → failed, order_finance preparing → xoá, reservation → xoá
 * (bù trừ của createReservationsWorkflow), coupon → released, đơn native → xoá (bù trừ của createOrderWorkflow),
 * nhả khóa. Route đánh dấu attempt `failed` với mã lỗi. Tiến trình chết giữa chừng → job đối chiếu (T-012).
 */
export const submitCheckoutWorkflow = createWorkflow(
  SUBMIT_CHECKOUT_WORKFLOW_ID,
  (input: SubmitCheckoutInput) => {
    acquireCheckoutLocksStep({
      owner_id: input.attempt_id,
      keys: transform({ input }, ({ input }) => [lockKeys.cart(input.cart_id)]),
      scope: "cart",
    });

    const prepared = prepareCheckoutStep(input);

    acquireCheckoutLocksStep({
      owner_id: input.attempt_id,
      keys: transform({ prepared }, ({ prepared }) => prepared.inventory_lock_keys),
      scope: "inventory",
    }).config({ name: "x-checkout-acquire-inventory-locks" });

    const allocations = checkStockStep({
      requirements: transform({ prepared }, ({ prepared }) => prepared.requirements),
      location_ids: transform({ prepared }, ({ prepared }) => prepared.location_ids),
    });

    holdCouponStep({
      attempt_id: input.attempt_id,
      discount: transform({ prepared }, ({ prepared }) => prepared.discount),
    });

    const orderInput = transform({ input, prepared }, ({ input, prepared }) => toOrderInput(input, prepared));
    const createdOrder = createOrderWorkflow.runAsStep({ input: orderInput });

    const verified = verifyNativeOrderStep({
      order_id: transform({ createdOrder }, ({ createdOrder }) => createdOrder.id),
      expected_total: transform({ prepared }, ({ prepared }) => prepared.breakdown.total),
      line_ids: transform({ prepared }, ({ prepared }) => prepared.lines.map((l) => l.id)),
    });

    const reservations = transform(
      { allocations, verified, input },
      ({
        allocations,
        verified,
        input,
      }: {
        allocations: StockAllocation[];
        verified: VerifiedOrder;
        input: SubmitCheckoutInput;
      }) =>
        allocations.map((a) => ({
          inventory_item_id: a.inventory_item_id,
          location_id: a.location_id,
          quantity: a.quantity,
          line_item_id: verified.line_map[a.line_item_id] as string,
          allow_backorder: a.allow_backorder,
          description: attemptReservationDescription(input.attempt_id),
          metadata: { checkout_attempt_id: input.attempt_id },
        })),
    );
    // Hàng không quản lý tồn (manage_inventory=false) → không có gì để giữ.
    when({ reservations }, ({ reservations }) => reservations.length > 0).then(() => {
      createReservationsWorkflow.runAsStep({ input: { reservations } });
    });

    const finance = createOrderFinanceStep({
      order_id: verified.order_id,
      attempt_id: input.attempt_id,
      cart_id: input.cart_id,
      payment_method: input.payment_method,
      breakdown: transform({ prepared }, ({ prepared }) => prepared.breakdown),
      address: input.address,
      contact: input.contact,
    });

    const deadlines = transform({ input, prepared }, ({ input, prepared }) =>
      computeDeadlines(input.payment_method, prepared.now),
    );

    const payment = createPaymentAttemptStep({
      payment_method: input.payment_method,
      attempt_id: input.attempt_id,
      order_id: verified.order_id,
      display_ref: finance.display_ref,
      amount: transform({ prepared }, ({ prepared }) => prepared.breakdown.total),
      now: transform({ prepared }, ({ prepared }) => prepared.now),
      hold_expires_at: transform({ deadlines }, ({ deadlines }) => deadlines.hold_expires_at),
      ip: input.ip,
    });

    /** Điểm mở rộng trước khi chốt (vd kiểm chống gian lận); handler lỗi → toàn bộ bù trừ. */
    const orderPrepared = createHook("orderPrepared", {
      attempt_id: input.attempt_id,
      cart_id: input.cart_id,
      order_id: verified.order_id,
      payment_method: input.payment_method,
    });

    finalizeCheckoutStep({
      attempt_id: input.attempt_id,
      order_id: verified.order_id,
      display_ref: finance.display_ref,
      cart_id: input.cart_id,
      cart_version: input.cart_version,
      payment_method: input.payment_method,
      deadlines,
      breakdown: transform({ prepared }, ({ prepared }) => prepared.breakdown),
    });

    releaseCheckoutLocksStep({ owner_id: input.attempt_id });

    const result = transform(
      { verified, finance, deadlines, payment, prepared },
      ({ verified, finance, deadlines, payment, prepared }): SubmitCheckoutResult => ({
        order_id: verified.order_id,
        display_ref: finance.display_ref,
        order_state: deadlines.order_state,
        total: prepared.breakdown.total,
        hold_expires_at: deadlines.hold_expires_at,
        cod_confirm_by: deadlines.cod_confirm_by,
        payment_url: payment?.payment_url ?? null,
      }),
    );

    return new WorkflowResponse(result, { hooks: [orderPrepared] });
  },
);
