import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// @migration-contract: T-186 (Q-22, DB-MODEL-002) mở rộng cột tiền int4 → bigint tại chỗ; cột tạo ở Migration20261024173210. Chưa có dữ liệu thật, int4 → bigint không mất giá trị.

/**
 * T-186 (Q-22; DB-MODEL-002) — cột tiền của module `checkout` từ `integer` sang `bigint` (số nguyên VND, BASE-DATA-005):
 * `checkout_quote.total`, `order_finance.total`, `payment_attempt.amount`, `payment_ledger.amount`, `ops_exception.amount`.
 *
 * Vì sao ALTER tại chỗ thay vì expand/contract (cột mới + backfill + đổi đọc + xoá cột cũ): mở rộng int4 → int8 không mất
 * hay đổi giá trị nào, tên cột và CHECK giữ nguyên, chưa có dữ liệu thật (Q-22 của PLAN-2) — bảng nhỏ, viết lại bảng
 * (ACCESS EXCLUSIVE) chỉ trong lúc migrate.
 *
 * Đọc: pg trả int8 dạng CHUỖI. Parser `src/lib/db/int8.ts` (cài ở medusa-config.ts) ép về number có Number.isSafeInteger
 * (vượt 2^53 − 1 → truy vấn bị từ chối). N−1: bản KHÔNG có parser chạy trên schema này nhận chuỗi (API trả
 * `"total": "1330000"`, so sánh `===` sai — đo bằng test tích hợp checkout-submit/payment-ipn/refunds) — parser phải phát
 * hành TRƯỚC migration này (expand = mã, contract = đổi kiểu). Model DSL vẫn `model.number()` (DML 2.22.1 không có kiểu
 * bigint trả number; snapshot giữ `integer` để drift không đòi đổi ngược) — xem chú thích ở `models/checkout-models.ts`.
 *
 * down() (đường lùi): trả về `integer` NHƯNG dừng (raise) nếu có giá trị ngoài miền int4 — không cắt dữ liệu.
 */
const MONEY = {
  checkout_quote: ["total"],
  order_finance: ["total"],
  payment_attempt: ["amount"],
  payment_ledger: ["amount"],
  ops_exception: ["amount"],
} as const;

const alterAll = (type: "bigint" | "integer"): string[] =>
  Object.entries(MONEY).map(
    ([table, cols]) =>
      `alter table if exists "${table}" ${cols.map((c) => `alter column "${c}" type ${type}`).join(", ")};`,
  );

const INT4_GUARD = `do $$
begin
  if ${Object.entries(MONEY)
    .flatMap(([table, cols]) =>
      cols.map(
        (c) => `exists (select 1 from "${table}" where "${c}" not between -2147483648 and 2147483647)`,
      ),
    )
    .join("\n     or ")}
  then
    raise exception 'T-186 down(): có giá trị tiền ngoài miền integer — không hạ kiểu (sẽ mất dữ liệu)';
  end if;
end
$$;`;

export class Migration20261106100000 extends Migration {
  override async up(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    for (const sql of alterAll("bigint")) this.addSql(sql);
  }

  override async down(): Promise<void> {
    // Đổi kiểu viết lại bảng dưới ACCESS EXCLUSIVE: chờ khoá quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn checkout/IPN
    // (cùng quy ước T-185, Migration20261028150000; review T-186).
    this.addSql("set local lock_timeout = '5s';");
    this.addSql(INT4_GUARD);
    for (const sql of alterAll("integer")) this.addSql(sql);
  }
}
