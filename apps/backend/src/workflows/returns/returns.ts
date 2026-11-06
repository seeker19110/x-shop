import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { CreateOrderWorkflowInput } from "@medusajs/medusa/core-flows";
import { createInventoryLevelsWorkflow } from "@medusajs/medusa/core-flows";
import {
  can,
  computeQuote,
  decideIdempotency,
  payloadHash,
  refundForUnits,
  sumVnd,
  type AddressSnapshot,
  isNonEmpty,
} from "@x-shop/domain";
import { randomUUID } from "node:crypto";
import { toSafeInteger } from "../../lib/checkout/cart";
import { maskFreeText } from "../../lib/audit/sanitize";
import { CheckoutError, readCheckoutError } from "../../lib/checkout/errors";
import { cancelNativeOrder } from "../../lib/checkout/jobs";
import { lockKeys } from "../../lib/checkout/locks";
import { adjustInventory } from "../../lib/inventory/adjust";
import { inventoryGuardKind } from "../../lib/inventory/guard";
import { shippedFromLocations } from "../../lib/shipping/fulfillment";
import { SEED } from "../../scripts/seed";
import { sizeChartsOfProducts } from "../../lib/catalog/size-chart-snapshot";
import type { ReturnKind, ReturnReason } from "../../modules/returns/constants";
import type { RefundRow, ReturnLineRow, ReturnRow, ReturnWithLines } from "../../modules/returns/service";
import type { CheckoutContact, InventoryRequirement } from "../checkout/steps";
import { ReturnsError } from "./errors";
import {
  assertReturnable,
  checkoutOf,
  loadOrderContext,
  returnsOf,
  withOrderLock,
  type OrderContext,
  type OrderLine,
} from "./order-context";
import { audit, insertRefundLocked, refundSourcesOf, type Actor, type AuditCtx } from "./refunds";
import { createReplacementOrderWorkflow, replacementAttemptId } from "./replacement-order";

type Scope = Pick<MedusaContainer, "resolve">;

export interface ReturnLineInput {
  line_id: string;
  quantity: number;
  exchange_variant_id?: string | null | undefined;
}

export interface RequestReturnInput {
  order_id: string;
  kind: ReturnKind;
  reason: ReturnReason;
  note: string | null;
  lines: ReturnLineInput[];
  channel: "customer" | "staff";
  requested_by: string | null;
  idempotency_key: string;
}

interface VariantInfo {
  id: string;
  product_id: string | null;
  title: string;
  product_title: string;
  base_price: number | null;
  manage_inventory: boolean;
  allow_backorder: boolean;
  inventory: Array<{ inventory_item_id: string; required_quantity: number }>;
}

/** Biến thể + giá niêm yết VND (price set gốc, không rule/price list) + inventory item. */
async function loadVariants(container: Scope, ids: readonly string[]): Promise<Map<string, VariantInfo>> {
  const out = new Map<string, VariantInfo>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "variant",
    fields: [
      "id",
      "title",
      "product_id",
      "product.title",
      "manage_inventory",
      "allow_backorder",
      "prices.amount",
      "prices.currency_code",
      "prices.rules_count",
      "prices.price_list_id",
      "inventory_items.inventory_item_id",
      "inventory_items.required_quantity",
    ],
    filters: { id: unique },
  });
  type Row = {
    id: string;
    title?: string | null;
    product_id?: string | null;
    product?: { title?: string | null } | null;
    manage_inventory?: boolean | null;
    allow_backorder?: boolean | null;
    prices?: Array<{
      amount?: unknown;
      currency_code?: string | null;
      rules_count?: number | null;
      price_list_id?: string | null;
    } | null> | null;
    inventory_items?: Array<{ inventory_item_id?: string | null; required_quantity?: unknown } | null> | null;
  };
  for (const v of data as Row[]) {
    const base = (v.prices ?? []).find(
      (p) =>
        p != null &&
        p.currency_code?.toLowerCase() === "vnd" &&
        !isNonEmpty(p.price_list_id) &&
        !(p.rules_count ?? 0),
    );
    out.set(v.id, {
      id: v.id,
      product_id: v.product_id ?? null,
      title: v.title ?? "",
      product_title: v.product?.title ?? "Sản phẩm",
      base_price: base ? toSafeInteger(base.amount) : null,
      manage_inventory: v.manage_inventory === true,
      allow_backorder: v.allow_backorder === true,
      inventory: (v.inventory_items ?? []).flatMap((i) =>
        i && isNonEmpty(i.inventory_item_id)
          ? [
              {
                inventory_item_id: i.inventory_item_id,
                required_quantity: toSafeInteger(i.required_quantity) ?? 1,
              },
            ]
          : [],
      ),
    });
  }
  return out;
}

function replayReturnOrConflict(existing: ReturnWithLines, hash: string): ReturnWithLines {
  if (decideIdempotency({ payloadHash: existing.payload_hash }, hash) === "conflict") {
    throw new ReturnsError("IDEMPOTENCY_CONFLICT", "Idempotency-Key đã dùng cho một yêu cầu đổi/trả khác");
  }
  return existing;
}

/**
 * Yêu cầu đổi/trả theo dòng + số lượng (POST03). Đơn phải đã giao; số lượng cộng dồn mọi yêu cầu chưa bị từ chối không
 * vượt số đã giao của dòng (kiểm dưới `lockOrder` — hai yêu cầu song song không cùng vượt). Đổi size: biến thể mới cùng
 * sản phẩm, khác biến thể cũ, cùng giá niêm yết (chênh lệch giá ngoài phạm vi P0 → trả hàng + đặt mới).
 * Cùng Idempotency-Key + cùng nội dung → trả lại yêu cầu đã có; khác nội dung → 409.
 */
export async function requestReturn(
  container: Scope,
  input: RequestReturnInput,
  auditCtx: AuditCtx,
  now: Date = new Date(),
): Promise<{ ret: ReturnWithLines; replayed: boolean }> {
  const svc = returnsOf(container);
  const key = `${input.order_id}:${input.idempotency_key}`;
  const lines = [...input.lines].sort((a, b) => (a.line_id < b.line_id ? -1 : 1));
  const hash = payloadHash({
    order_id: input.order_id,
    kind: input.kind,
    reason: input.reason,
    note: input.note,
    lines: lines.map((l) => ({
      line_id: l.line_id,
      quantity: l.quantity,
      ex: l.exchange_variant_id ?? null,
    })),
  });
  const prior = await svc.findReturnByKey(key);
  if (prior) return { ret: replayReturnOrConflict((await svc.getReturn(prior.id))!, hash), replayed: true };

  if (new Set(lines.map((l) => l.line_id)).size !== lines.length) {
    throw new ReturnsError("VALIDATION", "Mỗi dòng hàng chỉ xuất hiện một lần", { field: "lines" });
  }
  const ctx = await loadOrderContext(container, input.order_id);
  assertReturnable(ctx, now);
  const byId = new Map(ctx.lines.map((l) => [l.id, l]));
  for (const l of lines) {
    const line = byId.get(l.line_id);
    if (!line)
      throw new ReturnsError("VALIDATION", "Dòng hàng không thuộc đơn", {
        field: "lines",
        line_id: l.line_id,
      });
    if (input.kind === "exchange" && !isNonEmpty(l.exchange_variant_id)) {
      throw new ReturnsError("VALIDATION", "Đổi size cần chọn biến thể mới", {
        field: "lines",
        line_id: l.line_id,
      });
    }
    if (input.kind === "return" && isNonEmpty(l.exchange_variant_id)) {
      throw new ReturnsError("VALIDATION", "Trả hàng không kèm biến thể đổi", {
        field: "lines",
        line_id: l.line_id,
      });
    }
  }
  if (input.kind === "exchange") {
    const variants = await loadVariants(container, [
      ...lines.map((l) => l.exchange_variant_id as string),
      ...lines.flatMap((l) => {
        const variantId = byId.get(l.line_id)?.variant_id;
        return isNonEmpty(variantId) ? [variantId] : [];
      }),
    ]);
    for (const l of lines) {
      const line = byId.get(l.line_id) as OrderLine;
      const target = variants.get(l.exchange_variant_id as string);
      const original = isNonEmpty(line.variant_id) ? variants.get(line.variant_id) : undefined;
      if (!target || !original || target.id === original.id || target.product_id !== original.product_id) {
        throw new ReturnsError("EXCHANGE_INVALID_VARIANT", "Chỉ đổi sang size/màu khác của cùng sản phẩm", {
          line_id: l.line_id,
        });
      }
      if (target.base_price === null || target.base_price !== original.base_price) {
        throw new ReturnsError(
          "EXCHANGE_PRICE_DIFFERS",
          "Biến thể mới khác giá — vui lòng trả hàng và đặt đơn mới",
          {
            line_id: l.line_id,
            original_price: original.base_price,
            target_price: target.base_price,
          },
        );
      }
    }
  }

  try {
    const ret = await svc.transaction(async (trx) => {
      await svc.lockOrder(trx, input.order_id);
      const again = await svc.findReturnByKey(key, trx);
      if (again)
        return { ret: replayReturnOrConflict((await svc.getReturn(again.id, trx))!, hash), replayed: true };
      const committed = await svc.committedQuantities(input.order_id, trx);
      for (const l of lines) {
        const line = byId.get(l.line_id) as OrderLine;
        const max = line.quantity - (committed.get(l.line_id) ?? 0);
        if (l.quantity > max) {
          throw new ReturnsError(
            "QUANTITY_EXCEEDS_DELIVERED",
            "Số lượng trả vượt số đã giao còn lại của dòng",
            {
              line_id: l.line_id,
              requested: l.quantity,
              returnable: Math.max(0, max),
            },
          );
        }
      }
      const created = await svc.insertReturn(
        trx,
        {
          order_id: input.order_id,
          kind: input.kind,
          reason: input.reason,
          note: input.note,
          channel: input.channel,
          requested_by: input.requested_by,
          idempotency_key: key,
          payload_hash: hash,
        },
        lines.map((l) => {
          const line = byId.get(l.line_id) as OrderLine;
          return {
            order_line_item_id: l.line_id,
            variant_id: line.variant_id,
            quantity: l.quantity,
            exchange_variant_id: l.exchange_variant_id ?? null,
            size_chart: line.size_chart,
          };
        }),
      );
      return { ret: created, replayed: false };
    });
    if (!ret.replayed) {
      await audit(container, auditCtx, {
        action: "return.requested",
        resource_type: "return",
        resource_id: ret.ret.id,
        reason: input.reason,
        changes: {
          order_id: input.order_id,
          kind: input.kind,
          channel: input.channel,
          lines: ret.ret.lines.map((l) => ({ line_id: l.order_line_item_id, quantity: l.quantity })),
        },
      });
    }
    return ret;
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
      const winner = await svc.findReturnByKey(key);
      if (winner)
        return { ret: replayReturnOrConflict((await svc.getReturn(winner.id))!, hash), replayed: true };
    }
    throw e;
  }
}

async function sellableLocations(container: Scope, salesChannelId: string | null): Promise<string[]> {
  if (!isNonEmpty(salesChannelId)) return [];
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "sales_channel",
    fields: ["id", "stock_locations.id"],
    filters: { id: salesChannelId },
  });
  return ((data[0] as { stock_locations?: Array<{ id?: string } | null> } | undefined)?.stock_locations ?? [])
    .flatMap((l) => (l && isNonEmpty(l.id) ? [l.id] : []))
    .sort();
}

/** Đơn thay thế đã có (theo mã attempt cố định) hoặc tạo mới có giữ hàng. */
async function ensureReplacementOrder(
  container: Scope,
  ret: ReturnWithLines,
  ctx: OrderContext,
): Promise<string> {
  const checkout = checkoutOf(container);
  const [existing] = await checkout.listOrderFinances({ checkout_attempt_id: replacementAttemptId(ret.id) });
  if (existing) return existing.order_id;

  const variants = await loadVariants(
    container,
    ret.lines.map((l) => l.exchange_variant_id as string),
  );
  const sizeCharts = await sizeChartsOfProducts(
    container,
    [...variants.values()].flatMap((v) => (isNonEmpty(v.product_id) ? [v.product_id] : [])),
  );
  const requirements: InventoryRequirement[] = ret.lines.flatMap((l) => {
    const v = variants.get(l.exchange_variant_id as string);
    if (!v)
      throw new ReturnsError("EXCHANGE_INVALID_VARIANT", "Biến thể đổi không còn tồn tại", { line_id: l.id });
    return v.manage_inventory
      ? v.inventory.map((inv) => ({
          line_item_id: l.id,
          variant_id: v.id,
          inventory_item_id: inv.inventory_item_id,
          quantity: inv.required_quantity * l.quantity,
          allow_backorder: v.allow_backorder,
        }))
      : [];
  });
  const quote = computeQuote({
    lines: ret.lines.map((l) => ({
      lineId: l.id,
      variantId: l.exchange_variant_id as string,
      unitPrice: 0,
      quantity: l.quantity,
    })),
    shippingFee: 0,
  });
  if (!quote.ok) throw new ReturnsError("VALIDATION", quote.message);
  const sa = ctx.native.shipping_address ?? {};
  const pick = (k: string) => (typeof sa[k] === "string" ? (sa[k] as string) : undefined);
  const orderInput = {
    region_id: ctx.native.region_id ?? undefined,
    sales_channel_id: ctx.native.sales_channel_id ?? undefined,
    currency_code: ctx.native.currency_code,
    ...(isNonEmpty(ctx.native.customer_id) && { customer_id: ctx.native.customer_id }),
    status: "pending",
    no_notification: true,
    shipping_address: {
      first_name: pick("first_name") ?? "",
      last_name: pick("last_name") ?? "",
      phone: pick("phone"),
      address_1: pick("address_1"),
      city: pick("city"),
      province: pick("province"),
      country_code: pick("country_code") ?? "vn",
      metadata: (sa.metadata as Record<string, unknown> | undefined) ?? undefined,
    },
    items: ret.lines.map((l) => {
      const v = variants.get(l.exchange_variant_id as string) as VariantInfo;
      const chart = (isNonEmpty(v.product_id) ? sizeCharts.get(v.product_id) : undefined) ?? null;
      return {
        variant_id: v.id,
        title: v.product_title,
        quantity: l.quantity,
        unit_price: 0,
        is_tax_inclusive: true,
        metadata: {
          cart_line_item_id: l.id,
          x_return_id: ret.id,
          x_replaces_line_item_id: l.order_line_item_id,
          ...(chart ?? { size_chart_id: null, size_chart_code: null, size_chart_version: null }),
        },
      };
    }),
    shipping_methods: [{ name: "Giao hàng đổi size", amount: 0, is_tax_inclusive: true, data: {} }],
    metadata: { x_replacement_of: ctx.fin.order_id, x_return_id: ret.id },
  } as unknown as CreateOrderWorkflowInput;

  try {
    const { result } = await createReplacementOrderWorkflow(container as MedusaContainer).run({
      input: {
        owner_id: `replacement:${ret.id}:${randomUUID()}`,
        return_id: ret.id,
        inventory_lock_keys: requirements.map((r) => lockKeys.inventoryItem(r.inventory_item_id)),
        requirements,
        location_ids: await sellableLocations(container, ctx.native.sales_channel_id),
        order_input: orderInput,
        line_ids: ret.lines.map((l) => l.id),
        cart_id: ctx.fin.cart_id,
        breakdown: quote.value,
        address: ctx.fin.address as AddressSnapshot,
        contact: ctx.fin.contact as CheckoutContact,
      },
    });
    return result.order_id;
  } catch (e) {
    const known = readCheckoutError(e);
    // Hàng rào DB (T-185) từ chối giữ hàng lúc commit: vượt tồn → không đủ hàng; số giữ bị ghi đè đồng thời → bận, thử lại.
    const guard = known ? null : inventoryGuardKind(e);
    if (guard === "drift") throw new CheckoutError("BUSY_RETRY");
    if (known?.code === "INSUFFICIENT_STOCK" || guard === "stock") {
      throw new ReturnsError("INSUFFICIENT_STOCK", "Size muốn đổi hiện không đủ hàng", {
        lines: known?.detail?.lines ?? [],
      });
    }
    throw known ?? e;
  }
}

async function getReturnOr404(container: Scope, id: string): Promise<ReturnWithLines> {
  const ret = await returnsOf(container).getReturn(id);
  if (!ret) throw new ReturnsError("NOT_FOUND", "Không tìm thấy yêu cầu đổi/trả");
  return ret;
}

/**
 * Duyệt yêu cầu (quyền `return.approve`). Đổi size → tạo đơn thay thế + giữ hàng ngay khi duyệt (khách được bảo đảm
 * size); đơn thay thế chỉ được xác nhận để giao SAU khi hàng trả qua kiểm định. Đã duyệt → trả nguyên (idempotent).
 */
export async function approveReturn(
  container: Scope,
  id: string,
  actor: Actor,
  note: string | null,
  auditCtx: AuditCtx,
): Promise<{ ret: ReturnWithLines; changed: boolean }> {
  const first = await getReturnOr404(container, id);
  return withOrderLock(container, first.order_id, async () => {
    const svc = returnsOf(container);
    const cur = await getReturnOr404(container, id);
    if (cur.state === "approved") return { ret: cur, changed: false };
    if (cur.state !== "requested") {
      throw new ReturnsError("INVALID_STATE", "Yêu cầu không còn chờ duyệt", { state: cur.state });
    }
    let replacement: string | null = null;
    if (cur.kind === "exchange") {
      replacement = await ensureReplacementOrder(
        container,
        cur,
        await loadOrderContext(container, cur.order_id),
      );
    }
    const moved = await svc.updateReturn(null, id, ["requested"], {
      state: "approved",
      decided_by: actor.id,
      decided_at: new Date(),
      decision_note: note,
      replacement_order_id: replacement,
    });
    if (!moved) throw new ReturnsError("INVALID_STATE", "Yêu cầu vừa được xử lý bởi người khác");
    await audit(container, auditCtx, {
      action: "return.approved",
      resource_type: "return",
      resource_id: id,
      reason: note,
      changes: { order_id: cur.order_id, kind: cur.kind, replacement_order_id: replacement },
    });
    return { ret: (await svc.getReturn(id)) as ReturnWithLines, changed: true };
  });
}

export async function rejectReturn(
  container: Scope,
  id: string,
  actor: Actor,
  reason: string,
  auditCtx: AuditCtx,
): Promise<ReturnWithLines> {
  const svc = returnsOf(container);
  const cur = await getReturnOr404(container, id);
  if (cur.state === "rejected") return cur;
  const moved = await svc.updateReturn(null, id, ["requested"], {
    state: "rejected",
    decided_by: actor.id,
    decided_at: new Date(),
    decision_note: reason,
  });
  if (!moved)
    throw new ReturnsError("INVALID_STATE", "Chỉ từ chối được yêu cầu đang chờ duyệt", { state: cur.state });
  await audit(container, auditCtx, {
    action: "return.rejected",
    resource_type: "return",
    resource_id: id,
    reason,
    changes: { order_id: cur.order_id, kind: cur.kind },
  });
  return (await svc.getReturn(id)) as ReturnWithLines;
}

/* ------------------------------------------------------------------ tồn kho hàng trả (INV01, INV04, S-307) */

/** Kho cách ly (seed: không gắn kênh bán nào) — hàng trả chờ kiểm định và hàng lỗi nằm ở đây, không vào tồn bán. */
async function quarantineLocationId(container: Scope): Promise<string> {
  const [loc] = await container
    .resolve(Modules.STOCK_LOCATION)
    .listStockLocations({ name: SEED.quarantineLocationName }, { take: 1 });
  if (!loc) throw new ReturnsError("INVALID_STATE", "Chưa cấu hình kho cách ly cho hàng trả");
  return loc.id;
}

/** Bảo đảm có inventory level của item tại kho (kho cách ly ban đầu chưa có level cho SKU nào). */
async function ensureLevel(container: Scope, inventoryItemId: string, locationId: string): Promise<void> {
  const inventory = container.resolve(Modules.INVENTORY);
  const has = async () =>
    (await inventory.listInventoryLevels({ inventory_item_id: inventoryItemId, location_id: locationId }))
      .length > 0;
  if (await has()) return;
  try {
    await createInventoryLevelsWorkflow(container as MedusaContainer).run({
      input: {
        inventory_levels: [
          { inventory_item_id: inventoryItemId, location_id: locationId, stocked_quantity: 0 },
        ],
      },
    });
  } catch (e) {
    if (!(await has())) throw e;
  }
}

interface StockMove {
  /** Hậu tố khóa chống trùng — cố định theo (bước, dòng trả, item) để chạy lại chỉ "replay". */
  step: "recv" | "out" | "restock" | "reject";
  location_id: string;
  delta: number;
  reason: "return_received" | "return_restock" | "return_rejected";
}

/** Áp các bước tồn cho một dòng trả qua sổ điều chỉnh có khóa chống trùng (INV03/INV04: retry không cộng hai lần). */
async function moveStock(
  container: Scope,
  line: ReturnLineRow,
  returnId: string,
  moves: (inv: { inventory_item_id: string; required_quantity: number }) => StockMove[],
  auditCtx: AuditCtx,
): Promise<void> {
  if (!isNonEmpty(line.variant_id)) return;
  const variant = (await loadVariants(container, [line.variant_id])).get(line.variant_id);
  if (!variant || !variant.manage_inventory) return;
  for (const inv of variant.inventory) {
    for (const m of moves(inv)) {
      if (m.delta === 0) continue;
      await ensureLevel(container, inv.inventory_item_id, m.location_id);
      await adjustInventory(
        container as MedusaContainer,
        `xret-${m.step}-${line.id}-${inv.inventory_item_id}`,
        {
          inventory_item_id: inv.inventory_item_id,
          location_id: m.location_id,
          delta: m.delta,
          reason: m.reason,
          note: `Hàng trả — yêu cầu ${returnId}`,
        },
        auditCtx,
      );
    }
  }
}

export type RestockSource = "fulfillment_stock" | "fulfillment" | "reservation" | "channel_default";

/**
 * Kho bán để nhập lại hàng đạt kiểm định, theo TỪNG inventory item của dòng gốc — thứ tự fallback rõ ràng (T-045):
 *  1. `fulfillment_stock`: kho đã xuất của item theo fulfillment native (`metadata.x_stock`) — T-043 nhả reservation khi
 *     xuất kho nên đây là nguồn đúng cho mọi đơn đã có vận đơn;
 *  2. `fulfillment`: kho của fulfillment chứa dòng (item không có trong x_stock — vd fulfillment cũ);
 *  3. `reservation`: kho đang giữ hàng (đơn chưa đi qua xuất kho T-043);
 *  4. `channel_default`: kho bán đầu tiên (theo id) của kênh bán.
 * Không có nguồn nào → 409. Nguồn đã dùng ghi vào audit kiểm định (`restocked_to`).
 */
export async function restockLocationsOf(
  container: Scope,
  ctx: Pick<OrderContext, "fin" | "native">,
  line: Pick<ReturnLineRow, "order_line_item_id">,
): Promise<(inventoryItemId: string) => { location_id: string; source: RestockSource }> {
  const shipped = await shippedFromLocations(
    container as MedusaContainer,
    ctx.fin.order_id,
    line.order_line_item_id,
  );
  const reservations = await container
    .resolve(Modules.INVENTORY)
    .listReservationItems({ line_item_id: line.order_line_item_id });
  const fallback = (await sellableLocations(container, ctx.native.sales_channel_id))[0] ?? null;
  return (inventoryItemId) => {
    const fromStock = shipped.byItem.get(inventoryItemId);
    if (isNonEmpty(fromStock)) return { location_id: fromStock, source: "fulfillment_stock" };
    if (isNonEmpty(shipped.fulfillmentLocation))
      return {
        location_id: shipped.fulfillmentLocation,
        source: "fulfillment",
      };
    const held =
      reservations.find((r) => r.inventory_item_id === inventoryItemId)?.location_id ??
      reservations[0]?.location_id;
    if (isNonEmpty(held)) return { location_id: held, source: "reservation" };
    if (isNonEmpty(fallback)) return { location_id: fallback, source: "channel_default" };
    throw new ReturnsError("INVALID_STATE", "Không xác định được kho bán để nhập lại", {
      line_id: line.order_line_item_id,
    });
  };
}

/* ------------------------------------------------------------------ hàng hoàn từ hãng (T-045) */

/** Người tạo/nhận của yêu cầu hàng hoàn do hệ thống mở theo trạng thái hãng đã đối chiếu API. */
export const CARRIER_RETURN_ACTOR = "system:carrier";
const CARRIER_KEY_PREFIX = "carrier:";

/** Khóa chống trùng của yêu cầu hàng hoàn: một vận đơn (client_order_code) → tối đa một yêu cầu. */
export const carrierReturnKey = (clientOrderCode: string) => `${CARRIER_KEY_PREFIX}${clientOrderCode}`;

/**
 * Yêu cầu hàng hoàn từ hãng (không do khách/CSKH tạo). Khóa do server đặt — khóa của khách/CSKH luôn là
 * `<order_id>:<Idempotency-Key>` nên không thể trùng tiền tố.
 */
export const isCarrierReturn = (ret: Pick<ReturnRow, "idempotency_key">) =>
  ret.idempotency_key.startsWith(CARRIER_KEY_PREFIX);

export interface CarrierReturnInput {
  order_id: string;
  client_order_code: string;
  provider: string;
  /** cancelled = hãng hủy trước lấy hàng (hàng chưa rời shop) · returned = hãng đã hoàn hàng về shop. */
  outcome: "cancelled" | "returned";
  provider_status: string;
  /** Dòng đơn → số lượng đã thực sự rời tồn bán (theo fulfillment native đã ghi sổ xuất kho). */
  quantities: ReadonlyMap<string, number>;
}

/**
 * Nhận hàng hoàn từ hãng vào KHO CÁCH LY chờ kiểm định (T-045, INV04, D-019) — KHÔNG cộng tồn bán. Tạo (một lần, theo
 * `carrierReturnKey`) yêu cầu `kind=return` do hệ thống mở, đi đúng máy trạng thái requested → approved → received, nhập
 * cách ly qua sổ điều chỉnh có khóa chống trùng theo dòng trả (cùng khóa `xret-recv-*` với nhận hàng tay — không cộng hai
 * lần). Kiểm định dùng lại `inspectReturn` (đạt → kho bán gốc, lỗi → ở lại cách ly, không có/thiếu → rời cách ly);
 * tiền KHÔNG tính ở đây (đơn hủy + hoàn tiền hủy đơn — lib/shipping/return-to-sender.ts).
 * Gọi khi ĐANG giữ khóa `order:<id>`. Callback lặp/đồng thời → cùng một yêu cầu, tồn cách ly cộng đúng một lần.
 */
export async function receiveCarrierReturnLocked(
  container: Scope,
  input: CarrierReturnInput,
  auditCtx: AuditCtx,
): Promise<{ ret: ReturnWithLines; created: boolean; received: boolean }> {
  const svc = returnsOf(container);
  const key = carrierReturnKey(input.client_order_code);
  const wanted = [...input.quantities.entries()]
    .filter(([, q]) => Number.isSafeInteger(q) && q > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = payloadHash({ key, lines: wanted });

  let created = false;
  const prior = await svc.findReturnByKey(key);
  let ret = prior ? await svc.getReturn(prior.id) : null;
  if (!ret) {
    if (wanted.length === 0) throw new ReturnsError("VALIDATION", "Không có hàng nào đã rời kho để nhận lại");
    const ctx = await loadOrderContext(container, input.order_id);
    const byId = new Map(ctx.lines.map((l) => [l.id, l]));
    const now = new Date();
    try {
      const r = await svc.transaction(async (trx) => {
        await svc.lockOrder(trx, input.order_id);
        const again = await svc.findReturnByKey(key, trx);
        if (again)
          return {
            ret: (await svc.getReturn(again.id, trx)) as ReturnWithLines,
            created: false,
          };
        const note =
          input.outcome === "cancelled"
            ? `Hãng ${input.provider} hủy vận đơn ${input.client_order_code} trước khi lấy hàng — kiểm lại hàng trước khi bán`
            : `Hãng ${input.provider} hoàn vận đơn ${input.client_order_code} về shop — chờ kiểm định`;
        const row = await svc.insertReturn(
          trx,
          {
            order_id: input.order_id,
            kind: "return",
            reason: "other",
            note,
            channel: "staff",
            requested_by: CARRIER_RETURN_ACTOR,
            idempotency_key: key,
            payload_hash: hash,
          },
          wanted.map(([lineId, quantity]) => {
            const line = byId.get(lineId);
            if (!line) {
              throw new ReturnsError("INVALID_STATE", "Dòng hàng hoàn không thuộc đơn", { line_id: lineId });
            }
            return {
              order_line_item_id: lineId,
              variant_id: line.variant_id,
              quantity,
              exchange_variant_id: null,
              size_chart: line.size_chart,
            };
          }),
        );
        const approved = await svc.updateReturn(trx, row.id, ["requested"], {
          state: "approved",
          decided_by: CARRIER_RETURN_ACTOR,
          decided_at: now,
          decision_note: `${input.provider}: ${input.provider_status}`.slice(0, 200),
        });
        if (!approved) throw new ReturnsError("INVALID_STATE", "Không mở được yêu cầu hàng hoàn");
        return {
          ret: (await svc.getReturn(row.id, trx)) as ReturnWithLines,
          created: true,
        };
      });
      ret = r.ret;
      created = r.created;
    } catch (e) {
      if (typeof e !== "object" || e === null || (e as { code?: string }).code !== "23505") throw e;
      const winner = await svc.findReturnByKey(key);
      if (!winner) throw e;
      ret = (await svc.getReturn(winner.id)) as ReturnWithLines;
    }
    if (created) {
      await audit(container, auditCtx, {
        action: "return.requested",
        resource_type: "return",
        resource_id: ret.id,
        reason: input.outcome === "cancelled" ? "CARRIER_CANCELLED" : "CARRIER_RETURNED",
        changes: {
          order_id: input.order_id,
          source: "carrier",
          provider: input.provider,
          provider_status: input.provider_status.slice(0, 50),
          lines: ret.lines.map((l) => ({
            line_id: l.order_line_item_id,
            quantity: l.quantity,
          })),
        },
      });
    }
  }

  // Nhập cách ly TRƯỚC khi chốt `received` (như nhận hàng tay): sập giữa chừng thì lần sau chỉ replay theo khóa dòng trả.
  if (ret.state !== "approved") return { ret, created, received: false };
  const current = ret;
  const quarantine = await quarantineLocationId(container);
  for (const l of current.lines) {
    await moveStock(
      container,
      l,
      current.id,
      (inv) => [
        {
          step: "recv",
          location_id: quarantine,
          delta: l.quantity * inv.required_quantity,
          reason: "return_received",
        },
      ],
      auditCtx,
    );
  }
  const moved = await svc.transaction(async (trx) => {
    const m = await svc.updateReturn(trx, current.id, ["approved"], {
      state: "received",
      received_by: CARRIER_RETURN_ACTOR,
      received_at: new Date(),
    });
    if (!m) return false;
    for (const l of current.lines) await svc.updateLine(trx, l.id, { received_quantity: l.quantity });
    return true;
  });
  const after = (await svc.getReturn(current.id)) as ReturnWithLines;
  if (moved) {
    await audit(container, auditCtx, {
      action: "return.received",
      resource_type: "return",
      resource_id: current.id,
      changes: {
        order_id: input.order_id,
        source: "carrier",
        location: "quarantine",
        lines: after.lines.map((l) => ({
          line_id: l.order_line_item_id,
          received: l.received_quantity,
        })),
      },
    });
  }
  return { ret: after, created, received: moved };
}

/**
 * Kho nhận hàng trả (quyền `return.receive`, INV04/AT17, S-307): số đã nhận vào KHO CÁCH LY (không cấp bán) — trạng thái
 * chờ kiểm định, tồn bán KHÔNG đổi. Gửi lại cùng số lượng → idempotent.
 */
export async function receiveReturn(
  container: Scope,
  id: string,
  actor: Actor,
  lines: Array<{ line_id: string; quantity: number }> | null,
  auditCtx: AuditCtx,
): Promise<{ ret: ReturnWithLines; changed: boolean }> {
  const first = await getReturnOr404(container, id);
  return withOrderLock(container, first.order_id, async () => {
    const svc = returnsOf(container);
    const cur = await getReturnOr404(container, id);
    const wanted = new Map(cur.lines.map((l) => [l.order_line_item_id, l.quantity]));
    if (lines) {
      for (const l of lines) {
        if (!wanted.has(l.line_id)) {
          throw new ReturnsError("VALIDATION", "Dòng không thuộc yêu cầu", {
            field: "lines",
            line_id: l.line_id,
          });
        }
      }
      for (const l of cur.lines) {
        const given = lines.find((x) => x.line_id === l.order_line_item_id);
        wanted.set(l.order_line_item_id, given ? given.quantity : 0);
      }
    }
    for (const l of cur.lines) {
      const q = wanted.get(l.order_line_item_id) as number;
      if (!Number.isSafeInteger(q) || q < 0 || q > l.quantity) {
        throw new ReturnsError("VALIDATION", "Số lượng nhận phải từ 0 tới số lượng yêu cầu", {
          field: "lines",
          line_id: l.order_line_item_id,
        });
      }
    }
    if ([...wanted.values()].every((q) => q === 0)) {
      throw new ReturnsError("VALIDATION", "Chưa nhận sản phẩm nào", { field: "lines" });
    }
    const same = cur.lines.every((l) => l.received_quantity === wanted.get(l.order_line_item_id));
    if (["received", "inspected", "closed"].includes(cur.state)) {
      if (same) return { ret: cur, changed: false };
      throw new ReturnsError("INVALID_STATE", "Yêu cầu đã ghi nhận hàng với số lượng khác", {
        state: cur.state,
      });
    }
    if (cur.state !== "approved") {
      throw new ReturnsError("INVALID_STATE", "Chỉ nhận hàng cho yêu cầu đã duyệt", { state: cur.state });
    }
    const quarantine = await quarantineLocationId(container);
    for (const l of cur.lines) {
      const q = wanted.get(l.order_line_item_id) as number;
      await moveStock(
        container,
        l,
        id,
        (inv) => [
          {
            step: "recv",
            location_id: quarantine,
            delta: q * inv.required_quantity,
            reason: "return_received",
          },
        ],
        auditCtx,
      );
    }
    const changed = await svc.transaction(async (trx) => {
      const moved = await svc.updateReturn(trx, id, ["approved"], {
        state: "received",
        received_by: actor.id,
        received_at: new Date(),
      });
      if (!moved) return false;
      for (const l of cur.lines) {
        await svc.updateLine(trx, l.id, { received_quantity: wanted.get(l.order_line_item_id) as number });
      }
      return true;
    });
    const after = (await svc.getReturn(id)) as ReturnWithLines;
    if (!changed) throw new ReturnsError("INVALID_STATE", "Yêu cầu vừa được xử lý bởi người khác");
    await audit(container, auditCtx, {
      action: "return.received",
      resource_type: "return",
      resource_id: id,
      changes: {
        order_id: cur.order_id,
        lines: after.lines.map((l) => ({ line_id: l.order_line_item_id, received: l.received_quantity })),
      },
    });
    return { ret: after, changed: true };
  });
}

export interface InspectLineInput {
  line_id: string;
  /** Đạt — chuyển từ kho cách ly về tồn bán. */
  restock_quantity: number;
  /** Lỗi/hư do sản phẩm — chấp nhận trả (hoàn tiền) nhưng ở lại kho cách ly, KHÔNG vào tồn bán. */
  damaged_quantity: number;
  note?: string | null | undefined;
}

/** Đơn thay thế: hàng trả đạt → xác nhận để giao; không đạt → hủy đơn thay thế, nhả giữ hàng. */
async function settleReplacement(
  container: Scope,
  ret: ReturnWithLines,
  accepted: boolean,
  actor: Actor,
): Promise<void> {
  const replacement = ret.replacement_order_id;
  if (!isNonEmpty(replacement)) return;
  await withOrderLock(container, replacement, async () => {
    const checkout = checkoutOf(container);
    if (accepted) {
      const r = await checkout.confirmCodOrder(replacement, actor.id);
      if (r !== "confirmed" && r !== "already_confirmed") {
        throw new ReturnsError("INVALID_STATE", "Không xác nhận được đơn thay thế", { result: r });
      }
      return;
    }
    const [fin] = await checkout.listOrderFinances({ order_id: replacement });
    if (!fin || fin.state === "cancelled") return;
    await cancelNativeOrder(container as MedusaContainer, replacement);
    if (fin.state === "placed") await checkout.updateOrderFinances({ id: fin.id, state: "cancelled" });
  });
}

/**
 * Kiểm định (quyền `return.inspect`, INV04, AT15–AT17). Mỗi dòng: restock (đạt → cộng tồn bán, MỘT lần theo khóa dòng
 * trả), damaged (lỗi → không cộng tồn, vẫn hoàn), phần còn lại của số đã nhận = rejected (không đạt điều kiện đổi trả:
 * không hoàn, không nhập kho). Trả hàng → tính hoàn theo GIÁ THỰC TRẢ đã phân bổ, lũy kế theo dòng (tổng mọi lần trả của
 * một dòng = đúng phần thực trả — PRICE03) và mở yêu cầu hoàn tiền trong CÙNG transaction. Đổi size → mọi đơn vị đạt
 * thì xác nhận đơn thay thế, không thì hủy nó. Gửi lại cùng kết quả → idempotent.
 */
export async function inspectReturn(
  container: Scope,
  id: string,
  actor: Actor,
  lines: InspectLineInput[],
  auditCtx: AuditCtx,
): Promise<{ ret: ReturnWithLines; refund: RefundRow | null; changed: boolean }> {
  const first = await getReturnOr404(container, id);
  return withOrderLock(container, first.order_id, async () => {
    const svc = returnsOf(container);
    const cur = await getReturnOr404(container, id);
    const byLine = new Map(lines.map((l) => [l.line_id, l]));
    if (byLine.size !== lines.length) throw new ReturnsError("VALIDATION", "Dòng bị lặp", { field: "lines" });
    for (const l of lines) {
      if (!cur.lines.some((x) => x.order_line_item_id === l.line_id)) {
        throw new ReturnsError("VALIDATION", "Dòng không thuộc yêu cầu", {
          field: "lines",
          line_id: l.line_id,
        });
      }
    }
    const plan = cur.lines.map((l) => {
      const received = l.received_quantity ?? 0;
      const given = byLine.get(l.order_line_item_id);
      if (!given && received > 0) {
        throw new ReturnsError("VALIDATION", "Thiếu kết quả kiểm định cho dòng đã nhận", {
          field: "lines",
          line_id: l.order_line_item_id,
        });
      }
      const restock = given?.restock_quantity ?? 0;
      const damaged = given?.damaged_quantity ?? 0;
      if (restock < 0 || damaged < 0 || restock + damaged > received) {
        throw new ReturnsError("VALIDATION", "Đạt + lỗi không được vượt số đã nhận", {
          field: "lines",
          line_id: l.order_line_item_id,
          received,
        });
      }
      return { line: l, restock, damaged, rejected: received - restock - damaged, note: given?.note ?? null };
    });

    if (cur.state === "inspected" || cur.state === "closed") {
      const same = plan.every(
        (p) => p.line.restock_quantity === p.restock && p.line.damaged_quantity === p.damaged,
      );
      if (!same)
        throw new ReturnsError("INVALID_STATE", "Yêu cầu đã kiểm định với kết quả khác", {
          state: cur.state,
        });
      return { ret: cur, refund: await svc.refundOfReturn(id), changed: false };
    }
    if (cur.state !== "received") {
      throw new ReturnsError("INVALID_STATE", "Chỉ kiểm định hàng đã nhận", { state: cur.state });
    }

    const ctx = await loadOrderContext(container, cur.order_id);
    // Tồn TRƯỚC khi chốt trạng thái: mỗi bước một khóa chống trùng → chạy lại sau sự cố chỉ "replay". Đạt: cách ly →
    // kho bán; không đạt: rời kho cách ly (trả lại khách); lỗi: ở lại kho cách ly.
    const quarantine = await quarantineLocationId(container);
    const restockedTo: Array<{
      line_id: string;
      inventory_item_id: string;
      location_id: string;
      source: string;
    }> = [];
    for (const p of plan) {
      const locate = p.restock > 0 ? await restockLocationsOf(container, ctx, p.line) : null;
      const sellable = (invId: string) => {
        if (!locate) return quarantine;
        const r = locate(invId);
        restockedTo.push({ line_id: p.line.order_line_item_id, inventory_item_id: invId, ...r });
        return r.location_id;
      };
      await moveStock(
        container,
        p.line,
        id,
        (inv) => [
          {
            step: "out",
            location_id: quarantine,
            delta: -p.restock * inv.required_quantity,
            reason: "return_restock",
          },
          {
            step: "restock",
            location_id: sellable(inv.inventory_item_id),
            delta: p.restock * inv.required_quantity,
            reason: "return_restock",
          },
          {
            step: "reject",
            location_id: quarantine,
            delta: -p.rejected * inv.required_quantity,
            reason: "return_rejected",
          },
        ],
        auditCtx,
      );
    }

    const orderLines = new Map(ctx.lines.map((l) => [l.id, l]));
    // Hàng hoàn từ hãng (T-045): tiền đã xử lý khi hủy đơn (COD chưa thu → không thu/không hoàn; đã thu → hoàn tiền hủy
    // đơn) — kiểm định chỉ quyết tồn, không mở thêm hoàn tiền.
    const carrier = isCarrierReturn(cur);
    const refundable = cur.kind === "return" && !carrier;
    // Nguồn tiền (khoản thu, cờ xung đột mã, cổng bật/tắt) để định tuyến hoàn, đọc NGOÀI transaction — `auto` chọn
    // manual khi cổng tắt/khoản thu không gắn attempt (T-169). Không hoàn được → không tạo refund, nguồn rỗng.
    const sources = refundable
      ? await refundSourcesOf(container, ctx)
      : { captures: [], txnConflict: false, gatewayEnabled: false };
    const refund = await svc.transaction(async (trx) => {
      await svc.lockOrder(trx, cur.order_id);
      const moved = await svc.updateReturn(trx, id, ["received"], {
        state: "inspected",
        inspected_by: actor.id,
        inspected_at: new Date(),
      });
      if (!moved) throw new ReturnsError("INVALID_STATE", "Yêu cầu vừa được xử lý bởi người khác");
      const prev = refundable ? await svc.acceptedByLine(trx, cur.order_id, id) : new Map();
      const amounts: number[] = [];
      for (const p of plan) {
        let amount = 0;
        const accepted = p.restock + p.damaged;
        if (refundable && accepted > 0) {
          const ol = orderLines.get(p.line.order_line_item_id);
          if (!ol) throw new ReturnsError("INVALID_STATE", "Dòng đơn không còn tồn tại");
          const before = prev.get(p.line.order_line_item_id) ?? { accepted: 0, refunded: 0 };
          const cumulative = refundForUnits(ol.line_total, ol.quantity, 0, before.accepted + accepted);
          amount = Math.max(0, cumulative - before.refunded);
        }
        amounts.push(amount);
        await svc.updateLine(trx, p.line.id, {
          restock_quantity: p.restock,
          damaged_quantity: p.damaged,
          rejected_quantity: p.rejected,
          refund_amount: refundable ? amount : null,
          inspection_note: p.note,
        });
      }
      const total = sumVnd(amounts);
      if (cur.kind !== "return") return null;
      if (!refundable || total === 0) {
        await svc.updateReturn(trx, id, ["inspected"], { state: "closed", closed_at: new Date() });
        return null;
      }
      return insertRefundLocked(svc, trx, ctx, sources, {
        reason: "return",
        amount: total,
        return_id: id,
        method: "auto",
        requested_by: actor.id,
        requester_can_approve: can(actor.roles, "refund.approve"),
        note: `Hoàn theo kiểm định yêu cầu ${id}`,
        idempotency_key: `return:${id}`,
        payload_hash: payloadHash({ return_id: id, amount: total }),
      });
    });

    if (cur.kind === "exchange") {
      const allAccepted = plan.every((p) => p.rejected === 0 && p.line.received_quantity === p.line.quantity);
      await settleReplacement(container, cur, allAccepted, actor);
      await svc.updateReturn(null, id, ["inspected"], { state: "closed", closed_at: new Date() });
    }
    const after = (await svc.getReturn(id)) as ReturnWithLines;
    await audit(container, auditCtx, {
      action: "return.inspected",
      resource_type: "return",
      resource_id: id,
      changes: {
        order_id: cur.order_id,
        lines: after.lines.map((l) => ({
          line_id: l.order_line_item_id,
          restock: l.restock_quantity,
          damaged: l.damaged_quantity,
          rejected: l.rejected_quantity,
          refund_amount: l.refund_amount,
        })),
        refund_id: refund?.id ?? null,
        ...(carrier && { source: "carrier" }),
        ...(restockedTo.length > 0 && { restocked_to: restockedTo }),
      },
    });
    return { ret: after, refund, changed: true };
  });
}

const STATUS_LABEL: Record<string, string> = {
  requested: "Đã tiếp nhận",
  approved: "Chờ gửi hàng",
  rejected: "Không được chấp nhận",
  received: "Đã nhận hàng",
  inspected: "Đã kiểm tra",
  closed: "Hoàn tất",
};

const REFUND_LABEL: Record<string, string> = {
  requested: "Chờ duyệt hoàn tiền",
  approved: "Đã duyệt hoàn tiền",
  rejected: "Không hoàn tiền",
  processing: "Đang hoàn tiền",
  succeeded: "Đã hoàn tiền",
  failed: "Đang xử lý hoàn tiền",
  unknown: "Đang xử lý hoàn tiền",
  cancelled: "Đang xử lý hoàn tiền",
};

/**
 * Hình yêu cầu đổi/trả trả cho khách/Admin (POST03: thấy đã tiếp nhận → chờ gửi → đã nhận → đã kiểm tra → kết quả).
 * `opts.refund`: hoàn tiền đã đọc cùng bản chụp với `ret` (đọc Admin — T-049); bỏ trống → tự đọc.
 */
export async function presentReturn(
  container: Scope,
  ret: ReturnWithLines,
  opts: { customer: boolean; refund?: RefundRow | null },
) {
  const refund = opts.refund !== undefined ? opts.refund : await returnsOf(container).refundOfReturn(ret.id);
  let replacement: { display_ref: string; state: string } | null = null;
  if (isNonEmpty(ret.replacement_order_id)) {
    const [fin] = await checkoutOf(container).listOrderFinances({ order_id: ret.replacement_order_id });
    if (fin) replacement = { display_ref: fin.display_ref, state: fin.state };
  }
  return {
    id: ret.id,
    kind: ret.kind,
    state: ret.state,
    status_label: STATUS_LABEL[ret.state] ?? ret.state,
    reason: ret.reason,
    note: maskFreeText(ret.note),
    created_at: new Date(ret.created_at).toISOString(),
    ...(!opts.customer && {
      order_id: ret.order_id,
      source: isCarrierReturn(ret) ? ("carrier" as const) : ("request" as const),
      channel: ret.channel,
      requested_by: ret.requested_by,
      decided_by: ret.decided_by,
      received_by: ret.received_by,
      inspected_by: ret.inspected_by,
      replacement_order_id: ret.replacement_order_id,
    }),
    decision_note: maskFreeText(ret.decision_note),
    lines: ret.lines.map((l) => ({
      line_id: l.order_line_item_id,
      quantity: l.quantity,
      exchange_variant_id: l.exchange_variant_id,
      size_chart: l.size_chart,
      received_quantity: l.received_quantity,
      restock_quantity: l.restock_quantity,
      damaged_quantity: l.damaged_quantity,
      rejected_quantity: l.rejected_quantity,
      refund_amount: l.refund_amount,
    })),
    refund: refund
      ? {
          ...(!opts.customer && { id: refund.id }),
          amount: refund.amount,
          state: refund.state,
          status_label: REFUND_LABEL[refund.state] ?? refund.state,
        }
      : null,
    replacement,
  };
}

/** Dòng còn đổi/trả được của đơn (cho trang đơn của khách). */
export async function returnableLines(container: Scope, ctx: OrderContext) {
  const committed = await returnsOf(container).committedQuantities(ctx.fin.order_id);
  return ctx.lines.map((l) => ({
    line_id: l.id,
    title: l.title,
    variant_title: l.variant_title,
    quantity: l.quantity,
    returnable_quantity: Math.max(0, l.quantity - (committed.get(l.id) ?? 0)),
    size_chart: l.size_chart,
  }));
}
