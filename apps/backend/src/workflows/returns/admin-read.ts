import type { MedusaContainer } from "@medusajs/framework/types";
import { z } from "zod";
import { maskFreeText } from "../../lib/audit/sanitize";
import { REFUND_STATES, RETURN_STATES } from "../../modules/returns/constants";
import type { ReturnWithLines } from "../../modules/returns/service";
import { ReturnsError } from "./errors";
import { checkoutOf, loadOrderContext, returnsOf } from "./order-context";
import { presentRefund } from "./refunds";
import { carrierReturnKey, isCarrierReturn, presentReturn } from "./returns";
import { isNonEmpty } from "@x-shop/domain";

/**
 * Truy vấn CHỈ ĐỌC cho Admin (T-049): danh sách/chi tiết yêu cầu đổi/trả và hàng đợi hoàn tiền theo trạng thái. Không
 * ghi gì, không tính tiền — số tiền là số đã chốt (kiểm định/yêu cầu hoàn). Không trả PII của khách (liên hệ/địa chỉ):
 * chỉ mã đơn hiển thị, tên sản phẩm và id nhân viên.
 */
type Scope = Pick<MedusaContainer, "resolve">;

/**
 * Nguồn yêu cầu: `request` = khách/CSKH tạo · `carrier` = hệ thống mở cho hàng hãng hoàn về (khóa `carrier:` — T-045).
 * Admin luôn thấy cả hai (hàng hoàn từ hãng cũng nằm ở kho cách ly chờ kiểm định), đánh dấu bằng `source` và lọc được.
 */
export const RETURN_SOURCES = ["request", "carrier"] as const;
export type ReturnSource = (typeof RETURN_SOURCES)[number];

const page = {
  /** Vượt khoảng → 422 (không kẹp ngầm) — cùng quy ước với các danh sách Admin khác (audit, đối soát). */
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
};
const id = z.string().trim().min(1).max(128);

export const AdminReturnListQuery = z
  .object({
    state: z.enum(RETURN_STATES).optional(),
    order_id: id.optional(),
    source: z.enum(RETURN_SOURCES).optional(),
    ...page,
  })
  .strict();

/** Hàng đợi hoàn tiền (không có `order_id`): `state` bắt buộc — hàng đợi luôn theo một trạng thái. */
export const AdminRefundQueueQuery = z
  .object({
    state: z.enum(REFUND_STATES),
    ...page,
  })
  .strict();

/** order_id → mã đơn hiển thị (một truy vấn cho cả trang). */
async function displayRefsOf(container: Scope, orderIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return new Map();
  const fins = await checkoutOf(container).listOrderFinances(
    { order_id: ids },
    { select: ["order_id", "display_ref"], take: ids.length },
  );
  return new Map(fins.map((f) => [f.order_id, f.display_ref]));
}

const iso = (d: Date | string | null): string | null => (isNonEmpty(d) ? new Date(d).toISOString() : null);
const sourceOf = (ret: Pick<ReturnWithLines, "idempotency_key">): ReturnSource =>
  isCarrierReturn(ret) ? "carrier" : "request";

/** Danh sách yêu cầu đổi/trả: mới nhất trước, mỗi dòng là bản tóm tắt (tổng số lượng yêu cầu/đã nhận, hoàn tiền). */
export async function listReturnsForAdmin(container: Scope, query: z.output<typeof AdminReturnListQuery>) {
  const svc = returnsOf(container);
  const { limit, offset, source, ...rest } = query;
  const { returns, count, refunds } = await svc.readSnapshot(async (trx) => {
    const page = await svc.listReturns(
      {
        ...rest,
        ...(source && { key_prefix: { prefix: carrierReturnKey(""), match: source === "carrier" } }),
      },
      { limit, offset },
      trx,
    );
    const byReturn = await svc.refundsOfReturns(
      page.returns.map((r) => r.id),
      trx,
    );
    return { ...page, refunds: byReturn };
  });
  const refs = await displayRefsOf(
    container,
    returns.map((r) => r.order_id),
  );
  return {
    returns: returns.map((r) => {
      const refund = refunds.get(r.id);
      const received = r.lines.every((l) => l.received_quantity === null)
        ? null
        : r.lines.reduce((s, l) => s + (l.received_quantity ?? 0), 0);
      return {
        id: r.id,
        kind: r.kind,
        state: r.state,
        reason: r.reason,
        source: sourceOf(r),
        channel: r.channel,
        order_id: r.order_id,
        order_display_ref: refs.get(r.order_id) ?? null,
        line_count: r.lines.length,
        quantity: r.lines.reduce((s, l) => s + l.quantity, 0),
        received_quantity: received,
        created_at: new Date(r.created_at).toISOString(),
        received_at: iso(r.received_at),
        inspected_at: iso(r.inspected_at),
        closed_at: iso(r.closed_at),
        refund: refund ? { id: refund.id, amount: refund.amount, state: refund.state } : null,
      };
    }),
    count,
    limit,
    offset,
  };
}

/**
 * Chi tiết một yêu cầu: hình Admin của `presentReturn` + tên sản phẩm từng dòng, ghi chú kiểm định, mốc thời gian.
 * Không có → 404 NOT_FOUND.
 */
export async function returnDetailForAdmin(container: Scope, returnId: string) {
  const svc = returnsOf(container);
  const snap = await svc.readSnapshot(async (trx) => {
    const found = await svc.getReturn(returnId, trx);
    return found ? { ret: found, refund: await svc.refundOfReturn(returnId, trx) } : null;
  });
  if (!snap) throw new ReturnsError("NOT_FOUND", "Không tìm thấy yêu cầu đổi/trả");
  const { ret } = snap;
  const base = await presentReturn(container, ret, { customer: false, refund: snap.refund });
  // Tên sản phẩm theo dòng đơn (chỉ title/variant_title — không đọc liên hệ/địa chỉ ra phản hồi).
  const titles = new Map<string, { title: string; variant_title: string | null }>();
  let displayRef: string | null = null;
  try {
    const ctx = await loadOrderContext(container, ret.order_id);
    displayRef = ctx.fin.display_ref;
    for (const l of ctx.lines) titles.set(l.id, { title: l.title, variant_title: l.variant_title });
  } catch (e) {
    if (!(e instanceof ReturnsError && e.code === "NOT_FOUND")) throw e;
  }
  const notes = new Map(ret.lines.map((l) => [l.order_line_item_id, l.inspection_note]));
  return {
    ...base,
    order_display_ref: displayRef,
    decided_at: iso(ret.decided_at),
    received_at: iso(ret.received_at),
    inspected_at: iso(ret.inspected_at),
    closed_at: iso(ret.closed_at),
    lines: base.lines.map((l) => ({
      ...l,
      title: titles.get(l.line_id)?.title ?? null,
      variant_title: titles.get(l.line_id)?.variant_title ?? null,
      inspection_note: maskFreeText(notes.get(l.line_id)),
    })),
  };
}

/** Hàng đợi hoàn tiền theo trạng thái trên mọi đơn: cũ nhất trước, kèm mã đơn hiển thị. */
export async function refundQueueForAdmin(container: Scope, query: z.output<typeof AdminRefundQueueQuery>) {
  const { state, limit, offset } = query;
  const svc = returnsOf(container);
  const { refunds, count } = await svc.readSnapshot((trx) =>
    svc.listRefundsByState(state, { limit, offset }, trx),
  );
  const refs = await displayRefsOf(
    container,
    refunds.map((r) => r.order_id),
  );
  return {
    state,
    refunds: refunds.map((r) => ({ ...presentRefund(r), order_display_ref: refs.get(r.order_id) ?? null })),
    count,
    limit,
    offset,
  };
}
