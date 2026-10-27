import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import { z } from "zod";
import { msToSecondsCeil } from "@x-shop/domain";
import { recordAudit } from "../audit/record";
import { logServerError } from "../errors/error-handler";
import { maskFreeText } from "../audit/sanitize";
import { adminPageQuery } from "../http/pagination";
import { readCsvBody } from "../http/read-body";
import { sendProblem, zodErrors } from "../http/problem";
import { rfc3339Instant } from "../http/time";
import { SETTLEMENT_MODULE } from "../../modules/settlement";
import {
  DISCREPANCY_KINDS,
  DISCREPANCY_STATES,
  PRIORITIES,
  SETTLEMENT_CONFIG,
  SETTLEMENT_SOURCES,
} from "../../modules/settlement/constants";
import { parseSettlementCsv } from "../../modules/settlement/csv";
import SettlementModuleService, {
  SettlementError,
  type DiscrepancyView,
} from "../../modules/settlement/service";

/** Lỗi có mã ổn định của route đối soát/báo cáo (problem+json, đặc tả §9.1). */
export class SettlementHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly errors: Array<{ param: string; reason: string }> = [],
  ) {
    super(message);
  }
}

const SETTLEMENT_ERROR_STATUS: Record<SettlementError["code"], number> = {
  BATCH_CONFLICT: 409,
  IMPORT_IN_PROGRESS: 409,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
};

export function handleSettlementError(req: MedusaRequest, res: MedusaResponse, error: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  if (error instanceof SettlementHttpError) {
    return sendProblem(res, error.status, error.code, error.message, error.errors, error.extra);
  }
  if (error instanceof SettlementError) {
    // Lần nhập khác cùng nguồn đang giữ khoá (T-140): chưa ghi gì, gọi lại được.
    if (error.code === "IMPORT_IN_PROGRESS")
      res.setHeader("Retry-After", String(msToSecondsCeil(SETTLEMENT_CONFIG.importLockWaitMs)));
    return sendProblem(res, SETTLEMENT_ERROR_STATUS[error.code], error.code, error.message, [], error.detail);
  }
  if (error instanceof MedusaError) {
    if (error.type === MedusaError.Types.UNAUTHORIZED)
      return sendProblem(res, 401, "UNAUTHORIZED", error.message);
    if (error.type === MedusaError.Types.FORBIDDEN) return sendProblem(res, 403, "FORBIDDEN", error.message);
  }
  logServerError(req, "settlement", error);
  sendProblem(res, 500, "INTERNAL", "Không thể xử lý yêu cầu lúc này");
}

/**
 * Hình chênh lệch trả ra Admin: ghi chú đóng tay (do nhân viên nhập) và ghi chú từng sự kiện lịch sử được che PII lẫn
 * trong văn bản. Dữ liệu gốc trong bảng giữ nguyên (không đổi ghi) — che ở lúc trả ra, giống audit che lúc ghi.
 */
export function presentDiscrepancy(d: DiscrepancyView): DiscrepancyView {
  return {
    ...d,
    resolution_note: maskFreeText(d.resolution_note),
    ...(d.events && { events: d.events.map((e) => ({ ...e, note: maskFreeText(e.note) })) }),
  };
}

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new SettlementHttpError(
      422,
      "VALIDATION",
      "Dữ liệu không hợp lệ",
      {},
      zodErrors(parsed.error.issues),
    );
  }
  return parsed.data;
}

export const settlementOf = (req: MedusaRequest) =>
  req.scope.resolve<SettlementModuleService>(SETTLEMENT_MODULE);

const instant = rfc3339Instant;
const notFuture = (d: Date) => d.getTime() <= Date.now() + SETTLEMENT_CONFIG.futureSkewMs;
const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, "1–64 ký tự [A-Za-z0-9_.:-], bắt đầu bằng chữ hoặc số");
const page = adminPageQuery;

export const ImportQuery = z
  .object({
    source: z.enum(SETTLEMENT_SOURCES),
    /** Mã batch của hãng (nếu có) — cùng mã khác nội dung → 409. */
    external_ref: code.optional(),
    /** Chứng từ phủ các khoản phát sinh tới thời điểm này → khoản hệ thống có mà chứng từ không có = "thiếu". */
    period_end: instant.refine(notFuture, "Không được ở tương lai").optional(),
  })
  .strict();

export const BatchListQuery = z.object({ source: z.enum(SETTLEMENT_SOURCES).optional(), ...page }).strict();

export const DiscrepancyListQuery = z
  .object({
    state: z.enum(DISCREPANCY_STATES).optional(),
    kind: z.enum(DISCREPANCY_KINDS).optional(),
    source: z.enum(SETTLEMENT_SOURCES).optional(),
    batch_id: z.string().trim().min(1).max(128).optional(),
    order_id: z.string().trim().min(1).max(128).optional(),
    ...page,
  })
  .strict();

export const ResolveBody = z
  .object({
    note: z.string().trim().min(3).max(500),
    evidence_ref: z.string().trim().min(3).max(128).optional(),
  })
  .strict();

export const SummaryQuery = z
  .object({ from: instant.optional(), to: instant.optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from.getTime() < q.to.getTime(), {
    message: "from phải trước to",
    path: ["from"],
  });

export const ExceptionsQuery = z
  .object({
    source: z.enum(["ops", "settlement", "cod"]).optional(),
    kind: z
      .string()
      .trim()
      .regex(/^[a-z_]{1,40}$/)
      .optional(),
    priority: z.enum(PRIORITIES).optional(),
    ...page,
  })
  .strict();

/** Ký tự điều khiển (trừ tab/CR/LF) → không phải CSV văn bản (file nhị phân đổi đuôi). */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true;
  }
  return false;
}
const CSV_FILE_NAME = /\.(csv|txt)$/i;

/**
 * POST /admin/x/settlements/batches — đọc file (text/csv hoặc multipart `file`, ≤ 1 MB, UTF-8), kiểm là CSV văn bản,
 * parse tất cả-hoặc-không, rồi nhập dưới khóa theo nguồn. Trả `{ status, body, replayed }` để route gửi.
 */
export async function importSettlementBatch(req: MedusaRequest, actorId: string) {
  const query = parseInput(ImportQuery, req.query);
  const body = await readCsvBody(req, SETTLEMENT_CONFIG.maxFileBytes);
  if (!body.ok) throw new SettlementHttpError(body.status, body.code, body.reason);
  if (body.fileName !== null && !CSV_FILE_NAME.test(body.fileName)) {
    throw new SettlementHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "File phải có đuôi .csv hoặc .txt");
  }
  if (hasControlChars(body.text)) {
    throw new SettlementHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Nội dung không phải CSV văn bản");
  }
  const parsed = parseSettlementCsv(body.text, query.source);
  if (!parsed.ok) {
    const title =
      parsed.code === "EMPTY_FILE"
        ? "File rỗng"
        : parsed.code === "EMPTY_BATCH"
          ? "File không có dòng dữ liệu nào"
          : "File có dòng sai định dạng — không dòng nào được nhập";
    throw new SettlementHttpError(422, parsed.code, title, { row_errors: parsed.errors });
  }
  const result = await settlementOf(req).importBatch({
    source: query.source,
    content_hash: parsed.content_hash,
    external_ref: query.external_ref ?? null,
    period_end: query.period_end ?? null,
    imported_by: actorId,
    rows: parsed.rows,
  });
  if (!result.replayed) {
    try {
      await recordAudit(
        req.scope,
        {
          action: "settlement.batch.imported",
          resource_type: "settlement_batch",
          resource_id: result.batch.id,
          changes: {
            source: result.batch.source,
            external_ref: result.batch.external_ref,
            row_count: result.batch.row_count,
            total_amount: result.batch.total_amount,
            results: result.batch.summary.results,
            discrepancies_opened: result.batch.summary.discrepancies_opened,
            content_hash: result.batch.content_hash.slice(0, 16),
          },
        },
        req,
      );
    } catch (e) {
      req.scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .error(`[settlement] Không ghi được audit nhập batch: ${(e as Error).message}`);
    }
  }
  return result;
}
