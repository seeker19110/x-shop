import type { MedusaRequest } from "@medusajs/framework/http";
import { isValidIdempotencyKey, type Permission, isNonEmpty } from "@x-shop/domain";
import { z } from "zod";
import { requirePermission } from "../../lib/access/require-permission";
import { adminAccessOf } from "../../lib/admin-security/guard";
import { readQuery } from "../../lib/http/request-input";
import { RETURN_KINDS, RETURN_REASONS, REFUND_METHODS } from "../../modules/returns/constants";
import { ReturnsError } from "./errors";
import type { Actor } from "./refunds";

/** Người thao tác Admin: kiểm quyền lần hai trong route (lớp chính là guard RBAC) + vai trò cho quy tắc duyệt. */
export function actorOf(req: MedusaRequest, permission: Permission): Actor {
  const id = requirePermission(req, permission);
  return { id, roles: adminAccessOf(req)?.roles ?? [] };
}

/** Header `Idempotency-Key` bắt buộc (16–128 ký tự [A-Za-z0-9_-]) cho thao tác tạo. */
export function idempotencyKeyOf(req: MedusaRequest): string {
  const key = req.get("Idempotency-Key");
  if (!isValidIdempotencyKey(key)) {
    throw new ReturnsError("VALIDATION", "Thiếu hoặc sai Idempotency-Key (16–128 ký tự [A-Za-z0-9_-])", {
      field: "Idempotency-Key",
    });
  }
  return key;
}

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ReturnsError("VALIDATION", "Dữ liệu không hợp lệ", {
      errors: parsed.error.issues.map((i) => ({
        param: i.path.map(String).join(".") || "*",
        reason: i.message,
      })),
    });
  }
  return parsed.data;
}

/** Query của route đổi/trả/hoàn tiền theo schema (`readQuery`); sai → ReturnsError VALIDATION như `parseBody`. */
export function parseQuery<T extends z.ZodType>(req: MedusaRequest, schema: T): z.output<T> {
  const r = readQuery(req, schema);
  if (!r.ok) throw new ReturnsError("VALIDATION", "Dữ liệu không hợp lệ", { errors: r.errors });
  return r.data;
}

const id = z.string().trim().min(1).max(128);
const note = z.string().trim().max(500);

export const ReturnLinesSchema = z
  .array(
    z
      .object({
        line_id: id,
        quantity: z.number().int().min(1).max(99),
        exchange_variant_id: id.optional(),
      })
      .strict(),
  )
  .min(1)
  .max(50);

export const ReturnRequestBody = z
  .object({
    kind: z.enum(RETURN_KINDS),
    reason: z.enum(RETURN_REASONS),
    note: note.optional(),
    lines: ReturnLinesSchema,
  })
  .strict();

export const AdminReturnRequestBody = ReturnRequestBody.extend({ order_id: id }).strict();

export const DecisionBody = z.object({ note: note.optional() }).strict();
export const RejectBody = z.object({ reason: note.min(3) }).strict();
/** Hủy (yêu cầu hoàn `failed`, đơn bởi nhân viên — T-044): lý do bắt buộc, ghi audit. */
export const CancelBody = RejectBody;

/**
 * Mã đối chiếu trên cổng merchant VNPAY (T-165): mã giao dịch/mã tra cứu nhân viên thấy khi đối chiếu tay — 6–64 ký tự
 * ASCII `[A-Za-z0-9_.:-]`, bắt đầu bằng chữ/số, không khoảng trắng (không phải chỗ ghi văn tự do/PII).
 */
export const MERCHANT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{5,63}$/;

/**
 * Hủy đơn có thanh toán chưa xác minh (T-165, D-118): lý do ≥ 10 ký tự (thao tác ghi đè — phải đủ để người sau hiểu đã
 * đối chiếu gì) + mã đối chiếu merchant.
 */
export const CancelUnverifiedBody = z
  .object({
    reason: note.min(10),
    merchant_ref: z.string().trim().regex(MERCHANT_REF_PATTERN, "mã đối chiếu không hợp lệ"),
  })
  .strict();

export const ReceiveBody = z
  .object({
    lines: z
      .array(z.object({ line_id: id, quantity: z.number().int().min(0).max(99) }).strict())
      .min(1)
      .max(50)
      .optional(),
  })
  .strict();

export const InspectBody = z
  .object({
    lines: z
      .array(
        z
          .object({
            line_id: id,
            restock_quantity: z.number().int().min(0).max(99),
            damaged_quantity: z.number().int().min(0).max(99),
            note: note.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const RefundCreateBody = z
  .object({
    order_id: id,
    reason: z.enum(["return", "cancellation", "overpayment", "late_payment", "other"]),
    /** Chỉ với `reason=return` (T-044): mở lại hoàn tiền cho yêu cầu trả đã kiểm định có hoàn tiền trước đã hủy. */
    return_id: id.optional(),
    amount: z.number().int().positive().max(2_147_483_647).optional(),
    method: z.enum([...REFUND_METHODS, "auto"]).optional(),
    note: note.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.reason === "return") {
      // Số tiền hoàn theo trả hàng do kiểm định chốt (AT15) — server tính, client không gửi.
      if (!isNonEmpty(b.return_id))
        ctx.addIssue({ code: "custom", path: ["return_id"], message: "bắt buộc với lý do này" });
      if (b.amount !== undefined) {
        ctx.addIssue({ code: "custom", path: ["amount"], message: "không gửi — lấy theo kết quả kiểm định" });
      }
      return;
    }
    if (b.return_id !== undefined) {
      ctx.addIssue({ code: "custom", path: ["return_id"], message: "chỉ dùng với reason=return" });
    }
    if (b.reason !== "cancellation" && b.amount === undefined) {
      ctx.addIssue({ code: "custom", path: ["amount"], message: "bắt buộc với lý do này" });
    }
    if ((b.reason === "other" || b.reason === "overpayment") && !isNonEmpty(b.note)) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "cần ghi chú lý do" });
    }
  });

export const ExecuteBody = z.object({ evidence_ref: z.string().trim().min(3).max(128).optional() }).strict();
