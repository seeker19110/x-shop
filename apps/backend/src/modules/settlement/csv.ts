import { createHash } from "node:crypto";
import { parseCsv } from "@x-shop/domain";
import { parseRfc3339 } from "../../lib/http/time";
import {
  LINE_TYPES_BY_SOURCE,
  SETTLEMENT_CONFIG,
  type SettlementLineType,
  type SettlementSource,
} from "./constants";

/**
 * Parser file đối soát (định dạng nội bộ GIẢ ĐỊNH — xem constants.ts). Hàm thuần: không đọc DB, không ghi gì.
 * Tất cả hoặc không: một dòng sai là cả file bị từ chối (chứng từ tiền không nhập một nửa).
 *
 * Chống CSV/formula injection: `reference` chỉ nhận [A-Za-z0-9_.:-] và phải bắt đầu bằng chữ/số; `type` là danh sách
 * đóng; `amount` chỉ chữ số → ô bắt đầu bằng `= + - @ \t \r` không bao giờ lọt vào DB để quay lại qua xuất báo cáo.
 * Lỗi chỉ nêu dòng + cột + lý do, KHÔNG lặp lại nội dung ô.
 */

export const SETTLEMENT_COLUMNS = ["reference", "amount", "occurred_at", "type"] as const;

export interface SettlementRow {
  /** Số dòng theo file (header = 1). */
  line: number;
  reference: string;
  amount: number;
  occurred_at: Date;
  type: SettlementLineType;
}

export interface SettlementRowError {
  line: number;
  column: string;
  message: string;
}

export type ParseOutcome =
  | { ok: true; rows: SettlementRow[]; content_hash: string }
  | { ok: false; code: "EMPTY_FILE" | "EMPTY_BATCH" | "INVALID_ROWS"; errors: SettlementRowError[] };

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const DIGITS = /^\d{1,10}$/;

/** Số tiền VND: chuỗi chỉ chữ số → số nguyên an toàn trong [0, trần cột]. null = sai định dạng. */
export function parseVnd(raw: string): number | null {
  if (!DIGITS.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > SETTLEMENT_CONFIG.maxAmountVnd) return null;
  return n;
}

/** Thời điểm RFC 3339 BẮT BUỘC có offset (không đoán giờ VN/UTC). null = sai định dạng. */
export const parseInstant = parseRfc3339;

/**
 * Băm nội dung CHUẨN HOÁ của batch (nguồn + dòng đã parse, sắp xếp): cùng chứng từ xuất lại với CRLF/LF, BOM hay thứ
 * tự dòng khác vẫn là CÙNG batch → nhập lại idempotent thay vì ghi trùng tiền.
 */
export function contentHashOf(source: SettlementSource, rows: readonly SettlementRow[]): string {
  const canon = rows
    .map((r) => [r.type, r.reference, String(r.amount), r.occurred_at.toISOString()].join("|"))
    .sort();
  return createHash("sha256")
    .update([`x-settlement:v1:${source}`, ...canon].join("\n"))
    .digest("hex");
}

export function parseSettlementCsv(
  text: string,
  source: SettlementSource,
  now: Date = new Date(),
): ParseOutcome {
  let table: string[][];
  try {
    table = parseCsv(text, SETTLEMENT_CONFIG.maxRows + 1);
  } catch (e) {
    return {
      ok: false,
      code: "INVALID_ROWS",
      errors: [{ line: 0, column: "*", message: (e as Error).message }],
    };
  }
  if (table.length === 0) return { ok: false, code: "EMPTY_FILE", errors: [] };

  const header = (table[0] ?? []).map((h) => h.trim().toLowerCase());
  const headerErrors: SettlementRowError[] = [];
  const missing = SETTLEMENT_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) headerErrors.push({ line: 1, column: missing.join(","), message: "Thiếu cột" });
  const unknown = header.filter((h) => !(SETTLEMENT_COLUMNS as readonly string[]).includes(h));
  if (unknown.length > 0)
    headerErrors.push({ line: 1, column: "*", message: `Có ${unknown.length} cột không thuộc định dạng` });
  if (new Set(header).size !== header.length)
    headerErrors.push({ line: 1, column: "*", message: "Trùng tên cột" });
  if (headerErrors.length > 0) return { ok: false, code: "INVALID_ROWS", errors: headerErrors };
  if (table.length === 1) return { ok: false, code: "EMPTY_BATCH", errors: [] };

  const idx = (c: (typeof SETTLEMENT_COLUMNS)[number]) => header.indexOf(c);
  const allowedTypes = LINE_TYPES_BY_SOURCE[source];
  const latest = now.getTime() + SETTLEMENT_CONFIG.futureSkewMs;
  const errors: SettlementRowError[] = [];
  const rows: SettlementRow[] = [];
  const seen = new Map<string, number>();

  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (cells.length !== header.length) {
      errors.push({ line, column: "*", message: `Cần ${header.length} cột, có ${cells.length}` });
      return;
    }
    const get = (c: (typeof SETTLEMENT_COLUMNS)[number]) => (cells[idx(c)] ?? "").trim();
    const before = errors.length;

    const reference = get("reference");
    if (!REFERENCE.test(reference)) {
      errors.push({
        line,
        column: "reference",
        message: "1–64 ký tự [A-Za-z0-9_.:-], bắt đầu bằng chữ hoặc số",
      });
    }
    const amount = parseVnd(get("amount"));
    if (amount === null) {
      errors.push({
        line,
        column: "amount",
        message: `Số nguyên VND từ 0 đến ${SETTLEMENT_CONFIG.maxAmountVnd}, chỉ chữ số (không âm, thập phân, phân cách)`,
      });
    }
    const occurredAt = parseInstant(get("occurred_at"));
    if (occurredAt === null) {
      errors.push({
        line,
        column: "occurred_at",
        message: "RFC 3339 có giây và offset (Z hoặc ±hh:mm), vd. 2026-10-25T08:00:00+07:00",
      });
    } else if (occurredAt.getTime() > latest) {
      errors.push({ line, column: "occurred_at", message: "Thời điểm ở tương lai" });
    }
    const type = get("type").toLowerCase() as SettlementLineType;
    if (!allowedTypes.includes(type)) {
      errors.push({ line, column: "type", message: `Nguồn ${source} chỉ nhận: ${allowedTypes.join(" | ")}` });
    }
    if (errors.length > before) return;

    const dupKey = `${type}|${reference.toUpperCase()}`;
    const first = seen.get(dupKey);
    if (first !== undefined) {
      errors.push({ line, column: "reference", message: `Trùng với dòng ${first}` });
      return;
    }
    seen.set(dupKey, line);
    rows.push({ line, reference, amount: amount as number, occurred_at: occurredAt as Date, type });
  });

  if (errors.length > 0) {
    return { ok: false, code: "INVALID_ROWS", errors: errors.slice(0, SETTLEMENT_CONFIG.maxReportedErrors) };
  }
  return { ok: true, rows, content_hash: contentHashOf(source, rows) };
}
