import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { generateEntityId } from "@medusajs/framework/utils";
import type { SettlementState } from "@x-shop/domain";
import {
  AUTO_RESOLVABLE_KINDS,
  DEFAULT_SETTLEMENT_OWNER_ROLE,
  DISCREPANCY_PRIORITY,
  EXCEPTION_OWNER_ROLE,
  LINE_RESULTS,
  SETTLEMENT_CONFIG,
  type DiscrepancyEventAction,
  type DiscrepancyKind,
  type DiscrepancyState,
  type LineResult,
  type Priority,
  type SettlementLineType,
  type SettlementSource,
  type SettlementTargetKind,
} from "./constants";
import type { SettlementRow } from "./csv";
import { classifyLine, nextSettlementState, type SettlementTarget } from "./match";
import { isNonEmpty } from "@x-shop/domain";

export const BATCH_TABLE = "x_settlement_batch";
export const LINE_TABLE = "x_settlement_line";
export const DISCREPANCY_TABLE = "x_settlement_discrepancy";
export const EVENT_TABLE = "x_settlement_discrepancy_event";

type Db = Knex | Knex.Transaction;
type Row = Record<string, unknown>;

/** bigint/numeric của pg về dạng chuỗi → số nguyên VND an toàn (vượt 2^53 là lỗi rõ, không làm tròn lặng lẽ). */
export function toVnd(v: unknown): number {
  const n = v === null || v === undefined ? 0 : Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`Tổng tiền vượt số nguyên an toàn: ${String(v)}`);
  return n;
}
const toVndOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : toVnd(v));
const iso = (v: unknown): string | null =>
  isNonEmpty(v as string | Date | null | undefined) ? new Date(v as string).toISOString() : null;

export interface BatchView {
  id: string;
  source: SettlementSource;
  content_hash: string;
  external_ref: string | null;
  period_end: string | null;
  row_count: number;
  total_amount: number;
  summary: BatchSummary;
  imported_by: string;
  created_at: string;
}

export interface BatchSummary {
  results: Record<LineResult, number>;
  matched_amount: number;
  discrepancies_opened: number;
  missing_opened: number;
  auto_resolved: number;
  shipments_updated: number;
}

export interface LineView {
  id: string;
  line_no: number;
  reference: string;
  type: SettlementLineType;
  amount: number;
  occurred_at: string;
  target_kind: SettlementTargetKind | null;
  target_id: string | null;
  order_id: string | null;
  result: LineResult;
  expected_amount: number | null;
  difference: number | null;
}

export interface DiscrepancyEventView {
  id: string;
  action: DiscrepancyEventAction;
  actor_type: "user" | "system";
  actor_id: string | null;
  batch_id: string | null;
  note: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface DiscrepancyView {
  id: string;
  kind: DiscrepancyKind;
  state: DiscrepancyState;
  priority: Priority;
  source: SettlementSource;
  reference: string;
  target_kind: SettlementTargetKind | null;
  target_id: string | null;
  order_id: string | null;
  expected_amount: number | null;
  actual_amount: number | null;
  difference: number | null;
  amount: number;
  batch_id: string;
  line_id: string | null;
  owner: string | null;
  owner_role: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  evidence_ref: string | null;
  created_at: string;
  updated_at: string;
  events?: DiscrepancyEventView[];
}

const toBatch = (r: Row): BatchView => ({
  id: String(r.id),
  source: r.source as SettlementSource,
  content_hash: String(r.content_hash),
  external_ref: (r.external_ref as string | null) ?? null,
  period_end: iso(r.period_end),
  row_count: Number(r.row_count),
  total_amount: toVnd(r.total_amount),
  summary: r.summary as BatchSummary,
  imported_by: String(r.imported_by),
  created_at: iso(r.created_at) as string,
});

const toLine = (r: Row): LineView => ({
  id: String(r.id),
  line_no: Number(r.line_no),
  reference: String(r.reference),
  type: r.type as SettlementLineType,
  amount: toVnd(r.amount),
  occurred_at: iso(r.occurred_at) as string,
  target_kind: (r.target_kind as SettlementTargetKind | null) ?? null,
  target_id: (r.target_id as string | null) ?? null,
  order_id: (r.order_id as string | null) ?? null,
  result: r.result as LineResult,
  expected_amount: toVndOrNull(r.expected_amount),
  difference: toVndOrNull(r.difference),
});

const toEvent = (r: Row): DiscrepancyEventView => ({
  id: String(r.id),
  action: r.action as DiscrepancyEventAction,
  actor_type: r.actor_type as "user" | "system",
  actor_id: (r.actor_id as string | null) ?? null,
  batch_id: (r.batch_id as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  data: (r.data as Record<string, unknown> | null) ?? null,
  created_at: iso(r.created_at) as string,
});

const toDiscrepancy = (r: Row): DiscrepancyView => ({
  id: String(r.id),
  kind: r.kind as DiscrepancyKind,
  state: r.state as DiscrepancyState,
  priority: r.priority as Priority,
  source: r.source as SettlementSource,
  reference: String(r.reference),
  target_kind: (r.target_kind as SettlementTargetKind | null) ?? null,
  target_id: (r.target_id as string | null) ?? null,
  order_id: (r.order_id as string | null) ?? null,
  expected_amount: toVndOrNull(r.expected_amount),
  actual_amount: toVndOrNull(r.actual_amount),
  difference: toVndOrNull(r.difference),
  amount: toVnd(r.amount),
  batch_id: String(r.batch_id),
  line_id: (r.line_id as string | null) ?? null,
  owner: (r.owner as string | null) ?? null,
  owner_role: DEFAULT_SETTLEMENT_OWNER_ROLE,
  resolved_by: (r.resolved_by as string | null) ?? null,
  resolved_at: iso(r.resolved_at),
  resolution_note: (r.resolution_note as string | null) ?? null,
  evidence_ref: (r.evidence_ref as string | null) ?? null,
  created_at: iso(r.created_at) as string,
  updated_at: iso(r.updated_at) as string,
});

export class SettlementError extends Error {
  override readonly name = "SettlementError";
  constructor(
    readonly code: "BATCH_CONFLICT" | "NOT_FOUND" | "INVALID_STATE",
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ImportBatchInput {
  source: SettlementSource;
  content_hash: string;
  external_ref: string | null;
  period_end: Date | null;
  imported_by: string;
  rows: readonly SettlementRow[];
}

export interface ImportBatchResult {
  batch: BatchView;
  replayed: boolean;
  lines: LineView[];
  discrepancies: DiscrepancyView[];
}

/** Đối tượng hệ thống tìm được cho một dòng (target null = không có gì để khớp; order_id vẫn có thể biết). */
interface Resolution {
  target: SettlementTarget | null;
  order_id: string | null;
}

export interface ReportPeriod {
  from: Date | null;
  to: Date | null;
}

export interface ExceptionFilter {
  source?: "ops" | "settlement" | "cod";
  kind?: string;
  priority?: Priority;
}

export interface ExceptionItem {
  source: "ops" | "settlement" | "cod";
  id: string;
  kind: string;
  order_id: string | null;
  reference: string | null;
  amount: number | null;
  priority: Priority;
  state: string;
  owner: string | null;
  owner_role: string;
  opened_at: string;
  due_at: string | null;
  age_seconds: number;
}

const CHUNK = 500;
/** Trạng thái đơn tính vào "giá trị đơn" của báo cáo (§5.5). */
const COMMITTED_ORDER_STATES = ["placed", "confirmed", "completed"] as const;
/**
 * COD còn phải nhận của vận đơn đã giao: COD − Σ đã đối soát, chỉ khi còn dương. Vận đơn `disputed` vì nhận DƯ không còn
 * phải thu (phần dư nằm ở chênh lệch) → không đếm vào "phải nhận" và không hiện `cod_unsettled`.
 */
const COD_OUTSTANDING_FROM = `shipment s
       left join (select target_id, sum(amount) as settled from ${LINE_TABLE}
                  where source = 'ghn_cod' and target_id is not null group by target_id) st on st.target_id = s.id
       where s.deleted_at is null and s.state = 'delivered' and s.cod_amount > coalesce(st.settled, 0)`;
const PRIORITY_RANK = `case x.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;

/**
 * Module `settlement` (T-028). Knex thô như module returns/audit. Nhập batch chạy trong MỘT transaction giữ
 * `pg_advisory_xact_lock` theo NGUỒN: hai lần nhập (cùng batch hay batch khác cùng nguồn) tuần tự hoá ở Postgres — tổng
 * đã đối soát của mỗi đối tượng đọc và ghi dưới cùng khóa, UNIQUE(source, content_hash) là lưới an toàn cuối.
 *
 * Đọc bảng của module khác (shipment, order_finance, payment_attempt, payment_ledger, x_refund) và cập nhật
 * `shipment.settlement_state` bằng SQL trong CÙNG transaction: trạng thái đối soát của vận đơn đổi nguyên tử với dòng
 * chứng từ (không có cửa sổ "đã nhập nhưng vận đơn chưa cập nhật"). Đây là ngoại lệ có chủ đích về ranh giới module —
 * cột `settlement_state` được module shipping dành cho T-028 (shipping-models.ts) và chỉ đổi ở đây.
 */
export default class SettlementModuleService {
  protected readonly db: Knex;

  constructor({ __pg_connection__ }: { __pg_connection__: Knex }) {
    this.db = __pg_connection__;
  }

  /* ------------------------------------------------------------------ nhập batch */

  async findBatchByHash(
    source: SettlementSource,
    contentHash: string,
    db: Db = this.db,
  ): Promise<BatchView | null> {
    const row = (await db(BATCH_TABLE).where({ source, content_hash: contentHash }).first()) as
      Row | undefined;
    return row ? toBatch(row) : null;
  }

  async importBatch(input: ImportBatchInput): Promise<ImportBatchResult> {
    return this.db.transaction(async (trx) => {
      await trx.raw("select pg_advisory_xact_lock(hashtext(?))", [`x-settlement:${input.source}`]);

      const existing = await this.findBatchByHash(input.source, input.content_hash, trx);
      if (existing) return { ...(await this.batchDetail(existing, trx)), replayed: true };
      if (isNonEmpty(input.external_ref)) {
        const other = (await trx(BATCH_TABLE)
          .where({ source: input.source, external_ref: input.external_ref })
          .first()) as Row | undefined;
        if (other) {
          throw new SettlementError(
            "BATCH_CONFLICT",
            "Mã batch này đã được nhập với nội dung khác — chứng từ đã nhập không sửa được",
            { batch_id: String(other.id) },
          );
        }
      }

      const resolutions = await this.resolveTargets(trx, input.source, input.rows);
      const targetIds = [
        ...new Set([...resolutions.values()].flatMap((r) => (r.target ? [r.target.id] : []))),
      ];
      const running = await this.settledTotals(trx, input.source, targetIds);
      const batchId = generateEntityId(undefined, "xstb");

      const results = Object.fromEntries(LINE_RESULTS.map((r) => [r, 0])) as Record<LineResult, number>;
      let matchedAmount = 0;
      let totalAmount = 0;
      const lines: Row[] = [];
      const discrepancies: Row[] = [];
      for (const row of input.rows) {
        const res = resolutions.get(row.line) ?? { target: null, order_id: null };
        const t = res.target;
        const before = t ? (running.get(t.id) ?? 0) : 0;
        const c = classifyLine(row.amount, t, before);
        if (t) running.set(t.id, before + row.amount);
        results[c.result] += 1;
        totalAmount += row.amount;
        if (c.result === "matched") matchedAmount += row.amount;
        const lineId = generateEntityId(undefined, "xstl");
        lines.push({
          id: lineId,
          batch_id: batchId,
          source: input.source,
          line_no: row.line,
          reference: row.reference,
          type: row.type,
          amount: row.amount,
          occurred_at: row.occurred_at,
          target_kind: t?.kind ?? null,
          target_id: t?.id ?? null,
          order_id: t?.order_id ?? res.order_id,
          result: c.result,
          expected_amount: c.expected,
          difference: c.difference,
        });
        if (c.result !== "matched") {
          discrepancies.push({
            id: generateEntityId(undefined, "xstd"),
            kind: c.result,
            priority: DISCREPANCY_PRIORITY[c.result],
            source: input.source,
            reference: row.reference,
            target_kind: t?.kind ?? null,
            target_id: t?.id ?? null,
            order_id: t?.order_id ?? res.order_id,
            expected_amount: c.expected,
            actual_amount: row.amount,
            difference: c.difference,
            amount: c.exposure,
            batch_id: batchId,
            line_id: lineId,
            dedupe_key: `line:${lineId}`,
          });
        }
      }
      if (!Number.isSafeInteger(totalAmount)) throw new RangeError("Tổng batch vượt số nguyên an toàn");

      const summary: BatchSummary = {
        results,
        matched_amount: matchedAmount,
        discrepancies_opened: discrepancies.length,
        missing_opened: 0,
        auto_resolved: 0,
        shipments_updated: 0,
      };
      return this.persistBatch(
        trx,
        input,
        { batchId, lines, discrepancies, summary, totalAmount },
        resolutions,
        running,
      );
    });
  }

  /**
   * Ghi batch: dòng → chênh lệch (+ "thiếu") → lịch sử → tự đóng → trạng thái vận đơn → CUỐI CÙNG là dòng batch với tóm
   * tắt đã chốt (bảng batch chỉ ghi thêm, không cập nhật được sau). Khóa ngoại tới batch là DEFERRABLE INITIALLY
   * DEFERRED nên kiểm lúc commit.
   */
  private async persistBatch(
    trx: Knex.Transaction,
    input: ImportBatchInput,
    p: { batchId: string; lines: Row[]; discrepancies: Row[]; summary: BatchSummary; totalAmount: number },
    resolutions: Map<number, Resolution>,
    running: Map<string, number>,
  ): Promise<ImportBatchResult> {
    const touched = new Set(
      p.lines.flatMap((l) =>
        isNonEmpty(l.target_id as string | null | undefined) ? [String(l.target_id)] : [],
      ),
    );
    const targets = new Map<string, SettlementTarget>();
    for (const r of resolutions.values()) if (r.target) targets.set(r.target.id, r.target);
    const exactlySettled = [...targets.values()]
      .filter((t) => t.expected > 0 && running.get(t.id) === t.expected)
      .map((t) => t.id);

    for (let i = 0; i < p.lines.length; i += CHUNK) {
      await trx(LINE_TABLE).insert(p.lines.slice(i, i + CHUNK));
    }

    // Chênh lệch từ dòng (dedupe theo dòng — luôn mới) + "thiếu" (dedupe theo đối tượng — đã từng mở thì bỏ qua).
    const opened: string[] = [];
    for (let i = 0; i < p.discrepancies.length; i += CHUNK) {
      const ids = (await trx(DISCREPANCY_TABLE)
        .insert(p.discrepancies.slice(i, i + CHUNK))
        .returning("id")) as Array<{ id: string }>;
      opened.push(...ids.map((r) => r.id));
    }
    const missing = input.period_end
      ? await this.findMissing(trx, input.source, input.period_end, touched)
      : [];
    let missingOpened = 0;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const ids = (await trx(DISCREPANCY_TABLE)
        .insert(
          missing.slice(i, i + CHUNK).map((m) => ({
            id: generateEntityId(undefined, "xstd"),
            kind: "missing",
            priority: DISCREPANCY_PRIORITY.missing,
            source: input.source,
            reference: m.reference,
            target_kind: m.target_kind,
            target_id: m.target_id,
            order_id: m.order_id,
            expected_amount: m.expected,
            actual_amount: 0,
            difference: -m.expected,
            amount: m.expected,
            batch_id: p.batchId,
            line_id: null,
            dedupe_key: `missing:${input.source}:${m.target_id}`,
          })),
        )
        .onConflict("dedupe_key")
        .ignore()
        .returning("id")) as Array<{ id: string }>;
      missingOpened += ids.length;
      opened.push(...ids.map((r) => r.id));
    }
    await this.insertEvents(
      trx,
      opened.map((id) => ({
        discrepancy_id: id,
        action: "opened",
        actor_type: "user",
        actor_id: input.imported_by,
        batch_id: p.batchId,
        note: null,
        data: input.period_end ? { period_end: input.period_end.toISOString() } : null,
      })),
    );

    // Tự đóng: "thiếu" khi đối tượng đã xuất hiện trên chứng từ; "lệch" khi đối tượng đã nhận ĐÚNG đủ (kể cả lệch vừa
    // mở trong chính batch này khi hai dòng cùng trỏ một đối tượng).
    const autoResolved: Row[] = [];
    const closeWhere = async (kinds: readonly DiscrepancyKind[], ids: readonly string[], note: string) => {
      if (ids.length === 0) return;
      autoResolved.push(
        ...((await trx(DISCREPANCY_TABLE)
          .where({ state: "open", source: input.source })
          .whereIn("kind", [...kinds])
          .whereIn("target_id", [...ids])
          .update({
            state: "resolved",
            resolved_at: trx.fn.now(),
            resolution_note: note,
            updated_at: trx.fn.now(),
          })
          .returning(["id", "target_id"])) as Row[]),
      );
    };
    await closeWhere(["missing"], [...touched], "Tự đóng: đã có trên chứng từ");
    await closeWhere(
      AUTO_RESOLVABLE_KINDS.filter((k) => k !== "missing"),
      exactlySettled,
      "Tự đóng: đã nhận đủ số phải nhận",
    );
    await this.insertEvents(
      trx,
      autoResolved.map((r) => ({
        discrepancy_id: String(r.id),
        action: "auto_resolved",
        actor_type: "system",
        actor_id: null,
        batch_id: p.batchId,
        note: null,
        data: { settled_total: running.get(String(r.target_id)) ?? null },
      })),
    );

    // Trạng thái đối soát của vận đơn (S-304) theo tổng đã nhận — đổi có điều kiện, theo máy trạng thái.
    const shipmentIds = [...targets.values()].filter((t) => t.kind === "shipment").map((t) => t.id);
    let shipmentsUpdated = 0;
    if (shipmentIds.length > 0) {
      const shipments = (await trx("shipment")
        .whereIn("id", shipmentIds)
        .select("id", "settlement_state", "cod_amount")
        .forUpdate()) as Row[];
      for (const s of shipments) {
        const from = s.settlement_state as SettlementState;
        const to = nextSettlementState(from, toVnd(s.cod_amount), running.get(String(s.id)) ?? 0);
        if (!to) continue;
        shipmentsUpdated += Number(
          await trx("shipment")
            .where({ id: String(s.id), settlement_state: from })
            .update({ settlement_state: to, updated_at: trx.fn.now() }),
        );
      }
    }

    const summary: BatchSummary = {
      ...p.summary,
      discrepancies_opened: opened.length,
      missing_opened: missingOpened,
      auto_resolved: autoResolved.length,
      shipments_updated: shipmentsUpdated,
    };
    const [batch] = (await trx(BATCH_TABLE)
      .insert({
        id: p.batchId,
        source: input.source,
        content_hash: input.content_hash,
        external_ref: input.external_ref,
        period_end: input.period_end,
        row_count: p.lines.length,
        total_amount: p.totalAmount,
        summary: JSON.stringify(summary),
        imported_by: input.imported_by,
      })
      .returning("*")) as Row[];
    return { ...(await this.batchDetail(toBatch(batch as Row), trx)), replayed: false };
  }

  /** Tìm đối tượng hệ thống cho từng dòng (theo số dòng file). */
  private async resolveTargets(
    trx: Knex.Transaction,
    source: SettlementSource,
    rows: readonly SettlementRow[],
  ): Promise<Map<number, Resolution>> {
    const out = new Map<number, Resolution>();
    const refsOf = (type: SettlementLineType) => [
      ...new Set(rows.filter((r) => r.type === type).map((r) => r.reference)),
    ];
    const cancelled = (state: unknown) => state === "cancelled";

    if (source === "ghn_cod") {
      const refs = refsOf("cod");
      const found = refs.length
        ? ((await trx("shipment as s")
            .leftJoin("order_finance as f", function () {
              this.on("f.order_id", "=", "s.order_id").andOnNull("f.deleted_at");
            })
            .whereNull("s.deleted_at")
            .where((q) => q.whereIn("s.client_order_code", refs).orWhereIn("s.provider_order_code", refs))
            .select(
              "s.id",
              "s.order_id",
              "s.client_order_code",
              "s.provider_order_code",
              "s.cod_amount",
              "f.state as order_state",
            )) as Row[])
        : [];
      for (const row of rows) {
        const s = found.find(
          (x) => x.client_order_code === row.reference || x.provider_order_code === row.reference,
        );
        out.set(row.line, {
          target: s
            ? {
                kind: "shipment",
                id: String(s.id),
                order_id: String(s.order_id),
                expected: toVnd(s.cod_amount),
                order_cancelled: cancelled(s.order_state),
              }
            : null,
          order_id: s ? String(s.order_id) : null,
        });
      }
      return out;
    }

    const payRefs = refsOf("payment");
    const payments = payRefs.length
      ? ((await trx("payment_attempt as pa")
          .leftJoin("payment_ledger as l", function () {
            this.on("l.order_id", "=", "pa.order_id")
              .andOn("l.provider_txn_id", "=", "pa.provider_txn_no")
              .andOnVal("l.kind", "=", "capture")
              .andOnNull("l.deleted_at");
          })
          .leftJoin("order_finance as f", function () {
            this.on("f.order_id", "=", "pa.order_id").andOnNull("f.deleted_at");
          })
          .whereNull("pa.deleted_at")
          .where("pa.provider", "vnpay")
          .whereIn("pa.txn_ref", payRefs)
          .select(
            "pa.txn_ref",
            "pa.order_id",
            "l.id as ledger_id",
            "l.amount as ledger_amount",
            "f.state as order_state",
          )) as Row[])
      : [];
    const refundRefs = refsOf("refund");
    const refunds = refundRefs.length
      ? ((await trx("x_refund")
          .where("method", "provider")
          .whereIn("provider_request_id", refundRefs)
          .select("id", "order_id", "amount", "state", "provider_request_id")) as Row[])
      : [];
    for (const row of rows) {
      if (row.type === "payment") {
        const pa = payments.find((x) => x.txn_ref === row.reference);
        out.set(row.line, {
          target:
            pa && pa.ledger_id != null
              ? {
                  kind: "capture",
                  id: String(pa.ledger_id),
                  order_id: String(pa.order_id),
                  expected: toVnd(pa.ledger_amount),
                  order_cancelled: cancelled(pa.order_state),
                }
              : null,
          order_id: pa ? String(pa.order_id) : null,
        });
      } else {
        const r = refunds.find((x) => x.provider_request_id === row.reference);
        out.set(row.line, {
          target:
            r && r.state === "succeeded"
              ? {
                  kind: "refund",
                  id: String(r.id),
                  order_id: String(r.order_id),
                  expected: toVnd(r.amount),
                  order_cancelled: false,
                }
              : null,
          order_id: r ? String(r.order_id) : null,
        });
      }
    }
    return out;
  }

  /** Tổng tiền đã nhập trước đó theo đối tượng (mọi batch của nguồn). */
  private async settledTotals(
    trx: Knex.Transaction,
    source: SettlementSource,
    targetIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (targetIds.length === 0) return new Map();
    const rows = (await trx(LINE_TABLE)
      .where({ source })
      .whereIn("target_id", [...targetIds])
      .groupBy("target_id")
      .select("target_id")
      .sum({ total: "amount" })) as Row[];
    return new Map(rows.map((r) => [String(r.target_id), toVnd(r.total)]));
  }

  /**
   * "Thiếu": hệ thống có khoản phải nhận phát sinh tới `period_end` mà CHƯA từng xuất hiện trên chứng từ nào của nguồn
   * (kể cả batch đang nhập — `touched`). COD: vận đơn đã giao có COD > 0 chưa settled; VNPAY: khoản thu cổng trong ledger.
   */
  private async findMissing(
    trx: Knex.Transaction,
    source: SettlementSource,
    periodEnd: Date,
    touched: ReadonlySet<string>,
  ): Promise<
    Array<{
      target_kind: SettlementTargetKind;
      target_id: string;
      order_id: string;
      reference: string;
      expected: number;
    }>
  > {
    const limit = SETTLEMENT_CONFIG.maxRows * 2;
    const notSeen = (alias: string) =>
      function (this: Knex.QueryBuilder) {
        this.select(trx.raw("1"))
          .from(`${LINE_TABLE} as sl`)
          .where("sl.source", source)
          .whereRaw(`sl.target_id = ${alias}.id`);
      };
    if (source === "ghn_cod") {
      const rows = (await trx("shipment as s")
        .whereNull("s.deleted_at")
        .where("s.state", "delivered")
        .where("s.cod_amount", ">", 0)
        .where("s.delivered_at", "<=", periodEnd)
        .whereNot("s.settlement_state", "settled")
        .whereNotExists(notSeen("s"))
        .select("s.id", "s.order_id", "s.client_order_code", "s.cod_amount")
        .orderBy("s.delivered_at")
        .limit(limit)) as Row[];
      return rows
        .filter((r) => !touched.has(String(r.id)))
        .map((r) => ({
          target_kind: "shipment" as const,
          target_id: String(r.id),
          order_id: String(r.order_id),
          reference: String(r.client_order_code),
          expected: toVnd(r.cod_amount),
        }));
    }
    const rows = (await trx("payment_ledger as l")
      .join("payment_attempt as pa", function () {
        this.on("pa.order_id", "=", "l.order_id").andOn("pa.provider_txn_no", "=", "l.provider_txn_id");
      })
      .whereNull("l.deleted_at")
      .where({ "l.kind": "capture", "l.provider": "vnpay" })
      .where("l.created_at", "<=", periodEnd)
      .whereNotExists(notSeen("l"))
      .select("l.id", "l.order_id", "l.amount", "pa.txn_ref")
      .orderBy("l.created_at")
      .limit(limit)) as Row[];
    return rows
      .filter((r) => !touched.has(String(r.id)))
      .map((r) => ({
        target_kind: "capture" as const,
        target_id: String(r.id),
        order_id: String(r.order_id),
        reference: String(r.txn_ref),
        expected: toVnd(r.amount),
      }));
  }

  private async insertEvents(
    trx: Knex.Transaction,
    events: Array<{
      discrepancy_id: string;
      action: DiscrepancyEventAction;
      actor_type: "user" | "system";
      actor_id: string | null;
      batch_id: string | null;
      note: string | null;
      data: Record<string, unknown> | null;
    }>,
  ): Promise<void> {
    const rows = events.map((e) => ({
      id: generateEntityId(undefined, "xste"),
      ...e,
      data: e.data ? JSON.stringify(e.data) : null,
    }));
    for (let i = 0; i < rows.length; i += CHUNK) await trx(EVENT_TABLE).insert(rows.slice(i, i + CHUNK));
  }

  /* ------------------------------------------------------------------ đọc batch / chênh lệch */

  private async batchDetail(
    batch: BatchView,
    db: Db,
  ): Promise<{ batch: BatchView; lines: LineView[]; discrepancies: DiscrepancyView[] }> {
    const lines = ((await db(LINE_TABLE).where({ batch_id: batch.id }).orderBy("line_no")) as Row[]).map(
      toLine,
    );
    const discrepancies = (
      (await db(DISCREPANCY_TABLE)
        .where({ batch_id: batch.id })
        .orderBy([{ column: "created_at" }, { column: "id" }])) as Row[]
    ).map(toDiscrepancy);
    return { batch, lines, discrepancies };
  }

  async getBatch(
    id: string,
  ): Promise<{ batch: BatchView; lines: LineView[]; discrepancies: DiscrepancyView[] } | null> {
    const row = (await this.db(BATCH_TABLE).where({ id }).first()) as Row | undefined;
    return row ? this.batchDetail(toBatch(row), this.db) : null;
  }

  async listBatches(
    filter: { source?: SettlementSource },
    page: { limit: number; offset: number },
  ): Promise<{ batches: BatchView[]; count: number }> {
    const base = () => {
      const q = this.db(BATCH_TABLE);
      if (filter.source) q.where({ source: filter.source });
      return q;
    };
    const [{ n } = { n: 0 }] = (await base().count({ n: "*" })) as Array<{ n: string | number }>;
    const rows = (await base()
      .orderBy([
        { column: "created_at", order: "desc" },
        { column: "id", order: "desc" },
      ])
      .limit(page.limit)
      .offset(page.offset)) as Row[];
    return { batches: rows.map(toBatch), count: Number(n) };
  }

  async listDiscrepancies(
    filter: {
      state?: DiscrepancyState;
      kind?: DiscrepancyKind;
      source?: SettlementSource;
      batch_id?: string;
      order_id?: string;
    },
    page: { limit: number; offset: number },
  ): Promise<{ discrepancies: DiscrepancyView[]; count: number }> {
    const base = () => {
      const q = this.db(DISCREPANCY_TABLE);
      for (const [k, v] of Object.entries(filter)) if (v !== undefined) q.where(k, v);
      return q;
    };
    const [{ n } = { n: 0 }] = (await base().count({ n: "*" })) as Array<{ n: string | number }>;
    const rows = (
      (await base()
        .orderBy([
          { column: "created_at", order: "desc" },
          { column: "id", order: "desc" },
        ])
        .limit(page.limit)
        .offset(page.offset)) as Row[]
    ).map(toDiscrepancy);
    const events = rows.length
      ? ((await this.db(EVENT_TABLE)
          .whereIn(
            "discrepancy_id",
            rows.map((r) => r.id),
          )
          .orderBy([{ column: "created_at" }, { column: "id" }])) as Row[])
      : [];
    return {
      discrepancies: rows.map((d) => ({
        ...d,
        events: events.filter((e) => e.discrepancy_id === d.id).map(toEvent),
      })),
      count: Number(n),
    };
  }

  /** Người có quyền đóng chênh lệch có lý do (+ chứng từ) — chuyển có điều kiện `open → resolved`, ghi lịch sử. */
  async resolveDiscrepancy(input: {
    id: string;
    actor_id: string;
    note: string;
    evidence_ref: string | null;
  }): Promise<DiscrepancyView> {
    return this.db.transaction(async (trx) => {
      const [row] = (await trx(DISCREPANCY_TABLE)
        .where({ id: input.id, state: "open" })
        .update({
          state: "resolved",
          resolved_by: input.actor_id,
          resolved_at: trx.fn.now(),
          resolution_note: input.note,
          evidence_ref: input.evidence_ref,
          updated_at: trx.fn.now(),
        })
        .returning("*")) as Row[];
      if (!row) {
        const current = (await trx(DISCREPANCY_TABLE).where({ id: input.id }).first()) as Row | undefined;
        if (!current) throw new SettlementError("NOT_FOUND", "Không tìm thấy chênh lệch");
        throw new SettlementError("INVALID_STATE", "Chênh lệch đã được giải quyết", { state: current.state });
      }
      await this.insertEvents(trx, [
        {
          discrepancy_id: input.id,
          action: "resolved",
          actor_type: "user",
          actor_id: input.actor_id,
          batch_id: null,
          note: input.note,
          data: isNonEmpty(input.evidence_ref) ? { evidence_ref: input.evidence_ref } : null,
        },
      ]);
      const events = (
        (await trx(EVENT_TABLE)
          .where({ discrepancy_id: input.id })
          .orderBy([{ column: "created_at" }, { column: "id" }])) as Row[]
      ).map(toEvent);
      return { ...toDiscrepancy(row), events };
    });
  }

  /* ------------------------------------------------------------------ báo cáo (§5.5, S-406) */

  /**
   * Báo cáo tiền TÁCH theo định nghĩa (§5.5: không dùng chung một số "doanh thu"). Mỗi chỉ số lọc theo thời điểm phát
   * sinh của CHÍNH nó trong [from, to): giá trị đơn theo lúc tạo đơn; đã thu theo lúc ghi ledger/lúc giao; thực nhận theo
   * thời điểm trên chứng từ; đã hoàn theo lúc hoàn thành công. COD phải nhận là ảnh chụp hiện tại (không lọc kỳ).
   */
  async reportSummary(period: ReportPeriod): Promise<Record<string, unknown>> {
    // Tên cột là hằng trong mã (không bao giờ từ request) — ghép vào SQL an toàn; giá trị luôn qua binding.
    const within = (q: Knex.QueryBuilder, col: string) => {
      if (period.from) q.whereRaw(`${col} >= ?`, [period.from]);
      if (period.to) q.whereRaw(`${col} < ?`, [period.to]);
      return q;
    };
    const db = this.db;

    const byState = (await within(
      db("order_finance").whereNull("deleted_at").whereNot("state", "preparing"),
      "created_at",
    )
      .groupBy("state")
      .select("state")
      .count({ n: "*" })
      .sum({ value: "total" })) as Row[];
    const states = byState
      .map((r) => ({ state: String(r.state), count: Number(r.n), value: toVnd(r.value) }))
      .sort((a, b) => a.state.localeCompare(b.state));
    // Giá trị đơn chỉ tính đơn ĐÃ CAM KẾT (placed/confirmed/completed). Đơn `awaiting_payment` (VNPAY chưa trả, hết hạn
    // giữ hàng sẽ thành cancelled) tách riêng — không thổi phồng giá trị đơn bằng đơn có thể không bao giờ thành.
    const valueOf = (pick: readonly string[]) =>
      states.filter((s) => pick.includes(s.state)).reduce((a, s) => a + s.value, 0);
    const orderValue = valueOf(COMMITTED_ORDER_STATES);
    const awaitingPaymentValue = valueOf(["awaiting_payment"]);

    const [cap] = (await within(
      db("payment_ledger").whereNull("deleted_at").where({ kind: "capture" }),
      "created_at",
    ).sum({ v: "amount" })) as Row[];
    const [cod] = (await within(
      db("shipment").whereNull("deleted_at").where("state", "delivered").where("cod_amount", ">", 0),
      "delivered_at",
    ).sum({ v: "cod_amount" })) as Row[];
    const online = toVnd(cap?.v);
    const codDelivered = toVnd(cod?.v);

    const cash = (await within(db(LINE_TABLE), "occurred_at")
      .groupBy("source", "type")
      .select("source", "type")
      .sum({ v: "amount" })) as Row[];
    const cashOf = (source: SettlementSource, type: SettlementLineType) =>
      toVnd(cash.find((r) => r.source === source && r.type === type)?.v);
    const cashCod = cashOf("ghn_cod", "cod");
    const cashVnpay = cashOf("vnpay", "payment");

    const refunds = (await within(
      db("x_refund").where("state", "succeeded"),
      "coalesce(succeeded_at, updated_at)",
    )
      .groupBy("method")
      .select("method")
      .sum({ v: "amount" })) as Row[];
    const refundOf = (m: string) => toVnd(refunds.find((r) => r.method === m)?.v);

    const receivable = await this.codReceivable(db);
    const [disc] = (await db(DISCREPANCY_TABLE)
      .where({ state: "open" })
      .count({ n: "*" })
      .sum({ v: "amount" })) as Row[];

    return {
      period: { from: period.from?.toISOString() ?? null, to: period.to?.toISOString() ?? null },
      orders: { by_state: states, count: states.reduce((a, s) => a + s.count, 0) },
      /** Giá trị đơn: Σ tổng đơn đã cam kết (placed/confirmed/completed) — không phải tiền đã nhận. */
      order_value: orderValue,
      /** Đơn online đang chờ thanh toán — chưa tính vào giá trị đơn. */
      awaiting_payment_value: awaitingPaymentValue,
      /** Đã thu theo hệ thống: khoản thu cổng đã xác minh (ledger) + COD hãng đã thu khi giao (chưa chắc đã chuyển về). */
      collected: { total: online + codDelivered, online, cod_delivered: codDelivered },
      /** Thực nhận theo chứng từ đối soát đã nhập. */
      cash_received: { total: cashCod + cashVnpay, cod: cashCod, vnpay: cashVnpay },
      /** Đã hoàn thành công (qua cổng + ngoài hệ thống có chứng từ). */
      refunded: {
        total: refundOf("provider") + refundOf("manual"),
        provider: refundOf("provider"),
        manual: refundOf("manual"),
        statement_refunds: cashOf("vnpay", "refund"),
      },
      /** COD hãng đã thu khi giao nhưng chưa đối soát đủ (AT14) — ảnh chụp hiện tại. */
      cod_receivable: receivable,
      discrepancies_open: { count: Number(disc?.n ?? 0), amount: toVnd(disc?.v) },
    };
  }

  private async codReceivable(db: Db): Promise<{ shipments: number; amount: number }> {
    const r = (await db.raw(
      `select count(*)::int as n,
              coalesce(sum(s.cod_amount - coalesce(st.settled, 0)), 0)::bigint as amount
       from ${COD_OUTSTANDING_FROM}`,
    )) as { rows: Row[] };
    const row = r.rows[0] ?? {};
    return { shipments: Number(row.n ?? 0), amount: toVnd(row.amount) };
  }

  /**
   * Dashboard ngoại lệ (§5.5, S-406): ngoại lệ vận hành còn mở (ops_exception) + chênh lệch đối soát còn mở + COD đã
   * giao chưa đối soát đủ — một danh sách có owner/vai trò phụ trách, ưu tiên, thời điểm mở và tuổi; ưu tiên cao trước,
   * cũ trước.
   */
  async listExceptions(
    filter: ExceptionFilter,
    page: { limit: number; offset: number },
    now: Date = new Date(),
  ): Promise<{
    items: ExceptionItem[];
    count: number;
    by_kind: Array<{ source: string; kind: string; count: number; amount: number }>;
  }> {
    const union = `
      select 'ops' as source, o.id, o.kind, o.order_id, null::text as reference, o.amount::bigint as amount,
             o.priority, o.state, o.owner, o.created_at as opened_at, o.due_at
        from ops_exception o where o.deleted_at is null and o.state in ('open', 'in_progress')
      union all
      select 'settlement', d.id, d.kind, d.order_id, d.reference, d.amount, d.priority, d.state, d.owner,
             d.created_at, null::timestamptz
        from ${DISCREPANCY_TABLE} d where d.state = 'open'
      union all
      select 'cod', s.id, 'cod_unsettled', s.order_id, s.client_order_code,
             (s.cod_amount - coalesce(st.settled, 0))::bigint, 'normal', 'open', null::text,
             coalesce(s.delivered_at, s.updated_at), null::timestamptz
        from ${COD_OUTSTANDING_FROM}`;
    const where = `where (?::text is null or x.source = ?) and (?::text is null or x.kind = ?)
                     and (?::text is null or x.priority = ?)`;
    const params = [
      filter.source ?? null,
      filter.source ?? null,
      filter.kind ?? null,
      filter.kind ?? null,
      filter.priority ?? null,
      filter.priority ?? null,
    ];
    const items = (await this.db.raw(
      `select x.* from (${union}) x ${where} order by ${PRIORITY_RANK}, x.opened_at asc, x.id asc limit ? offset ?`,
      [...params, page.limit, page.offset],
    )) as { rows: Row[] };
    const groups = (await this.db.raw(
      `select x.source, x.kind, count(*)::int as n, coalesce(sum(x.amount), 0)::bigint as amount
         from (${union}) x ${where} group by x.source, x.kind order by x.source, x.kind`,
      params,
    )) as { rows: Row[] };
    const byKind = groups.rows.map((g) => ({
      source: String(g.source),
      kind: String(g.kind),
      count: Number(g.n),
      amount: toVnd(g.amount),
    }));
    return {
      items: items.rows.map((r) => {
        const source = r.source as ExceptionItem["source"];
        const opened = new Date(r.opened_at as string);
        return {
          source,
          id: String(r.id),
          kind: String(r.kind),
          order_id: (r.order_id as string | null) ?? null,
          reference: (r.reference as string | null) ?? null,
          amount: toVndOrNull(r.amount),
          priority: r.priority as Priority,
          state: String(r.state),
          owner: (r.owner as string | null) ?? null,
          owner_role:
            source === "settlement"
              ? DEFAULT_SETTLEMENT_OWNER_ROLE
              : (EXCEPTION_OWNER_ROLE[String(r.kind)] ?? "owner"),
          opened_at: opened.toISOString(),
          due_at: iso(r.due_at),
          age_seconds: Math.max(0, Math.floor((now.getTime() - opened.getTime()) / 1000)),
        };
      }),
      count: byKind.reduce((a, g) => a + g.count, 0),
      by_kind: byKind,
    };
  }
}
