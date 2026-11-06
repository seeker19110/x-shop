import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { isNonEmpty, vnpay } from "@x-shop/domain";

/**
 * `vnp_TransactionDate` của querydr/refund (T-170). Theo nguồn thứ cấp, giá trị này phải BẰNG `vnp_CreateDate` đã gửi
 * trong URL thanh toán của giao dịch gốc (chưa xác minh với tài liệu merchant, RK-006). Submit lưu đúng chuỗi đó vào
 * `payment_attempt.vnp_create_date` (cùng mốc `prepared.now` dùng để ký URL); KHÔNG dùng `created_at` — đó là `now()`
 * của DB lúc INSERT, sau mốc ký URL vài trăm ms nên thường rơi sang giây khác.
 *
 * Dữ liệu trước T-170 (cột NULL — kể cả attempt do bản N−1 tạo trong lúc deploy cuốn): fallback `created_at` như cũ + log
 * WARN (RUNBOOK §1.2 — điền lại từ `payment_url`). Chuỗi lưu sai dạng (CHECK của DB đã chặn) cũng đi đường này thay vì
 * gửi giá trị hỏng.
 */
export interface AttemptDateSource {
  id: string;
  txn_ref: string;
  vnp_create_date?: string | null;
  created_at: Date | string;
}

export type TransactionDateSource = "vnp_create_date" | "created_at_fallback";

/** Phần thuần: mốc gửi đi + nguồn. `fromVnpDate` chỉ nhận chuỗi khứ hồi đúng → `toVnpDate(date)` = chuỗi lưu, từng ký tự. */
export function resolveTransactionDate(pa: AttemptDateSource): {
  date: Date;
  source: TransactionDateSource;
} {
  const stored = pa.vnp_create_date;
  if (isNonEmpty(stored)) {
    const parsed = vnpay.fromVnpDate(stored);
    if (parsed) return { date: parsed, source: "vnp_create_date" };
  }
  return { date: new Date(pa.created_at), source: "created_at_fallback" };
}

/** Mốc `vnp_TransactionDate` cho lời gọi `use`; fallback thì log WARN (log hỏng không chặn querydr/hoàn tiền). */
export function transactionDateOf(
  scope: Pick<MedusaContainer, "resolve">,
  pa: AttemptDateSource,
  use: "querydr" | "refund",
): Date {
  const r = resolveTransactionDate(pa);
  if (r.source === "created_at_fallback") {
    try {
      scope
        .resolve(ContainerRegistrationKeys.LOGGER)
        .warn(
          `[payment] payment_attempt ${pa.id} txn_ref=${pa.txn_ref} thiếu vnp_create_date hợp lệ (dữ liệu trước T-170) — ${use} dùng created_at làm vnp_TransactionDate=${vnpay.toVnpDate(r.date)}, có thể lệch vnp_CreateDate gốc (RUNBOOK §1.2)`,
        );
    } catch {
      // log hỏng không chặn querydr/hoàn tiền
    }
  }
  return r.date;
}
