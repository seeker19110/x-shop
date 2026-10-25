import type { CreateOrderWorkflowInput } from "@medusajs/medusa/core-flows";
import { createOrderWorkflow, createReservationsWorkflow } from "@medusajs/medusa/core-flows";
import {
  createStep,
  createWorkflow,
  StepResponse,
  transform,
  when,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import type { AddressSnapshot, QuoteBreakdown } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import {
  acquireCheckoutLocksStep,
  checkStockStep,
  createOrderFinanceStep,
  releaseCheckoutLocksStep,
  verifyNativeOrderStep,
  type CheckoutContact,
  type InventoryRequirement,
  type StockAllocation,
  type VerifiedOrder,
} from "../checkout/steps";

export const CREATE_REPLACEMENT_ORDER_WORKFLOW_ID = "x-create-replacement-order";

export interface ReplacementOrderInput {
  /** Chủ khóa tồn kho (duy nhất mỗi lần chạy). */
  owner_id: string;
  return_id: string;
  inventory_lock_keys: string[];
  requirements: InventoryRequirement[];
  location_ids: string[];
  order_input: CreateOrderWorkflowInput;
  /** id dòng trả (metadata.cart_line_item_id của dòng đơn thay thế) — để ánh xạ reservation đúng dòng. */
  line_ids: string[];
  cart_id: string;
  breakdown: QuoteBreakdown;
  address: AddressSnapshot;
  contact: CheckoutContact;
}

/** Mã attempt cố định của đơn thay thế — tra lại được khi duyệt lặp/sập giữa chừng (không tạo đơn thứ hai). */
export const replacementAttemptId = (returnId: string) => `ret:${returnId}`;

/** order_finance của đơn thay thế: preparing → placed (chờ kiểm định hàng trả rồi mới xác nhận để giao). */
const placeReplacementStep = createStep(
  "x-returns-place-replacement",
  async (input: { order_id: string }, { container }) => {
    const svc = container.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
    const [fin] = await svc.listOrderFinances({ order_id: input.order_id });
    if (fin && fin.state === "preparing") await svc.updateOrderFinances({ id: fin.id, state: "placed" });
    return new StepResponse(true);
  },
);

/**
 * Đổi size = ĐƠN THAY THẾ liên kết (đặc tả §6.5, S-310) — không sửa dòng lịch sử đã giao. Đơn native giá 0 đ (cùng giá,
 * không thu thêm) + giữ hàng size mới (reservation theo dòng) dưới khóa `inventory_item:*` như checkout; thiếu hàng →
 * 409 INSUFFICIENT_STOCK. Bước nào lỗi → bù trừ ngược (xoá reservation, xoá đơn native, xoá order_finance preparing).
 */
export const createReplacementOrderWorkflow = createWorkflow(
  CREATE_REPLACEMENT_ORDER_WORKFLOW_ID,
  (input: ReplacementOrderInput) => {
    acquireCheckoutLocksStep({
      owner_id: input.owner_id,
      keys: input.inventory_lock_keys,
      scope: "inventory",
    });
    const allocations = checkStockStep({
      requirements: input.requirements,
      location_ids: input.location_ids,
    });
    const created = createOrderWorkflow.runAsStep({ input: input.order_input });
    const verified = verifyNativeOrderStep({
      order_id: transform({ created }, ({ created }) => created.id),
      expected_total: 0,
      line_ids: input.line_ids,
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
        input: ReplacementOrderInput;
      }) =>
        allocations.map((a) => ({
          inventory_item_id: a.inventory_item_id,
          location_id: a.location_id,
          quantity: a.quantity,
          line_item_id: verified.line_map[a.line_item_id] as string,
          allow_backorder: a.allow_backorder,
          description: `replacement ${input.return_id}`,
          metadata: { return_id: input.return_id },
        })),
    );
    when({ reservations }, ({ reservations }) => reservations.length > 0).then(() => {
      createReservationsWorkflow.runAsStep({ input: { reservations } });
    });
    const finance = createOrderFinanceStep({
      order_id: verified.order_id,
      attempt_id: transform({ input }, ({ input }) => replacementAttemptId(input.return_id)),
      cart_id: input.cart_id,
      payment_method: "cod",
      breakdown: input.breakdown,
      address: input.address,
      contact: input.contact,
    });
    placeReplacementStep({ order_id: verified.order_id });
    releaseCheckoutLocksStep({ owner_id: input.owner_id });
    return new WorkflowResponse(
      transform({ verified, finance }, ({ verified, finance }) => ({
        order_id: verified.order_id,
        display_ref: finance.display_ref,
      })),
    );
  },
);
