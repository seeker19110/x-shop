import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { generateEntityId } from "@medusajs/framework/utils";
import { sanitizeChanges } from "../../lib/audit/sanitize";

export const AUDIT_TABLE = "audit_log";

export interface AuditEntryInput {
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  reason?: string | null;
  /** Được che PII trước khi ghi (sanitizeChanges) — người gọi không cần tự che. */
  changes?: Record<string, unknown>;
  request_id?: string | null;
  ip_hash?: string | null;
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
  created_at: Date;
}

export interface AuditListFilter {
  action?: string;
  actor_id?: string;
  resource_type?: string;
  resource_id?: string;
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
    const row = {
      id: generateEntityId(undefined, "audit"),
      actor_type: clip(entry.actor_type, 32) ?? "unknown",
      actor_id: clip(entry.actor_id, 128),
      action: clip(entry.action, 128) ?? "unknown",
      resource_type: clip(entry.resource_type, 64) ?? "unknown",
      resource_id: clip(entry.resource_id, 256),
      reason: clip(entry.reason, 1000),
      changes: JSON.stringify(sanitizeChanges(entry.changes ?? {})),
      request_id: clip(entry.request_id, 128),
      ip_hash: clip(entry.ip_hash, 128),
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
}
