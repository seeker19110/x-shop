import type { MedusaRequest } from "@medusajs/framework/http";
import type { ImportRowError } from "@x-shop/domain";
import { AUDIT_MODULE } from "../../modules/audit";
import type AuditModuleService from "../../modules/audit/service";
import { recordAudit } from "../audit/record";
import type { ImportJobView } from "./import";

/**
 * Audit cho nhập CSV (ADM02, ADM04): ai preview/commit file nào (băm SHA-256), bao nhiêu dòng/lỗi/thay đổi. KHÔNG chép
 * nội dung file, thông điệp lỗi theo dòng hay tên file (có thể chứa dữ liệu cá nhân) — chi tiết nằm ở import_job cho
 * người có quyền `catalog.import`; `changes` còn được che PII lần nữa ở module audit.
 */
export const IMPORT_AUDIT_ACTIONS = {
  previewed: "catalog.import.previewed",
  committed: "catalog.import.committed",
  rejected: "catalog.import.commit_rejected",
  failed: "catalog.import.commit_failed",
} as const;

export const IMPORT_RESOURCE_TYPE = "catalog_import";

/** Cột có lỗi (không kèm thông điệp/giá trị ô), tối đa 20. */
function errorColumns(errors: readonly ImportRowError[]): string[] {
  return [...new Set(errors.map((e) => e.column))].slice(0, 20);
}

/**
 * SHA-256 hex chia nhóm 8 ký tự (`aaaaaaaa:bbbbbbbb:…`). Bộ che PII của audit thay mọi dãy giống số điện thoại (≥ 9 chữ số
 * liền nhau) trong văn bản — một băm hex đôi khi chứa dãy như vậy và sẽ bị che hỏng; nhóm 8 ký tự loại hẳn trường hợp đó.
 */
export const groupedHash = (hex: string): string => (hex.match(/.{1,8}/g) ?? []).join(":");

export function importAuditChanges(job: ImportJobView, errors: readonly ImportRowError[] = job.errors) {
  return {
    status: job.status,
    file_sha256: groupedHash(job.file_hash),
    summary: job.summary,
    errors_count: errors.length,
    error_columns: errorColumns(errors),
    ...(job.result && {
      result: {
        products_created: job.result.products_created.length,
        products_updated: job.result.products_updated.length,
        price_changes: job.result.price_changes.length,
        stock_changes: job.result.stock_changes.length,
      },
    }),
  };
}

export async function auditImportPreview(req: MedusaRequest, job: ImportJobView): Promise<void> {
  await recordAudit(
    req.scope,
    {
      action: IMPORT_AUDIT_ACTIONS.previewed,
      resource_type: IMPORT_RESOURCE_TYPE,
      resource_id: job.import_id,
      changes: importAuditChanges(job),
    },
    req,
  );
}

/**
 * Ghi `catalog.import.committed` ĐÚNG MỘT LẦN cho mỗi import (gọi trong khóa nhập — hook `onCommitted`). Lần trả lại
 * (replay) chỉ ghi khi chưa có dòng — tự bù nếu lần commit trước đã ghi catalog nhưng ghi audit lỗi.
 */
export function auditImportCommitted(req: MedusaRequest) {
  return async (job: ImportJobView, replayed: boolean): Promise<void> => {
    if (replayed) {
      const { count } = await req.scope.resolve<AuditModuleService>(AUDIT_MODULE).list(
        {
          action: IMPORT_AUDIT_ACTIONS.committed,
          resource_type: IMPORT_RESOURCE_TYPE,
          resource_id: job.import_id,
        },
        { limit: 1, offset: 0 },
      );
      if (count > 0) return;
    }
    await recordAudit(
      req.scope,
      {
        action: IMPORT_AUDIT_ACTIONS.committed,
        resource_type: IMPORT_RESOURCE_TYPE,
        resource_id: job.import_id,
        changes: { ...importAuditChanges(job), backfilled: replayed },
      },
      req,
    );
  };
}

export async function auditImportRejected(
  req: MedusaRequest,
  job: ImportJobView,
  errors: readonly ImportRowError[],
): Promise<void> {
  await recordAudit(
    req.scope,
    {
      action: IMPORT_AUDIT_ACTIONS.rejected,
      resource_type: IMPORT_RESOURCE_TYPE,
      resource_id: job.import_id,
      reason: "IMPORT_HAS_ERRORS",
      changes: importAuditChanges(job, errors),
    },
    req,
  );
}

/** Commit lỗi giữa chừng (job → failed). Chỉ ghi loại lỗi — thông điệp có thể chứa dữ liệu, đã lưu ở job.last_error. */
export async function auditImportFailed(req: MedusaRequest, importId: string, error: unknown): Promise<void> {
  await recordAudit(
    req.scope,
    {
      action: IMPORT_AUDIT_ACTIONS.failed,
      resource_type: IMPORT_RESOURCE_TYPE,
      resource_id: importId,
      reason: "COMMIT_FAILED",
      changes: { error_type: error instanceof Error ? error.name : typeof error },
    },
    req,
  );
}
