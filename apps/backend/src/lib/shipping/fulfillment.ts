import type { MedusaContainer } from "@medusajs/framework/types";
import {
  ContainerRegistrationKeys,
  FulfillmentWorkflowEvents,
  Modules,
  OrderWorkflowEvents,
} from "@medusajs/framework/utils";
import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import {
  createFulfillmentWorkflow,
  createRemoteLinkStep,
  deleteReservationsWorkflow,
  emitEventStep,
  markOrderFulfillmentAsDeliveredWorkflow,
  registerOrderFulfillmentStep,
  registerOrderShipmentStep,
  updateFulfillmentWorkflow,
  updateInventoryLevelsWorkflow,
  updateReservationsWorkflow,
} from "@medusajs/medusa/core-flows";
import { payloadHash, type ShipmentState, isNonEmpty } from "@x-shop/domain";
import { randomUUID } from "node:crypto";
import { AUDIT_MODULE } from "../../modules/audit";
import type AuditModuleService from "../../modules/audit/service";
import { isUniqueViolation, type AuditEntryInput } from "../../modules/audit/service";
import type { ShipmentRow } from "../../modules/shipping/service";
import { toSafeInteger } from "../checkout/cart";
import { CHECKOUT_CONFIG } from "../checkout/config";
import { acquireOrdered, lockKeys, releaseOwnedOrWarn } from "../checkout/locks";
import { isInventoryGuardViolation } from "../inventory/guard";

/**
 * Fulfillment NATIVE của Medusa cho vận đơn GHN (T-043, S-303 "1 shipment / 1 fulfillment").
 *
 * Đơn x-shop không có shipping option native (phí ship lấy từ quote GHN) nên KHÔNG dùng được
 * `createOrderFulfillmentWorkflow` (bắt shipping option + shipping profile khớp sản phẩm). Workflow dưới đây ghép đúng các
 * bước của nó — tạo fulfillment (provider `manual_manual`, location = kho đã giữ hàng), link order↔fulfillment,
 * `registerFulfillment` của order — còn phần tồn kho làm riêng ở `applyStock` để:
 *  - chạy dưới khóa `inventory_item:*` (cùng khóa checkout đọc tồn/giữ hàng) → checkout không thấy trạng thái giữa chừng;
 *  - trừ tồn ĐÚNG MỘT LẦN theo khóa sổ điều chỉnh `xful-<fulfillment>-<item>-<location>` (gọi lại/timeout/sập giữa
 *    chừng chỉ "replay"), có dòng audit như mọi thay đổi tồn khác (INV03).
 * Fulfillment tìm lại theo `metadata.x_shipment_id` → tạo lại/đồng thời (đã tuần tự bởi khóa `order:<id>`) không sinh
 * fulfillment thứ hai. Mọi hàm ở đây giả định người gọi đang giữ khóa `order:<id>`.
 */
export const NATIVE_FULFILLMENT_PROVIDER = "manual_manual";
export const FULFILLMENT_ADJUST_REASON = "fulfillment";

export type FulfillmentSyncReason =
  | "ORDER_NOT_FOUND"
  | "ORDER_CANCELED"
  | "NO_ITEMS"
  | "NO_RESERVATION"
  | "RESERVATION_SHORT"
  | "FOREIGN_FULFILLMENT"
  | "NO_LOCATION"
  | "STOCK_INCONSISTENT";

/** Dữ liệu không cho phép tạo/ghi nhận fulfillment an toàn — gọi lại không tự hết, cần người xem. */
export class FulfillmentSyncError extends Error {
  override readonly name = "FulfillmentSyncError";
  constructor(
    readonly reason: FulfillmentSyncReason,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type AuditCtx = Pick<AuditEntryInput, "actor_type" | "actor_id" | "request_id" | "ip_hash">;

/** Một lượng tồn rời kho cho một dòng đơn (theo reservation đã giữ). */
export interface StockEntry {
  line_item_id: string;
  inventory_item_id: string;
  location_id: string;
  quantity: number;
}

interface OrderItemRow {
  id: string;
  variant_id?: string | null;
  title?: string | null;
  variant_title?: string | null;
  variant_sku?: string | null;
  variant_barcode?: string | null;
  quantity?: unknown;
  variant?: {
    manage_inventory?: boolean | null;
    inventory_items?: Array<{ inventory_item_id?: string | null; required_quantity?: unknown } | null> | null;
  } | null;
}

export interface NativeFulfillmentRow {
  id: string;
  location_id: string | null;
  canceled_at: string | Date | null;
  shipped_at: string | Date | null;
  delivered_at: string | Date | null;
  metadata: Record<string, unknown> | null;
  items: Array<{ line_item_id: string | null } | null> | null;
}

interface OrderRow {
  id: string;
  status: string | null;
  sales_channel_id: string | null;
  items: Array<OrderItemRow | null> | null;
  fulfillments: Array<NativeFulfillmentRow | null> | null;
  shipping_address: { province?: string | null; city?: string | null } | null;
}

async function loadOrder(container: MedusaContainer, orderId: string): Promise<OrderRow | null> {
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: [
      "id",
      "status",
      "sales_channel_id",
      "items.id",
      "items.variant_id",
      "items.title",
      "items.variant_title",
      "items.variant_sku",
      "items.variant_barcode",
      "items.quantity",
      "items.variant.manage_inventory",
      "items.variant.inventory_items.inventory_item_id",
      "items.variant.inventory_items.required_quantity",
      "fulfillments.id",
      "fulfillments.location_id",
      "fulfillments.canceled_at",
      "fulfillments.shipped_at",
      "fulfillments.delivered_at",
      "fulfillments.metadata",
      "fulfillments.items.line_item_id",
      "shipping_address.province",
      "shipping_address.city",
    ],
    filters: { id: orderId },
  });
  return (data[0] as OrderRow | undefined) ?? null;
}

const activeFulfillments = (o: OrderRow) =>
  (o.fulfillments ?? []).flatMap((f) => (f && !isNonEmpty(f.canceled_at) ? [f] : []));
/**
 * Fulfillment của vận đơn: bản còn hiệu lực trước; không có thì bản ĐÃ HỦY (vận đơn bị hãng hủy trước khi lấy hàng —
 * T-045) — để không bao giờ tạo fulfillment thứ hai (và trừ tồn lần hai) cho cùng vận đơn.
 */
const fulfillmentOf = (o: OrderRow, shipmentId: string) => {
  const mine = (o.fulfillments ?? []).flatMap((f) =>
    f && f.metadata?.x_shipment_id === shipmentId ? [f] : [],
  );
  return mine.find((f) => !isNonEmpty(f.canceled_at)) ?? mine[0] ?? null;
};
const qty = (v: unknown): number => toSafeInteger(v) ?? 0;

/** Đọc `metadata.x_stock` đã ghi lúc tạo (không tin mù: bỏ dòng sai kiểu). */
export function stockEntriesOf(metadata: Record<string, unknown> | null | undefined): StockEntry[] {
  const raw = metadata?.x_stock;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e: unknown) => {
    const r = e as Partial<StockEntry> | null;
    if (
      !r ||
      typeof r.line_item_id !== "string" ||
      typeof r.inventory_item_id !== "string" ||
      typeof r.location_id !== "string" ||
      !Number.isSafeInteger(r.quantity) ||
      (r.quantity as number) <= 0
    ) {
      return [];
    }
    return [r as StockEntry];
  });
}

interface FulfillmentPlan {
  location_id: string;
  items: Array<{
    line_item_id: string;
    inventory_item_id: string | null;
    quantity: number;
    title: string;
    sku: string;
    barcode: string;
  }>;
  register_items: Array<{ id: string; quantity: number }>;
  stock: StockEntry[];
}

async function sellableLocationOf(
  container: MedusaContainer,
  salesChannelId: string | null,
): Promise<string | null> {
  if (!isNonEmpty(salesChannelId)) return null;
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "sales_channel",
    fields: ["id", "stock_locations.id"],
    filters: { id: salesChannelId },
  });
  const locs =
    (data[0] as { stock_locations?: Array<{ id?: string } | null> } | undefined)?.stock_locations ?? [];
  return locs.find((l) => isNonEmpty(l?.id))?.id ?? null;
}

/**
 * Kế hoạch fulfillment từ reservation đã giữ ở checkout: mỗi dòng giao đủ số lượng; hàng quản lý tồn phải có reservation
 * đủ số (không có → dừng, KHÔNG trừ mù). Location của fulfillment = kho đã giữ hàng; tồn trừ đúng kho của từng
 * reservation.
 */
async function planFulfillment(container: MedusaContainer, order: OrderRow): Promise<FulfillmentPlan> {
  const items = (order.items ?? []).flatMap((i) => (i ? [i] : []));
  if (items.length === 0) throw new FulfillmentSyncError("NO_ITEMS", "Đơn không có dòng hàng để xuất kho");
  const reservations = await container
    .resolve(Modules.INVENTORY)
    .listReservationItems({ line_item_id: items.map((i) => i.id) }, { order: { created_at: "ASC" } });

  const plan: FulfillmentPlan = { location_id: "", items: [], register_items: [], stock: [] };
  for (const item of items) {
    const quantity = qty(item.quantity);
    if (quantity <= 0) continue;
    plan.register_items.push({ id: item.id, quantity });
    const base = {
      line_item_id: item.id,
      title: (item.variant_title ?? item.title ?? "Sản phẩm").slice(0, 200),
      sku: item.variant_sku ?? "",
      barcode: item.variant_barcode ?? "",
    };
    const mine = reservations.filter((r) => r.line_item_id === item.id);
    if (mine.length === 0) {
      if (item.variant?.manage_inventory === true) {
        throw new FulfillmentSyncError("NO_RESERVATION", "Dòng hàng quản lý tồn nhưng không còn giữ hàng", {
          line_item_id: item.id,
        });
      }
      plan.items.push({ ...base, inventory_item_id: null, quantity });
      continue;
    }
    const required = new Map(
      (item.variant?.inventory_items ?? []).flatMap((ii) =>
        ii && isNonEmpty(ii.inventory_item_id)
          ? [[ii.inventory_item_id, Math.max(1, qty(ii.required_quantity))] as const]
          : [],
      ),
    );
    const byItem = new Map<string, typeof mine>();
    for (const r of mine) byItem.set(r.inventory_item_id, [...(byItem.get(r.inventory_item_id) ?? []), r]);
    for (const [inventoryItemId, rs] of byItem) {
      const need = quantity * (required.get(inventoryItemId) ?? 1);
      const held = rs.reduce((s, r) => s + qty(r.quantity), 0);
      if (held < need) {
        throw new FulfillmentSyncError("RESERVATION_SHORT", "Số đang giữ ít hơn số cần giao", {
          line_item_id: item.id,
          inventory_item_id: inventoryItemId,
          held,
          need,
        });
      }
      plan.items.push({ ...base, inventory_item_id: inventoryItemId, quantity: need });
      let left = need;
      for (const r of rs) {
        if (left === 0) break;
        const take = Math.min(left, qty(r.quantity));
        if (take <= 0) continue;
        plan.stock.push({
          line_item_id: item.id,
          inventory_item_id: inventoryItemId,
          location_id: r.location_id,
          quantity: take,
        });
        left -= take;
      }
    }
  }
  if (plan.register_items.length === 0)
    throw new FulfillmentSyncError("NO_ITEMS", "Đơn không có dòng hàng để xuất kho");
  const location =
    plan.stock[0]?.location_id ?? (await sellableLocationOf(container, order.sales_channel_id));
  if (!isNonEmpty(location))
    throw new FulfillmentSyncError("NO_LOCATION", "Không xác định được kho xuất hàng");
  plan.location_id = location;
  return plan;
}

/* ---------------------------------------------------------------- workflows */

export interface GhnFulfillmentInput {
  order_id: string;
  location_id: string;
  created_by: string | null;
  items: FulfillmentPlan["items"];
  register_items: FulfillmentPlan["register_items"];
  /** Chỉ địa danh (tỉnh/phường) — họ tên/SĐT/số nhà nằm ở đơn và ở hãng, không nhân bản thêm (tối thiểu hóa PII). */
  delivery_area: { province: string | null; city: string | null };
  metadata: Record<string, unknown>;
}

/**
 * Tạo fulfillment native (đã đóng gói) + link + registerFulfillment. Bước sau lỗi → bù trừ ngược (hủy fulfillment,
 * revert version đơn). Không đụng tồn/reservation — xem `applyStock`.
 */
export const createGhnNativeFulfillmentWorkflow = createWorkflow(
  "x-ghn-create-native-fulfillment",
  (input: GhnFulfillmentInput) => {
    const fulfillment = createFulfillmentWorkflow.runAsStep({
      input: transform({ input }, ({ input }) => ({
        location_id: input.location_id,
        provider_id: NATIVE_FULFILLMENT_PROVIDER,
        items: input.items,
        labels: [],
        order: { id: input.order_id },
        delivery_address: {
          country_code: "vn",
          province: input.delivery_area.province,
          city: input.delivery_area.city,
        },
        created_by: input.created_by,
        packed_at: new Date(),
        metadata: input.metadata,
      })),
    });
    registerOrderFulfillmentStep(
      transform({ input, fulfillment }, ({ input, fulfillment }) => ({
        order_id: input.order_id,
        reference: Modules.FULFILLMENT,
        reference_id: fulfillment.id,
        created_by: input.created_by,
        items: input.register_items,
      })),
    );
    createRemoteLinkStep(
      transform({ input, fulfillment }, ({ input, fulfillment }) => [
        {
          [Modules.ORDER]: { order_id: input.order_id },
          [Modules.FULFILLMENT]: { fulfillment_id: fulfillment.id },
        },
      ]),
    );
    emitEventStep({
      eventName: OrderWorkflowEvents.FULFILLMENT_CREATED,
      data: transform({ input, fulfillment }, ({ input, fulfillment }) => ({
        order_id: input.order_id,
        fulfillment_id: fulfillment.id,
        no_notification: true,
      })),
    });
    return new WorkflowResponse(fulfillment);
  },
);

/** Hãng đã lấy hàng: shipped_at của fulfillment + registerShipment của order (không cần shipping option native). */
export const markGhnFulfillmentShippedWorkflow = createWorkflow(
  "x-ghn-native-fulfillment-shipped",
  (input: { order_id: string; fulfillment_id: string; items: Array<{ id: string; quantity: number }> }) => {
    const updated = updateFulfillmentWorkflow.runAsStep({
      input: transform({ input }, ({ input }) => ({
        id: input.fulfillment_id,
        shipped_at: new Date(),
        marked_shipped_by: "x-shop:ghn",
      })),
    });
    registerOrderShipmentStep(
      transform({ input }, ({ input }) => ({
        order_id: input.order_id,
        reference: Modules.FULFILLMENT,
        reference_id: input.fulfillment_id,
        created_by: "x-shop:ghn",
        items: input.items,
      })),
    );
    emitEventStep({
      eventName: FulfillmentWorkflowEvents.SHIPMENT_CREATED,
      data: transform({ input }, ({ input }) => ({ id: input.fulfillment_id, no_notification: true })),
    });
    return new WorkflowResponse(updated);
  },
);

/* ---------------------------------------------------------------- tồn kho */

const stockKey = (fulfillmentId: string, e: Pick<StockEntry, "inventory_item_id" | "location_id">) =>
  `xful-${fulfillmentId}-${e.inventory_item_id}-${e.location_id}`;

/** Nhả reservation của các dòng đã xuất (trừ đúng phần đã giao; phần dư nếu có giữ nguyên). */
async function consumeReservations(container: MedusaContainer, entries: StockEntry[]): Promise<void> {
  const inventory = container.resolve(Modules.INVENTORY);
  const toDelete: string[] = [];
  const toUpdate: Array<{ id: string; quantity: number }> = [];
  for (const e of entries) {
    const rs = await inventory.listReservationItems(
      { line_item_id: e.line_item_id, inventory_item_id: e.inventory_item_id, location_id: e.location_id },
      { order: { created_at: "ASC" } },
    );
    let left = e.quantity;
    for (const r of rs) {
      if (left === 0) break;
      const q = qty(r.quantity);
      if (q <= left) {
        toDelete.push(r.id);
        left -= q;
      } else {
        toUpdate.push({ id: r.id, quantity: q - left });
        left = 0;
      }
    }
  }
  if (toUpdate.length > 0) await updateReservationsWorkflow(container).run({ input: { updates: toUpdate } });
  if (toDelete.length > 0) await deleteReservationsWorkflow(container).run({ input: { ids: toDelete } });
}

async function setStocked(container: MedusaContainer, e: StockEntry, stocked: number): Promise<void> {
  await updateInventoryLevelsWorkflow(container).run({
    input: {
      updates: [
        { inventory_item_id: e.inventory_item_id, location_id: e.location_id, stocked_quantity: stocked },
      ],
    },
  });
}

/**
 * Hàng rời kho theo fulfillment: nhả reservation + trừ stocked, ĐÚNG MỘT LẦN mỗi (fulfillment, item, kho) nhờ khóa sổ
 * điều chỉnh. Thứ tự dưới khóa tồn: kiểm → nhả reservation → trừ stocked → ghi sổ. Sập giữa "trừ" và "ghi sổ" thì lần
 * sau trừ lại (thiếu tồn — hướng an toàn, không bán âm); ghi sổ lỗi → hoàn stocked về trước.
 */
export async function applyStock(
  container: MedusaContainer,
  fulfillment: Pick<NativeFulfillmentRow, "id" | "metadata">,
  audit: AuditCtx,
): Promise<{ applied: number; replayed: number }> {
  const groups = new Map<string, StockEntry & { lines: StockEntry[] }>();
  for (const e of stockEntriesOf(fulfillment.metadata)) {
    const k = stockKey(fulfillment.id, e);
    const g = groups.get(k);
    if (g) {
      g.quantity += e.quantity;
      g.lines.push(e);
    } else groups.set(k, { ...e, lines: [e] });
  }
  if (groups.size === 0) return { applied: 0, replayed: 0 };
  const ledger = container.resolve<AuditModuleService>(AUDIT_MODULE);
  const pending: Array<[string, StockEntry & { lines: StockEntry[] }]> = [];
  for (const [k, g] of groups) if (!(await ledger.findAdjustmentByKey(k))) pending.push([k, g]);
  if (pending.length === 0) return { applied: 0, replayed: groups.size };

  const inventory = container.resolve(Modules.INVENTORY);
  const locking = container.resolve(Modules.LOCKING);
  const ownerId = `fulfillment:${randomUUID()}`;
  await acquireOrdered(
    locking,
    pending.map(([, g]) => lockKeys.inventoryItem(g.inventory_item_id)),
    {
      ownerId,
      waitMs: CHECKOUT_CONFIG.lockWaitMs,
      ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
      scope: "inventory",
    },
  );
  let applied = 0;
  try {
    for (const [key, g] of pending) {
      if (await ledger.findAdjustmentByKey(key)) continue;
      const [level] = await inventory.listInventoryLevels({
        inventory_item_id: g.inventory_item_id,
        location_id: g.location_id,
      });
      if (!level) {
        throw new FulfillmentSyncError("STOCK_INCONSISTENT", "Không thấy tồn của SKU tại kho xuất", {
          inventory_item_id: g.inventory_item_id,
          location_id: g.location_id,
        });
      }
      const ours = (
        await Promise.all(
          g.lines.map((e) =>
            inventory.listReservationItems({
              line_item_id: e.line_item_id,
              inventory_item_id: e.inventory_item_id,
              location_id: e.location_id,
            }),
          ),
        )
      )
        .flat()
        .reduce((s, r) => s + qty(r.quantity), 0);
      const before = qty(level.stocked_quantity);
      const reservedAfter = qty(level.reserved_quantity) - Math.min(ours, g.quantity);
      const after = before - g.quantity;
      // Không trừ khi số còn lại không đủ cho các đơn khác đang giữ — dữ liệu đã lệch, cần người xem (không làm lệch thêm).
      if (after < 0 || after < reservedAfter) {
        throw new FulfillmentSyncError("STOCK_INCONSISTENT", "Tồn không đủ để ghi nhận xuất kho", {
          inventory_item_id: g.inventory_item_id,
          location_id: g.location_id,
          stocked_quantity: before,
          reserved_quantity: qty(level.reserved_quantity),
          quantity: g.quantity,
        });
      }
      await consumeReservations(container, g.lines);
      try {
        await setStocked(container, g, after);
      } catch (e) {
        // Hàng rào DB (T-185): đường ghi khác (không qua khóa) đã giữ thêm giữa lúc kiểm và lúc trừ → dữ liệu lệch, cần
        // người xem — cùng nhánh STOCK_INCONSISTENT ở trên (stocked không đổi vì ghi bị từ chối).
        if (!isInventoryGuardViolation(e)) throw e;
        throw new FulfillmentSyncError("STOCK_INCONSISTENT", "Tồn không đủ để ghi nhận xuất kho", {
          inventory_item_id: g.inventory_item_id,
          location_id: g.location_id,
          stocked_quantity: before,
          quantity: g.quantity,
        });
      }
      const input = {
        inventory_item_id: g.inventory_item_id,
        location_id: g.location_id,
        delta: -g.quantity,
        reason: FULFILLMENT_ADJUST_REASON,
        fulfillment_id: fulfillment.id,
      };
      try {
        await ledger.recordAdjustment(
          {
            idempotency_key: key,
            payload_hash: payloadHash(input),
            actor_id: audit.actor_id,
            inventory_item_id: g.inventory_item_id,
            location_id: g.location_id,
            delta: -g.quantity,
            reason: FULFILLMENT_ADJUST_REASON,
            note: `Xuất kho giao hãng — fulfillment ${fulfillment.id}`,
            stocked_before: before,
            stocked_after: after,
            reserved_quantity: Math.max(0, reservedAfter),
          },
          audit,
        );
        applied += 1;
      } catch (e) {
        await setStocked(container, g, before);
        if (isUniqueViolation(e)) continue;
        throw e;
      }
    }
  } finally {
    await releaseOwnedOrWarn(
      locking,
      ownerId,
      container.resolve(ContainerRegistrationKeys.LOGGER),
      "fulfillment",
    );
  }
  return { applied, replayed: groups.size - applied };
}

/* ---------------------------------------------------------------- điều phối */

/**
 * Bảo đảm vận đơn đã có fulfillment native + tồn đã trừ (idempotent). Gọi khi hãng đã nhận vận đơn (có
 * provider_order_code) — tạo mới, gọi lại, và callback (tự chữa vận đơn tạo trước T-043 hoặc lần trước dở dang).
 */
export async function ensureNativeFulfillment(
  container: MedusaContainer,
  shipment: Pick<ShipmentRow, "id" | "order_id" | "provider" | "provider_order_code" | "client_order_code">,
  audit: AuditCtx,
): Promise<NativeFulfillmentRow> {
  let order = await loadOrder(container, shipment.order_id);
  if (!order) throw new FulfillmentSyncError("ORDER_NOT_FOUND", "Không thấy đơn native");
  let ful = fulfillmentOf(order, shipment.id);
  if (!ful) {
    if (order.status === "canceled") {
      throw new FulfillmentSyncError("ORDER_CANCELED", "Đơn native đã hủy, không xuất kho");
    }
    const foreign = activeFulfillments(order);
    if (foreign.length > 0) {
      // Đã có fulfillment ngoài luồng GHN (vd tạo tay ở Admin native) → không tạo thêm để khỏi trừ tồn hai lần.
      throw new FulfillmentSyncError("FOREIGN_FULFILLMENT", "Đơn đã có fulfillment khác", {
        fulfillment_ids: foreign.map((f) => f.id),
      });
    }
    const plan = await planFulfillment(container, order);
    await createGhnNativeFulfillmentWorkflow(container).run({
      input: {
        order_id: order.id,
        location_id: plan.location_id,
        created_by: audit.actor_id ?? null,
        items: plan.items,
        register_items: plan.register_items,
        delivery_area: {
          province: order.shipping_address?.province ?? null,
          city: order.shipping_address?.city ?? null,
        },
        metadata: {
          x_shipment_id: shipment.id,
          x_provider: shipment.provider,
          x_provider_order_code: shipment.provider_order_code,
          x_client_order_code: shipment.client_order_code,
          x_stock: plan.stock,
        },
      },
    });
    order = await loadOrder(container, shipment.order_id);
    ful = order ? fulfillmentOf(order, shipment.id) : null;
    if (!order || !ful) throw new Error(`Không đọc lại được fulfillment của vận đơn ${shipment.id}`);
  }
  // Fulfillment đã hủy (hãng hủy trước lấy hàng): không trừ tồn nữa — phần đã trừ (nếu có) đi luồng hàng hoàn (T-045).
  if (!isNonEmpty(ful.canceled_at)) await applyStock(container, ful, audit);
  return ful;
}

const SHIPPED_OR_LATER: readonly ShipmentState[] = [
  "shipped",
  "failed",
  "delivered",
  "returning",
  "returned",
];

/**
 * Ánh xạ trạng thái vận đơn (đã đối chiếu API hãng) sang fulfillment native: đã lấy hàng → shipped; đã giao →
 * delivered. Giao lỗi/đang hoàn/đã hoàn KHÔNG đổi tồn ở đây: hàng hoàn về đi luồng kiểm định (T-027), không tự restock.
 */
export async function syncNativeProgress(
  container: MedusaContainer,
  shipment: Pick<
    ShipmentRow,
    "id" | "order_id" | "provider" | "provider_order_code" | "client_order_code" | "state" | "delivered_at"
  >,
  audit: AuditCtx,
): Promise<{ fulfillment_id: string; shipped: boolean; delivered: boolean }> {
  const ful = await ensureNativeFulfillment(container, shipment, audit);
  if (isNonEmpty(ful.canceled_at)) return { fulfillment_id: ful.id, shipped: false, delivered: false };
  let shipped = Boolean(ful.shipped_at);
  let delivered = Boolean(ful.delivered_at);
  const reached = (s: ShipmentState) =>
    shipment.state === s || (s === "shipped" && SHIPPED_OR_LATER.includes(shipment.state));
  const isDelivered = shipment.state === "delivered" || shipment.delivered_at !== null;
  if (!shipped && (reached("shipped") || isDelivered)) {
    const order = await loadOrder(container, shipment.order_id);
    const lineIds = new Set(
      (ful.items ?? []).flatMap((i) => (i && isNonEmpty(i.line_item_id) ? [i.line_item_id] : [])),
    );
    const items = (order?.items ?? []).flatMap((i) =>
      i && lineIds.has(i.id) && qty(i.quantity) > 0 ? [{ id: i.id, quantity: qty(i.quantity) }] : [],
    );
    await markGhnFulfillmentShippedWorkflow(container).run({
      input: { order_id: shipment.order_id, fulfillment_id: ful.id, items },
    });
    shipped = true;
  }
  if (!delivered && isDelivered) {
    await markOrderFulfillmentAsDeliveredWorkflow(container).run({
      input: { orderId: shipment.order_id, fulfillmentId: ful.id },
    });
    delivered = true;
  }
  return { fulfillment_id: ful.id, shipped, delivered };
}

/* ---------------------------------------------------------------- hàng hoàn từ hãng (T-045) */

/**
 * Số lượng THỰC SỰ đã rời tồn bán theo fulfillment của vận đơn, theo dòng đơn: dòng có tồn quản lý được tính khi MỌI
 * nhóm tồn của nó đã ghi sổ xuất kho (`xful-*`); dòng không quản lý tồn tính theo số giao. Chưa có fulfillment/chưa trừ →
 * dòng không có trong kết quả (hàng vẫn nằm trong tồn bán — không nhập cách ly để khỏi đếm hai lần).
 */
export async function shippedOutQuantities(
  container: MedusaContainer,
  shipment: Pick<ShipmentRow, "id" | "order_id">,
): Promise<{ fulfillment: NativeFulfillmentRow | null; lines: Map<string, number> }> {
  const lines = new Map<string, number>();
  const order = await loadOrder(container, shipment.order_id);
  const ful = order ? fulfillmentOf(order, shipment.id) : null;
  if (!order || !ful) return { fulfillment: null, lines };
  const ledger = container.resolve<AuditModuleService>(AUDIT_MODULE);
  const entries = stockEntriesOf(ful.metadata);
  const applied = new Map<string, boolean>();
  for (const e of entries) {
    const k = stockKey(ful.id, e);
    if (!applied.has(k)) applied.set(k, Boolean(await ledger.findAdjustmentByKey(k)));
  }
  const inFulfillment = new Set(
    (ful.items ?? []).flatMap((i) => (i && isNonEmpty(i.line_item_id) ? [i.line_item_id] : [])),
  );
  for (const item of order.items ?? []) {
    if (!item || !inFulfillment.has(item.id) || qty(item.quantity) <= 0) continue;
    const mine = entries.filter((e) => e.line_item_id === item.id);
    const left =
      mine.length > 0
        ? mine.every((e) => applied.get(stockKey(ful.id, e)) === true)
        : item.variant?.manage_inventory !== true;
    if (left) lines.set(item.id, qty(item.quantity));
  }
  return { fulfillment: ful, lines };
}

/**
 * Hủy fulfillment native CHƯA giao cho hãng (GHN hủy trước lấy hàng). Chỉ ở mức module fulfillment — không đụng tồn
 * (phần đã trừ đi luồng hàng hoàn vào kho cách ly). Đã lấy/đã giao → không hủy (Medusa cũng chặn). Idempotent.
 */
export async function cancelUnshippedFulfillment(
  container: MedusaContainer,
  ful: Pick<NativeFulfillmentRow, "id" | "canceled_at" | "shipped_at" | "delivered_at">,
): Promise<boolean> {
  if (isNonEmpty(ful.canceled_at) || isNonEmpty(ful.shipped_at) || isNonEmpty(ful.delivered_at)) return false;
  await container.resolve(Modules.FULFILLMENT).cancelFulfillment(ful.id);
  return true;
}

/**
 * Kho đã xuất hàng của một dòng đơn theo fulfillment native (T-045 — reservation đã bị nhả khi xuất kho nên không còn đọc
 * được kho từ reservation): theo inventory item (`metadata.x_stock`, bản còn hiệu lực trước rồi bản đã hủy), kèm kho của
 * fulfillment chứa dòng. Không thấy → map rỗng/null (caller tự chọn fallback rõ ràng).
 */
export async function shippedFromLocations(
  container: MedusaContainer,
  orderId: string,
  lineItemId: string,
): Promise<{ byItem: Map<string, string>; fulfillmentLocation: string | null }> {
  const order = await loadOrder(container, orderId);
  const byItem = new Map<string, string>();
  let fulfillmentLocation: string | null = null;
  const fs = (order?.fulfillments ?? []).flatMap((f) => (f ? [f] : []));
  const ordered = [
    ...fs.filter((f) => !isNonEmpty(f.canceled_at)),
    ...fs.filter((f) => isNonEmpty(f.canceled_at)),
  ];
  for (const f of ordered) {
    const hasLine = (f.items ?? []).some((i) => i?.line_item_id === lineItemId);
    for (const e of stockEntriesOf(f.metadata)) {
      if (e.line_item_id === lineItemId && !byItem.has(e.inventory_item_id)) {
        byItem.set(e.inventory_item_id, e.location_id);
      }
    }
    if (hasLine && !isNonEmpty(fulfillmentLocation) && isNonEmpty(f.location_id))
      fulfillmentLocation = f.location_id;
  }
  return { byItem, fulfillmentLocation };
}
