import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { generateEntityId } from "@medusajs/framework/utils";
import type { RefundState, ReturnState } from "@x-shop/domain";
import {
  orderLockKey,
  type RefundMethod,
  type RefundReason,
  type ReturnKind,
  type ReturnReason,
} from "./constants";
import { isNonEmpty } from "@x-shop/domain";

export const RETURN_TABLE = "x_return";
export const RETURN_LINE_TABLE = "x_return_line";
export const REFUND_TABLE = "x_refund";
export const ORDER_CANCEL_TABLE = "x_order_cancel";

export interface ReturnRow {
  id: string;
  order_id: string;
  kind: ReturnKind;
  state: ReturnState;
  reason: ReturnReason;
  note: string | null;
  channel: "customer" | "staff";
  requested_by: string | null;
  idempotency_key: string;
  payload_hash: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  received_by: string | null;
  received_at: Date | null;
  inspected_by: string | null;
  inspected_at: Date | null;
  closed_at: Date | null;
  replacement_order_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SizeChartSnapshot {
  id: string;
  code: string;
  version: number;
}

export interface ReturnLineRow {
  id: string;
  return_id: string;
  order_line_item_id: string;
  variant_id: string | null;
  quantity: number;
  exchange_variant_id: string | null;
  size_chart: SizeChartSnapshot | null;
  received_quantity: number | null;
  restock_quantity: number | null;
  damaged_quantity: number | null;
  rejected_quantity: number | null;
  refund_amount: number | null;
  inspection_note: string | null;
}

export interface ReturnWithLines extends ReturnRow {
  lines: ReturnLineRow[];
}

export interface RefundRow {
  id: string;
  order_id: string;
  return_id: string | null;
  reason: RefundReason;
  amount: number;
  method: RefundMethod;
  provider: string;
  capture_ref: string | null;
  state: RefundState;
  approval_required: boolean;
  requested_by: string;
  approved_by: string | null;
  approved_at: Date | null;
  rejected_by: string | null;
  rejected_at: Date | null;
  reject_reason: string | null;
  executed_by: string | null;
  provider_request_id: string;
  provider_ref: string | null;
  evidence_ref: string | null;
  attempts: number;
  last_error: string | null;
  note: string | null;
  idempotency_key: string;
  payload_hash: string;
  succeeded_at: Date | null;
  cancelled_by: string | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Lệnh hủy đơn của nhân viên theo Idempotency-Key (T-044). */
export interface OrderCancelRow {
  id: string;
  order_id: string;
  idempotency_key: string;
  payload_hash: string;
  actor_id: string;
  reason: string;
  outcome: "cancelled" | "already_cancelled";
  from_state: string | null;
  refund_requested: boolean;
  refund_id: string | null;
  created_at: Date;
}

export type NewOrderCancel = Omit<OrderCancelRow, "id" | "created_at">;

/** Phân trang cho danh sách đọc của Admin (route kiểm khoảng hợp lệ trước khi gọi). */
export interface ListPage {
  limit: number;
  offset: number;
}

/**
 * Lọc danh sách yêu cầu đổi/trả (T-049). `key_prefix`: lọc theo tiền tố khóa chống trùng do server đặt (yêu cầu hàng
 * hoàn từ hãng — tiền tố do workflow quyết, module không biết nghĩa): `match=true` chỉ lấy khóa có tiền tố, `false` loại.
 */
export interface ReturnListFilter {
  state?: ReturnState;
  order_id?: string;
  key_prefix?: { prefix: string; match: boolean };
}

export type NewReturn = Pick<
  ReturnRow,
  "order_id" | "kind" | "reason" | "note" | "channel" | "requested_by" | "idempotency_key" | "payload_hash"
>;
export type NewReturnLine = Pick<
  ReturnLineRow,
  "order_line_item_id" | "variant_id" | "quantity" | "exchange_variant_id" | "size_chart"
>;
export type NewRefund = Pick<
  RefundRow,
  | "order_id"
  | "return_id"
  | "reason"
  | "amount"
  | "method"
  | "provider"
  | "capture_ref"
  | "state"
  | "approval_required"
  | "requested_by"
  | "approved_by"
  | "approved_at"
  | "note"
  | "idempotency_key"
  | "payload_hash"
>;

type Db = Knex | Knex.Transaction;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toLine(r: Record<string, unknown>): ReturnLineRow {
  return {
    id: String(r.id),
    return_id: String(r.return_id),
    order_line_item_id: String(r.order_line_item_id),
    variant_id: (r.variant_id as string | null) ?? null,
    quantity: Number(r.quantity),
    exchange_variant_id: (r.exchange_variant_id as string | null) ?? null,
    size_chart: (r.size_chart as SizeChartSnapshot | null) ?? null,
    received_quantity: num(r.received_quantity),
    restock_quantity: num(r.restock_quantity),
    damaged_quantity: num(r.damaged_quantity),
    rejected_quantity: num(r.rejected_quantity),
    refund_amount: num(r.refund_amount),
    inspection_note: (r.inspection_note as string | null) ?? null,
  };
}

const toRefund = (r: Record<string, unknown>): RefundRow =>
  ({ ...r, amount: Number(r.amount), attempts: Number(r.attempts) }) as unknown as RefundRow;

/**
 * Module `returns` (T-027): yêu cầu đổi/trả theo dòng, kết quả kiểm định, hoàn tiền. Knex thô như module audit — mỗi
 * thao tác ghi là một câu SQL có điều kiện trạng thái (`UPDATE … WHERE state IN (…)`), nên hai request đua nhau chỉ một
 * bên thắng. Thao tác cần đọc-rồi-ghi theo đơn (tổng hoàn ≤ đã thu, tổng số lượng trả ≤ đã giao) chạy trong transaction
 * giữ `pg_advisory_xact_lock` theo đơn (`lockOrder`) — tuần tự hoá ở Postgres, không phụ thuộc khóa Redis.
 */
export default class ReturnsModuleService {
  protected readonly db: Knex;

  constructor({ __pg_connection__ }: { __pg_connection__: Knex }) {
    this.db = __pg_connection__;
  }

  transaction<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  /**
   * Đọc nhiều truy vấn trên CÙNG một bản chụp (REPEATABLE READ, chỉ đọc) — trạng thái yêu cầu, dòng hàng và hoàn tiền
   * không lệch nhau khi một thao tác ghi commit giữa các câu đọc (T-049).
   */
  readSnapshot<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn, { isolationLevel: "repeatable read", readOnly: true });
  }

  /**
   * Khóa advisory theo đơn trong transaction hiện tại (tự nhả khi commit/rollback). Trigger trên `x_refund` (T-052) từ
   * chối ghi làm tăng tiền chiếm chỗ khi phiên không giữ đúng khóa này — khóa phải lấy TRƯỚC khi gọi `insertRefund`.
   */
  async lockOrder(trx: Knex.Transaction, orderId: string): Promise<void> {
    await trx.raw("select pg_advisory_xact_lock(hashtext(?))", [orderLockKey(orderId)]);
  }

  /* ------------------------------------------------------------------ đổi/trả */

  async findReturnByKey(key: string, db: Db = this.db): Promise<ReturnRow | null> {
    const row = await db(RETURN_TABLE).where({ idempotency_key: key }).first();
    return (row as ReturnRow | undefined) ?? null;
  }

  async getReturn(id: string, db: Db = this.db): Promise<ReturnWithLines | null> {
    const row = (await db(RETURN_TABLE).where({ id }).first()) as ReturnRow | undefined;
    if (!row) return null;
    const lines = await db(RETURN_LINE_TABLE).where({ return_id: id }).orderBy("id");
    return { ...row, lines: (lines as Record<string, unknown>[]).map(toLine) };
  }

  async listReturnsOfOrder(orderId: string, db: Db = this.db): Promise<ReturnWithLines[]> {
    const rows = (await db(RETURN_TABLE)
      .where({ order_id: orderId })
      .orderBy([{ column: "created_at" }, { column: "id" }])) as ReturnRow[];
    if (rows.length === 0) return [];
    const lines = (
      (await db(RETURN_LINE_TABLE)
        .whereIn(
          "return_id",
          rows.map((r) => r.id),
        )
        .orderBy("id")) as Record<string, unknown>[]
    ).map(toLine);
    return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.return_id === r.id) }));
  }

  /**
   * Danh sách yêu cầu đổi/trả cho Admin (T-049): lọc trạng thái/đơn/tiền tố khóa, mới nhất trước (created_at desc, id
   * desc — thứ tự ổn định khi trùng mốc), kèm dòng hàng (một truy vấn cho cả trang) và tổng số khớp lọc.
   */
  async listReturns(
    filter: ReturnListFilter,
    page: ListPage,
    db: Db = this.db,
  ): Promise<{ returns: ReturnWithLines[]; count: number }> {
    const where = (q: Knex.QueryBuilder) => {
      if (filter.state) q.where("state", filter.state);
      if (isNonEmpty(filter.order_id)) q.where("order_id", filter.order_id);
      if (filter.key_prefix) {
        const sql = `starts_with("idempotency_key", ?)`;
        if (filter.key_prefix.match) q.whereRaw(sql, [filter.key_prefix.prefix]);
        else q.whereRaw(`not ${sql}`, [filter.key_prefix.prefix]);
      }
      return q;
    };
    const [rows, total] = await Promise.all([
      (async () =>
        (await where(db(RETURN_TABLE).select("*"))
          .orderBy([
            { column: "created_at", order: "desc" },
            { column: "id", order: "desc" },
          ])
          .limit(page.limit)
          .offset(page.offset)) as ReturnRow[])(),
      (async () =>
        (await where(db(RETURN_TABLE)).count({ n: "*" }).first()) as { n: string | number } | undefined)(),
    ]);
    const count = Number(total?.n ?? 0);
    if (rows.length === 0) return { returns: [], count };
    const lines = (
      (await db(RETURN_LINE_TABLE)
        .whereIn(
          "return_id",
          rows.map((r) => r.id),
        )
        .orderBy("id")) as Record<string, unknown>[]
    ).map(toLine);
    return { returns: rows.map((r) => ({ ...r, lines: lines.filter((l) => l.return_id === r.id) })), count };
  }

  /**
   * Số lượng đã cam kết trả theo dòng đơn (mọi yêu cầu chưa bị từ chối). Dùng dưới `lockOrder` để chặn trả vượt số đã
   * giao khi hai yêu cầu đến cùng lúc.
   */
  async committedQuantities(orderId: string, db: Db = this.db): Promise<Map<string, number>> {
    const rows = (await db(RETURN_LINE_TABLE)
      .join(RETURN_TABLE, `${RETURN_TABLE}.id`, `${RETURN_LINE_TABLE}.return_id`)
      .where(`${RETURN_TABLE}.order_id`, orderId)
      .whereNot(`${RETURN_TABLE}.state`, "rejected")
      .groupBy(`${RETURN_LINE_TABLE}.order_line_item_id`)
      .select(`${RETURN_LINE_TABLE}.order_line_item_id as line`)
      .sum({ qty: `${RETURN_LINE_TABLE}.quantity` })) as Array<{ line: string; qty: string | number }>;
    return new Map(rows.map((r) => [r.line, Number(r.qty)]));
  }

  /**
   * Theo dòng đơn, trên các yêu cầu ĐÃ kiểm định (trừ `excludeReturnId`): số đơn vị được chấp nhận (restock + damaged) và
   * số tiền hoàn đã gán. Dùng để tính hoàn lũy kế — tổng mọi lần trả của một dòng đúng bằng phần thực trả (PRICE03).
   */
  async acceptedByLine(
    trx: Db,
    orderId: string,
    excludeReturnId: string,
  ): Promise<Map<string, { accepted: number; refunded: number }>> {
    const rows = (await trx(RETURN_LINE_TABLE)
      .join(RETURN_TABLE, `${RETURN_TABLE}.id`, `${RETURN_LINE_TABLE}.return_id`)
      .where(`${RETURN_TABLE}.order_id`, orderId)
      .whereNot(`${RETURN_TABLE}.id`, excludeReturnId)
      .whereNotNull(`${RETURN_LINE_TABLE}.restock_quantity`)
      .groupBy(`${RETURN_LINE_TABLE}.order_line_item_id`)
      .select(`${RETURN_LINE_TABLE}.order_line_item_id as line`)
      .sum({
        accepted: trx.raw(
          `"${RETURN_LINE_TABLE}"."restock_quantity" + "${RETURN_LINE_TABLE}"."damaged_quantity"`,
        ),
      })
      .sum({ refunded: trx.raw(`coalesce("${RETURN_LINE_TABLE}"."refund_amount", 0)`) })) as Array<{
      line: string;
      accepted: string | number;
      refunded: string | number;
    }>;
    return new Map(rows.map((r) => [r.line, { accepted: Number(r.accepted), refunded: Number(r.refunded) }]));
  }

  async insertReturn(trx: Db, input: NewReturn, lines: NewReturnLine[]): Promise<ReturnWithLines> {
    const [row] = (await trx(RETURN_TABLE)
      .insert({ id: generateEntityId(undefined, "xret"), ...input })
      .returning("*")) as ReturnRow[];
    const ret = row as ReturnRow;
    const inserted = (await trx(RETURN_LINE_TABLE)
      .insert(
        lines.map((l) => ({
          id: generateEntityId(undefined, "xretl"),
          return_id: ret.id,
          ...l,
          size_chart: l.size_chart ? JSON.stringify(l.size_chart) : null,
        })),
      )
      .returning("*")) as Record<string, unknown>[];
    return { ...ret, lines: inserted.map(toLine).sort((a, b) => (a.id < b.id ? -1 : 1)) };
  }

  /** Chuyển trạng thái yêu cầu nếu còn ở một trong `from` (khóa lạc quan). null = không còn ở `from`. */
  async updateReturn(
    db: Db | null,
    id: string,
    from: readonly ReturnState[],
    patch: Partial<ReturnRow>,
  ): Promise<ReturnRow | null> {
    const d = db ?? this.db;
    const [row] = (await d(RETURN_TABLE)
      .where({ id })
      .whereIn("state", [...from])
      .update({ ...patch, updated_at: d.fn.now() })
      .returning("*")) as ReturnRow[];
    return row ?? null;
  }

  async updateLine(
    db: Db,
    id: string,
    patch: Partial<Omit<ReturnLineRow, "id" | "return_id" | "size_chart">>,
  ): Promise<void> {
    await db(RETURN_LINE_TABLE)
      .where({ id })
      .update({ ...patch, updated_at: db.fn.now() });
  }

  /* ------------------------------------------------------------------ hoàn tiền */

  async findRefundByKey(key: string, db: Db = this.db): Promise<RefundRow | null> {
    const row = (await db(REFUND_TABLE).where({ idempotency_key: key }).first()) as
      Record<string, unknown> | undefined;
    return row ? toRefund(row) : null;
  }

  async getRefund(id: string, db: Db = this.db): Promise<RefundRow | null> {
    const row = (await db(REFUND_TABLE).where({ id }).first()) as Record<string, unknown> | undefined;
    return row ? toRefund(row) : null;
  }

  /** Hoàn tiền của một yêu cầu trả: bản còn hiệu lực trước (bản `cancelled` chỉ còn là lịch sử — T-044). */
  async refundOfReturn(returnId: string, db: Db = this.db): Promise<RefundRow | null> {
    const row = (await db(REFUND_TABLE)
      .where({ return_id: returnId })
      .orderByRaw(`("state" = 'cancelled') asc, "created_at" desc, "id" desc`)
      .first()) as Record<string, unknown> | undefined;
    return row ? toRefund(row) : null;
  }

  /** `refundOfReturn` cho nhiều yêu cầu trả một lần (danh sách Admin — không N+1): return_id → bản còn hiệu lực trước. */
  async refundsOfReturns(returnIds: readonly string[], db: Db = this.db): Promise<Map<string, RefundRow>> {
    if (returnIds.length === 0) return new Map();
    const rows = (await db(REFUND_TABLE)
      .distinctOn("return_id")
      .whereIn("return_id", [...returnIds])
      .orderByRaw(`"return_id", ("state" = 'cancelled') asc, "created_at" desc, "id" desc`)) as Record<
      string,
      unknown
    >[];
    return new Map(rows.map((r) => [String(r.return_id), toRefund(r)]));
  }

  /**
   * Hàng đợi hoàn tiền theo trạng thái, mọi đơn (T-049 — vd. `requested` chờ duyệt). Cũ nhất trước (created_at asc, id
   * asc): hàng đợi xử lý theo thứ tự đến, yêu cầu chờ lâu không bị đẩy xuống trang sau.
   */
  async listRefundsByState(
    state: RefundState,
    page: ListPage,
    db: Db = this.db,
  ): Promise<{ refunds: RefundRow[]; count: number }> {
    const [rows, total] = await Promise.all([
      (async () =>
        (await db(REFUND_TABLE)
          .where({ state })
          .orderBy([
            { column: "created_at", order: "asc" },
            { column: "id", order: "asc" },
          ])
          .limit(page.limit)
          .offset(page.offset)) as Record<string, unknown>[])(),
      (async () =>
        (await db(REFUND_TABLE).where({ state }).count({ n: "*" }).first()) as
          { n: string | number } | undefined)(),
    ]);
    return { refunds: rows.map(toRefund), count: Number(total?.n ?? 0) };
  }

  async listRefundsOfOrder(orderId: string, db: Db = this.db): Promise<RefundRow[]> {
    const rows = (await db(REFUND_TABLE)
      .where({ order_id: orderId })
      .orderBy([{ column: "created_at" }, { column: "id" }])) as Record<string, unknown>[];
    return rows.map(toRefund);
  }

  async insertRefund(trx: Db, input: NewRefund): Promise<RefundRow> {
    const id = generateEntityId(undefined, "xrfd");
    // vnp_RequestId: ổn định suốt đời refund (retry/query dùng lại — không tạo refund mới ở cổng).
    const providerRequestId = `RF${id.replace(/[^A-Za-z0-9]/g, "").slice(-30)}`;
    const [row] = (await trx(REFUND_TABLE)
      .insert({ id, provider_request_id: providerRequestId, ...input })
      .returning("*")) as Record<string, unknown>[];
    return toRefund(row as Record<string, unknown>);
  }

  /**
   * Chuyển trạng thái hoàn tiền nếu còn ở một trong `from` (và, khi có `expect_attempts`, số lần đã gửi cổng vẫn đúng
   * bằng giá trị đó — CAS cho quyết định dựa trên "chưa từng gửi", T-169). null = nhánh khác đã chuyển trước.
   */
  async updateRefund(
    db: Db | null,
    id: string,
    from: readonly RefundState[],
    patch: Partial<RefundRow> & { attempts_increment?: boolean; expect_attempts?: number },
  ): Promise<RefundRow | null> {
    const d = db ?? this.db;
    const { attempts_increment, expect_attempts, ...rest } = patch;
    const [row] = (await d(REFUND_TABLE)
      .where({ id })
      .whereIn("state", [...from])
      .modify((q) => {
        if (expect_attempts !== undefined) q.where("attempts", expect_attempts);
      })
      .update({
        ...rest,
        ...(attempts_increment === true && { attempts: d.raw('"attempts" + 1') }),
        updated_at: d.fn.now(),
      })
      .returning("*")) as Record<string, unknown>[];
    return row ? toRefund(row) : null;
  }

  /* ------------------------------------------------------------------ hủy đơn bởi nhân viên (T-044) */

  async findOrderCancelByKey(key: string, db: Db = this.db): Promise<OrderCancelRow | null> {
    const row = await db(ORDER_CANCEL_TABLE).where({ idempotency_key: key }).first();
    return (row as OrderCancelRow | undefined) ?? null;
  }

  /** Ghi lệnh hủy; trùng `idempotency_key` (request song song cùng khóa) → lỗi 23505 cho caller đọc lại bản thắng. */
  async insertOrderCancel(input: NewOrderCancel, db: Db = this.db): Promise<OrderCancelRow> {
    const [row] = (await db(ORDER_CANCEL_TABLE)
      .insert({ id: generateEntityId(undefined, "xocn"), ...input })
      .returning("*")) as OrderCancelRow[];
    return row as OrderCancelRow;
  }
}
