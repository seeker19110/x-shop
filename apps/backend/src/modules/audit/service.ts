import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { generateEntityId } from "@medusajs/framework/utils";
import { maskFreeText, sanitizeChanges, sanitizeUserAgent } from "../../lib/audit/sanitize";

export const AUDIT_TABLE = "audit_log";
export const ADJUSTMENT_TABLE = "inventory_adjustment";

export interface InventoryAdjustment {
  id: string;
  idempotency_key: string;
  payload_hash: string;
  actor_id: string | null;
  inventory_item_id: string;
  location_id: string;
  delta: number;
  reason: string;
  note: string | null;
  stocked_before: number;
  stocked_after: number;
  reserved_quantity: number;
  created_at: Date;
}

/** Vi phạm UNIQUE của Postgres (23505) — trùng Idempotency-Key khi hai request cùng khóa chạy song song. */
export const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";

/** Kết quả của hành động (SEC-LOG-002 `outcome`, CMP-AUDIT-002 `result`) — CHECK ở DB (Migration20261026210000). */
export const AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const isAuditOutcome = (v: unknown): v is AuditOutcome =>
  typeof v === "string" && (AUDIT_OUTCOMES as readonly string[]).includes(v);

/**
 * Kết quả mặc định theo hành động cho người gọi có sẵn (ghi trước T-091, không truyền `outcome`) mà tên hành động đã nói
 * lên kết quả: bị từ chối quyền, thất bại. Còn lại `success` (hành động nghiệp vụ đã thực hiện — kể cả quyết định "từ
 * chối" yêu cầu đổi/trả của nhân viên, vì đó là thao tác thành công). Người gọi mới truyền `outcome` tường minh.
 */
const DEFAULT_OUTCOMES: Readonly<Record<string, AuditOutcome>> = {
  "rbac.denied": "denied",
  "refund.failed": "failure",
  "catalog.import.commit_rejected": "failure",
  "catalog.import.commit_failed": "failure",
};

export function defaultOutcomeOf(action: string): AuditOutcome {
  return Object.hasOwn(DEFAULT_OUTCOMES, action) ? (DEFAULT_OUTCOMES[action] as AuditOutcome) : "success";
}

export interface AuditEntryInput {
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  reason?: string | null;
  /** Được che PII trước khi ghi (sanitizeChanges) — người gọi không cần tự che. */
  changes?: Record<string, unknown>;
  /** = `trace_id` của request (cùng mã trong log và problem+json, lib/errors/trace.ts). */
  request_id?: string | null;
  ip_hash?: string | null;
  /** Mặc định theo `defaultOutcomeOf(action)`. */
  outcome?: AuditOutcome;
  /** Cắt ngắn ≤ 256 ký tự và che PII ở service (sanitizeUserAgent) — người gọi truyền header thô. */
  user_agent?: string | null;
}

export interface AuditEntry {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  reason: string | null;
  changes: Record<string, unknown>;
  request_id: string | null;
  ip_hash: string | null;
  /** NULL chỉ ở dòng ghi trước T-091. */
  outcome: AuditOutcome | null;
  user_agent: string | null;
  created_at: Date;
}

export interface AuditListFilter {
  action?: string;
  outcome?: AuditOutcome;
  actor_id?: string;
  resource_type?: string;
  resource_id?: string;
  /** = trace_id (tra một request cụ thể). */
  request_id?: string;
}

const clip = (v: string | null | undefined, max: number): string | null =>
  v === undefined || v === null ? null : v.slice(0, max);

/**
 * Audit log chỉ ghi thêm (T-025). Service chỉ có `record` và đọc — không có hàm sửa/xoá; DB có trigger chặn
 * UPDATE/DELETE (migration). Knex thô như module catalog-index: một câu INSERT, không cần ORM.
 */
export default class AuditModuleService {
  protected readonly db: Knex;

  constructor({ __pg_connection__ }: { __pg_connection__: Knex }) {
    this.db = __pg_connection__;
  }

  async record(entry: AuditEntryInput, trx?: Knex.Transaction): Promise<AuditEntry> {
    const action = clip(entry.action, 128) ?? "unknown";
    const row = {
      id: generateEntityId(undefined, "audit"),
      actor_type: clip(entry.actor_type, 32) ?? "unknown",
      actor_id: clip(entry.actor_id, 128),
      action,
      resource_type: clip(entry.resource_type, 64) ?? "unknown",
      resource_id: clip(entry.resource_id, 256),
      reason: clip(maskFreeText(entry.reason), 1000),
      changes: JSON.stringify(sanitizeChanges(entry.changes ?? {})),
      request_id: clip(entry.request_id, 128),
      ip_hash: clip(entry.ip_hash, 128),
      outcome: isAuditOutcome(entry.outcome) ? entry.outcome : defaultOutcomeOf(action),
      user_agent: sanitizeUserAgent(entry.user_agent),
    };
    const [saved] = await (trx ?? this.db)(AUDIT_TABLE).insert(row).returning("*");
    return saved as AuditEntry;
  }

  async list(
    filter: AuditListFilter,
    page: { limit: number; offset: number },
  ): Promise<{ entries: AuditEntry[]; count: number }> {
    const where = Object.fromEntries(
      Object.entries(filter).filter(([, v]) => typeof v === "string" && v !== ""),
    );
    const [entries, counted] = await Promise.all([
      this.db(AUDIT_TABLE)
        .select("*")
        .where(where)
        .orderBy([
          { column: "created_at", order: "desc" },
          { column: "id", order: "desc" },
        ])
        .limit(page.limit)
        .offset(page.offset),
      this.db(AUDIT_TABLE).where(where).count<{ count: string }[]>({ count: "*" }),
    ]);
    return { entries: entries as AuditEntry[], count: Number(counted[0]?.count ?? 0) };
  }

  async findAdjustmentByKey(key: string): Promise<InventoryAdjustment | null> {
    const row = await this.db(ADJUSTMENT_TABLE).where({ idempotency_key: key }).first();
    return (row as InventoryAdjustment | undefined) ?? null;
  }

  /** Ghi sổ điều chỉnh + dòng audit trong MỘT giao dịch (cả hai hoặc không). Trùng khóa → ném lỗi 23505. */
  async recordAdjustment(
    adjustment: Omit<InventoryAdjustment, "id" | "created_at">,
    audit: Omit<AuditEntryInput, "resource_type" | "resource_id" | "action" | "changes">,
  ): Promise<InventoryAdjustment> {
    return this.db.transaction(async (trx) => {
      const [saved] = await trx(ADJUSTMENT_TABLE)
        .insert({ id: generateEntityId(undefined, "invadj"), ...adjustment })
        .returning("*");
      const row = saved as InventoryAdjustment;
      await this.record(
        {
          ...audit,
          action: "inventory.adjusted",
          resource_type: "inventory_level",
          resource_id: `${row.inventory_item_id}:${row.location_id}`,
          reason: row.reason,
          changes: {
            adjustment_id: row.id,
            delta: row.delta,
            stocked_before: row.stocked_before,
            stocked_after: row.stocked_after,
            reserved_quantity: row.reserved_quantity,
            note: row.note,
          },
        },
        trx,
      );
      return row;
    });
  }
}
