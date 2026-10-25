import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  codAmount,
  ghn,
  type AddressSnapshot,
  type LedgerEntry,
  type QuoteBreakdown,
  type RefundState,
} from "@x-shop/domain";
import { randomUUID } from "node:crypto";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import { SHIPPING_MODULE } from "../../modules/shipping";
import type ShippingModuleService from "../../modules/shipping/service";
import type { ShipmentRow } from "../../modules/shipping/service";
import type { AuditEntryInput } from "../../modules/audit/service";
import { toSafeInteger as toSafeIntegerOrNull } from "../checkout/cart";
import { cartWeightGrams } from "../checkout/shipping";
import { CHECKOUT_CONFIG } from "../checkout/config";
import { readCheckoutError } from "../checkout/errors";
import { acquireOrdered, lockKeys, releaseOwned } from "../checkout/locks";
import { SHIPPING_CONFIG } from "./config";
import { FulfillmentSyncError, syncNativeProgress } from "./fulfillment";
import { getGhnClient, GhnError, type GhnDetail } from "./ghn-client";
import { planProgress } from "./progress";

/**
 * Tạo vận đơn GHN và xử lý callback (SPEC-fulfillment S-302…S-305, đặc tả §6.3–6.4). Mọi thay đổi chạy dưới khóa
 * `order:<id>` (chung với IPN/expiry/xác nhận COD) và kiểm lại trạng thái sau khi có khóa.
 */
export const GHN_PROVIDER = "ghn";

export type ShippingErrorCode =
  | "NOT_FOUND"
  | "ORDER_NOT_READY"
  | "BUSY_RETRY"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "FULFILLMENT_BLOCKED"
  | "VALIDATION";

const STATUS: Record<ShippingErrorCode, number> = {
  NOT_FOUND: 404,
  ORDER_NOT_READY: 409,
  BUSY_RETRY: 409,
  PROVIDER_REJECTED: 422,
  PROVIDER_UNAVAILABLE: 503,
  FULFILLMENT_BLOCKED: 409,
  VALIDATION: 422,
};

export class ShippingError extends Error {
  override readonly name = "ShippingError";
  readonly status: number;
  constructor(
    readonly code: ShippingErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

type AuditCtx = Pick<AuditEntryInput, "actor_type" | "actor_id" | "request_id" | "ip_hash">;
const SYSTEM_AUDIT: AuditCtx = { actor_type: "system", actor_id: null, request_id: null, ip_hash: null };

const checkoutOf = (c: MedusaContainer) => c.resolve<CheckoutModuleService>(CHECKOUT_MODULE);
const shippingOf = (c: MedusaContainer) => c.resolve<ShippingModuleService>(SHIPPING_MODULE);

/** Chạy `fn` dưới khóa `order:<id>`; không lấy được trong hạn → BUSY_RETRY. */
export async function withOrderLock<T>(
  container: MedusaContainer,
  orderId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locking = container.resolve(Modules.LOCKING);
  const owner = `shipping:${randomUUID()}`;
  try {
    await acquireOrdered(locking, [lockKeys.order(orderId)], {
      ownerId: owner,
      waitMs: CHECKOUT_CONFIG.orderLockWaitMs,
      ttlSeconds: CHECKOUT_CONFIG.lockTtlSeconds,
      scope: "order",
    });
  } catch (e) {
    if (readCheckoutError(e)?.code === "BUSY_RETRY") {
      throw new ShippingError("BUSY_RETRY", "Đơn đang được xử lý, vui lòng thử lại sau giây lát");
    }
    throw e;
  }
  try {
    return await fn();
  } finally {
    await releaseOwned(locking, owner, null);
  }
}

/* ---------------------------------------------------------------- xác nhận COD */

/** Nhân viên xác nhận đơn COD (quyền `order.confirm`) — điều kiện để tạo vận đơn COD (§6.3). Idempotent. */
export async function confirmCodOrder(
  container: MedusaContainer,
  orderId: string,
  actorId: string,
): Promise<{ order_id: string; state: "confirmed"; changed: boolean }> {
  return withOrderLock(container, orderId, async () => {
    const r = await checkoutOf(container).confirmCodOrder(orderId, actorId);
    if (r === "not_found") throw new ShippingError("NOT_FOUND", "Không thấy đơn");
    if (r === "not_cod") {
      throw new ShippingError("ORDER_NOT_READY", "Chỉ đơn thanh toán khi nhận hàng (COD) cần xác nhận tay");
    }
    if (r === "invalid_state") {
      throw new ShippingError("ORDER_NOT_READY", "Đơn không ở trạng thái chờ xác nhận");
    }
    return { order_id: orderId, state: "confirmed" as const, changed: r === "confirmed" };
  });
}

/* ---------------------------------------------------------------- tạo vận đơn */

export interface CreateShipmentResult {
  /** created = vừa tạo/khôi phục ở hãng · existing = đã có từ trước · pending = chưa rõ kết quả ở hãng (thử lại sau). */
  outcome: "created" | "existing" | "pending";
  shipment: ShipmentRow;
}

interface OrderSnapshot {
  order_id: string;
  display_ref: string;
  state: string;
  payment_method: string;
  total: number;
  quote: QuoteBreakdown;
  address: AddressSnapshot;
  contact: { name: string; phone: string; email: string | null };
}

async function loadLedger(container: MedusaContainer, orderId: string): Promise<LedgerEntry[]> {
  const rows = await checkoutOf(container).listPaymentLedgers({ order_id: orderId });
  return rows.map((r) =>
    r.kind === "capture"
      ? { kind: "capture" as const, amount: Number(r.amount), providerTxnId: r.provider_txn_id }
      : {
          kind: "refund" as const,
          amount: Number(r.amount),
          refundId: r.refund_id ?? "",
          state: r.state as RefundState,
        },
  );
}

async function loadItems(container: MedusaContainer, orderId: string): Promise<ghn.GhnItem[]> {
  const { data } = await container.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "order",
    fields: [
      "id",
      "items.title",
      "items.variant_sku",
      "items.variant_id",
      "items.quantity",
      "items.unit_price",
      "items.variant.weight",
    ],
    filters: { id: orderId },
  });
  type Item = {
    title?: string | null;
    variant_sku?: string | null;
    variant_id?: string | null;
    quantity?: unknown;
    unit_price?: unknown;
    variant?: { weight?: unknown } | null;
  };
  const items = ((data[0] as { items?: Array<Item | null> } | undefined)?.items ?? []).flatMap((i) =>
    i ? [i] : [],
  );
  return items.map((i) => {
    const quantity = toSafeIntegerOrNull(i.quantity) ?? 1;
    const weight = cartWeightGrams([{ weightGrams: toSafeIntegerOrNull(i.variant?.weight), quantity: 1 }]);
    return {
      name: (i.title ?? "Sản phẩm").slice(0, 200),
      code: (i.variant_sku ?? i.variant_id ?? "SKU").slice(0, 100),
      quantity,
      price: Math.max(0, toSafeIntegerOrNull(i.unit_price) ?? 0),
      weightGrams: weight,
    };
  });
}

/**
 * Tạo vận đơn cho đơn đã xác nhận (S-302, S-303, AT11, AT13, AT34). Quyền `fulfillment.create` kiểm ở route.
 *  - Chỉ đơn `confirmed`: online đã thu đủ (IPN/querydr) hoặc COD đã được nhân viên xác nhận. Đơn chưa finalization
 *    (`preparing`), đang chờ thanh toán hay COD chưa xác nhận → 409 ORDER_NOT_READY (AT34).
 *  - COD = codAmount(total, ledger) — đơn đã trả đủ → 0 (AT13); phí ship đã nằm trong tổng đơn → shop trả hãng
 *    (payment_type_id 1), khách không trả phí hai lần.
 *  - Giữ chỗ dòng shipment với client_order_code ổn định `<mã đơn>-S1` (UNIQUE) TRƯỚC khi gọi hãng; timeout/lỗi mơ hồ
 *    → tra theo client_order_code trước khi gửi lại.
 *  - Hãng đã nhận vận đơn (created/existing) → fulfillment native + nhả reservation + trừ tồn đúng một lần (T-043,
 *    `./fulfillment.ts`), vẫn dưới khóa đơn. Lỗi ở bước này KHÔNG làm mất vận đơn đã ghi: gọi lại → `existing` → làm tiếp.
 */
export async function createShipmentForOrder(
  container: MedusaContainer,
  orderId: string,
  actorId: string,
  audit: AuditCtx = { ...SYSTEM_AUDIT, actor_type: "user", actor_id: actorId },
): Promise<CreateShipmentResult> {
  return withOrderLock(container, orderId, async () => {
    const r = await createShipmentLocked(container, orderId, actorId);
    if (r.outcome !== "pending" && r.shipment.provider_order_code) {
      await withFulfillmentErrors(r.shipment, () => syncNativeProgress(container, r.shipment, audit));
    }
    return r;
  });
}

/** Lỗi đồng bộ fulfillment native → lỗi giao vận có nghĩa (vận đơn ở hãng đã ghi, gọi lại an toàn). */
async function withFulfillmentErrors<T>(shipment: ShipmentRow, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FulfillmentSyncError) {
      throw new ShippingError(
        "FULFILLMENT_BLOCKED",
        "Đã có vận đơn ở hãng nhưng chưa ghi nhận xuất kho được — cần kiểm tra tồn/giữ hàng của đơn",
        { reason: e.reason, shipment_id: shipment.id, ...e.detail },
      );
    }
    if (readCheckoutError(e)?.code === "BUSY_RETRY") {
      throw new ShippingError("BUSY_RETRY", "Kho đang được cập nhật, vui lòng thử lại sau giây lát");
    }
    throw e;
  }
}

async function createShipmentLocked(
  container: MedusaContainer,
  orderId: string,
  actorId: string,
): Promise<CreateShipmentResult> {
  const [fin] = await checkoutOf(container).listOrderFinances({ order_id: orderId });
  if (!fin) throw new ShippingError("NOT_FOUND", "Không thấy đơn");
  const snap: OrderSnapshot = {
    order_id: fin.order_id,
    display_ref: fin.display_ref,
    state: fin.state,
    payment_method: fin.payment_method,
    total: Number(fin.total),
    quote: fin.quote as unknown as QuoteBreakdown,
    address: fin.address as unknown as AddressSnapshot,
    contact: fin.contact as unknown as OrderSnapshot["contact"],
  };
  if (snap.state !== "confirmed") {
    throw new ShippingError(
      "ORDER_NOT_READY",
      snap.payment_method === "cod" && snap.state === "placed"
        ? "Đơn COD cần được nhân viên xác nhận trước khi tạo vận đơn"
        : "Đơn chưa được xác nhận, chưa tạo vận đơn được",
      { order_state: snap.state, payment_method: snap.payment_method },
    );
  }
  const shipping = shippingOf(container);
  const client = getGhnClient();
  const existing = await shipping.shipmentOfOrder(orderId);
  if (existing?.provider_order_code) return { outcome: "existing", shipment: existing };

  const ledger = await loadLedger(container, orderId);
  const cod = codAmount(snap.total, ledger);
  const clientOrderCode = `${snap.display_ref}-S1`;
  const items = await loadItems(container, orderId);
  if (items.length === 0) throw new ShippingError("VALIDATION", "Đơn không có sản phẩm để giao");
  const weight = Math.max(
    SHIPPING_CONFIG.minWeightGrams,
    items.reduce((s, i) => s + i.weightGrams * i.quantity, 0),
  );
  const input: ghn.CreateShipmentInput = {
    clientOrderCode,
    to: { name: snap.contact.name, phone: snap.contact.phone.replace(/\D/g, ""), address: snap.address },
    codAmount: cod,
    insuranceValue: Math.max(0, snap.quote.total - snap.quote.shippingTotal),
    weightGrams: weight,
    items,
    paymentTypeId: 1,
    requiredNote: SHIPPING_CONFIG.requiredNote,
  };

  const { shipment, inserted } = existing
    ? { shipment: existing, inserted: false }
    : await shipping.reserveShipment({
        order_id: orderId,
        client_order_code: clientOrderCode,
        provider: GHN_PROVIDER,
        cod_amount: cod,
        payer: "shop",
        created_by: actorId,
      });
  if (shipment.provider_order_code) return { outcome: "existing", shipment };

  const adopt = async (d: Pick<GhnDetail, "orderCode">, fee: number | null) => ({
    outcome: "created" as const,
    shipment: await shipping.markCreated(shipment.id, d.orderCode, fee, "packed"),
  });
  /** Tra theo reference của shop; lỗi tra cứu → kết quả vẫn mơ hồ (pending), KHÔNG gửi lại mù. */
  const lookup = async (): Promise<GhnDetail | null | "unknown"> => {
    try {
      return await client.detailByClientCode(clientOrderCode);
    } catch {
      return "unknown";
    }
  };

  if (!inserted) {
    // Lần trước đã giữ chỗ mà chưa biết kết quả (timeout/sập) → tra trước khi gửi lại (S-303, AT11).
    const found = await lookup();
    if (found === "unknown") return { outcome: "pending", shipment };
    if (found) return adopt(found, null);
  }
  try {
    const created = await client.createOrder(input);
    return adopt(created, created.fee);
  } catch (e) {
    if (!(e instanceof GhnError)) throw e;
    const found = await lookup();
    if (found && found !== "unknown") return adopt(found, null);
    if (e.kind === "rejected" && found === null) {
      throw new ShippingError("PROVIDER_REJECTED", e.message);
    }
    return { outcome: "pending", shipment };
  }
}

/* ---------------------------------------------------------------- callback */

/** Trường callback được giữ trong sự kiện thô — KHÔNG giữ tên/SĐT/địa chỉ người nhận hay ghi chú tự do. */
const RAW_ALLOWLIST = [
  "OrderCode",
  "ClientOrderCode",
  "Type",
  "Status",
  "Time",
  "CODAmount",
  "CODTransferDate",
  "TotalFee",
  "Weight",
  "ConvertedWeight",
  "ReasonCode",
  "ShopID",
  "PaymentType",
  "IsPartialReturn",
] as const;

export function filterCallbackRaw(body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body !== "object" || body === null) return out;
  const b = body as Record<string, unknown>;
  for (const k of RAW_ALLOWLIST) {
    const v = b[k];
    if (typeof v === "string") out[k] = v.slice(0, 100);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

export interface CallbackOutcome {
  status: 200 | 400 | 503;
  body: Record<string, unknown>;
}

/**
 * Callback GHN (S-305, ca biên "callback lặp/sai thứ tự"): lưu sự kiện đã lọc PII (khử trùng theo event_key) → KHÔNG
 * tin nội dung — tra chi tiết vận đơn qua API có token → áp trạng thái theo máy, không lùi. Sự kiện COD chỉ ghi "courier
 * báo đã chuyển COD", settlement giữ `unsettled` tới khi đối soát (AT14, T-028). API tra cứu sập → 503, sự kiện chưa
 * `applied` để lần hãng gửi lại xử lý tiếp.
 */
export async function handleGhnCallback(
  container: MedusaContainer,
  body: unknown,
  now: Date = new Date(),
): Promise<CallbackOutcome> {
  const cb = ghn.parseCallback(body);
  if (!cb) return { status: 400, body: { ok: false, code: "INVALID_CALLBACK" } };
  const shipping = shippingOf(container);
  const shipment =
    (await shipping.shipmentByProviderCode(GHN_PROVIDER, cb.orderCode)) ??
    (cb.clientOrderCode ? await shipping.shipmentByClientCode(cb.clientOrderCode) : null);
  const ev = await shipping.recordEvent({
    provider: GHN_PROVIDER,
    event_key: `${GHN_PROVIDER}:${cb.eventKey}`,
    shipment_id: shipment?.id ?? null,
    provider_order_code: cb.orderCode,
    type: cb.type,
    status: cb.status,
    raw: filterCallbackRaw(body),
  });
  if (ev.applied) return { status: 200, body: { ok: true, duplicate: true } };
  if (!shipment) {
    await shipping.markEventApplied(ev.id, null, { ignored: "unknown_shipment" });
    return { status: 200, body: { ok: true, ignored: "unknown_shipment" } };
  }

  return withOrderLock(container, shipment.order_id, async () => {
    const current = (await shipping.shipmentByClientCode(shipment.client_order_code)) as ShipmentRow;
    if (cb.type === "cod") {
      await shipping.recordCodReport(current.id, cb.codAmount, now);
      const result = { cod_reported: true, settlement_state: current.settlement_state };
      await shipping.markEventApplied(ev.id, current.id, result);
      return { status: 200 as const, body: { ok: true, ...result } };
    }
    if (!current.provider_order_code) {
      await shipping.markEventApplied(ev.id, current.id, { ignored: "shipment_not_created" });
      return { status: 200 as const, body: { ok: true, ignored: "shipment_not_created" } };
    }
    let detail: GhnDetail | null;
    try {
      detail = await getGhnClient().detail(current.provider_order_code);
    } catch {
      return { status: 503 as const, body: { ok: false, code: "PROVIDER_UNAVAILABLE" } };
    }
    if (!detail) {
      await shipping.markEventApplied(ev.id, current.id, { ignored: "not_found_at_provider" });
      return { status: 200 as const, body: { ok: true, ignored: "not_found_at_provider" } };
    }
    const target = ghn.mapGhnStatus(detail.status);
    if (!target) {
      const result = { ignored: "unmapped_status", provider_status: detail.status.slice(0, 50) };
      await shipping.markEventApplied(ev.id, current.id, result);
      return { status: 200 as const, body: { ok: true, ...result } };
    }
    const plan = planProgress(current.state, target);
    let state = current.state;
    for (const step of plan.steps) {
      if (!(await shipping.moveState(current.id, step.from, step.to, now))) break;
      state = step.to;
    }
    if (state === "shipped") {
      await checkoutOf(container).insertOutbox(
        `shipment.shipped:${current.id}`,
        current.order_id,
        "shipment.shipped",
        {
          order_id: current.order_id,
          shipment_id: current.id,
          provider_order_code: current.provider_order_code,
        },
      );
    }
    // Fulfillment native theo trạng thái đã đối chiếu (T-043). Lỗi tạm → 503, sự kiện chưa `applied` để hãng gửi lại
    // (bước trạng thái ở trên không lùi nên lần sau chỉ làm tiếp phần native); dữ liệu lệch → ghi lỗi, không chặn sự kiện.
    let nativeSync: "ok" | FulfillmentSyncError["reason"] = "ok";
    try {
      const fresh = (await shipping.shipmentByClientCode(current.client_order_code)) as ShipmentRow;
      await syncNativeProgress(container, fresh, SYSTEM_AUDIT);
    } catch (e) {
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
      if (!(e instanceof FulfillmentSyncError)) {
        logger.warn(
          `[shipping] Chưa đồng bộ fulfillment native cho vận đơn ${current.id}: ${(e as Error).message}`,
        );
        return { status: 503 as const, body: { ok: false, code: "FULFILLMENT_SYNC_RETRY" } };
      }
      logger.error(`[shipping] Không ghi nhận được xuất kho cho vận đơn ${current.id}: ${e.reason}`);
      nativeSync = e.reason;
    }
    const result = {
      state,
      provider_status: detail.status.slice(0, 50),
      callback_status: cb.status.slice(0, 50),
      ignored: plan.ignored,
      settlement_state: current.settlement_state,
      native_sync: nativeSync,
    };
    await shipping.markEventApplied(ev.id, current.id, result);
    return { status: 200 as const, body: { ok: true, ...result } };
  });
}
