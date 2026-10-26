import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-052 (D-032) — hàng rào phía DB cho bất biến hoàn tiền S-108 (Σ đã hoàn + Σ đang giữ ≤ Σ đã thu). Bất biến chỉ đúng
 * khi mọi lần ghi làm tăng tiền chiếm chỗ của một đơn chạy trong transaction giữ khóa advisory theo đơn
 * (`ReturnsModuleService.lockOrder`): đọc tổng rồi ghi được tuần tự hoá. Trigger ở đây bắt đường ghi QUÊN khóa (lỗi lập
 * trình) thay vì để hai yêu cầu song song cùng vượt.
 *
 * Từ chối với SQLSTATE `XR001` (`REFUND_LOCK_REQUIRED_SQLSTATE`) khi phiên hiện tại không giữ khóa của `NEW.order_id`:
 *  - mọi INSERT vào `x_refund`;
 *  - UPDATE làm tăng tiền chiếm chỗ của đơn: trạng thái mới còn hiệu lực (không phải rejected/cancelled) VÀ (trạng thái cũ
 *    là rejected/cancelled, hoặc amount tăng, hoặc đổi order_id). Chuyển trạng thái của workflow (requested → approved,
 *    approved/failed → processing → succeeded/failed/unknown, failed → cancelled …) không làm tăng tổng nên không bị kiểm
 *    — chúng chạy dưới khóa Redis `order:<id>`, không trong transaction Postgres.
 *
 * Khớp khóa (đã xác minh thực nghiệm trên PostgreSQL 16 qua `pg_locks`): `pg_advisory_xact_lock(bigint)` với
 * k = hashtext(s)::bigint (int4 mở rộng có dấu) hiện thành một dòng `locktype='advisory'`, `objsubid = 1`,
 * `classid = (k >> 32) & 0xFFFFFFFF`, `objid = k & 0xFFFFFFFF` (hashtext âm → classid 4294967295); dạng hai khóa int4
 * cho `objsubid = 2`, dạng `_shared` cho `mode = 'ShareLock'` — đều KHÔNG được tính.
 *
 * Tiền tố 'x-returns:order:' PHẢI khớp `ORDER_LOCK_KEY_PREFIX` (src/modules/returns/constants.ts). Chép nguyên chuỗi
 * vào đây vì migration đã áp không được đổi theo mã; đổi tiền tố → migration MỚI thay function này.
 *
 * Đường lùi (`down`): gỡ hai trigger và function — dữ liệu không đổi.
 */
export class Migration20261026010000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create or replace function "x_refund_require_order_lock"() returns trigger
      language plpgsql
      set search_path = pg_catalog, pg_temp
    as $fn$
    declare
      k bigint := hashtext('x-returns:order:' || new."order_id")::bigint;
    begin
      if not exists (
        select 1 from pg_locks l
        where l.locktype = 'advisory'
          and l.pid = pg_backend_pid()
          and l.granted
          and l.mode = 'ExclusiveLock'
          and l.objsubid = 1
          and l.classid::bigint = ((k >> 32) & 4294967295)
          and l.objid::bigint = (k & 4294967295)
      ) then
        raise exception using
          errcode = 'XR001',
          message = format('x_refund: %s cho đơn %s cần khóa advisory theo đơn trong cùng transaction', tg_op, new."order_id"),
          hint = 'Gọi ReturnsModuleService.lockOrder(trx, order_id) trước khi ghi hoàn tiền (T-052, D-032).';
      end if;
      return new;
    end
    $fn$;`);
    this.addSql(`drop trigger if exists "x_refund_order_lock_ins" on "x_refund";`);
    this.addSql(`create trigger "x_refund_order_lock_ins" before insert on "x_refund"
      for each row execute function "x_refund_require_order_lock"();`);
    this.addSql(`drop trigger if exists "x_refund_order_lock_upd" on "x_refund";`);
    this.addSql(`create trigger "x_refund_order_lock_upd" before update on "x_refund"
      for each row
      when (
        new."state" not in ('rejected', 'cancelled')
        and (
          old."state" in ('rejected', 'cancelled')
          or new."amount" > old."amount"
          or new."order_id" is distinct from old."order_id"
        )
      )
      execute function "x_refund_require_order_lock"();`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists "x_refund_order_lock_upd" on "x_refund";`);
    this.addSql(`drop trigger if exists "x_refund_order_lock_ins" on "x_refund";`);
    this.addSql(`drop function if exists "x_refund_require_order_lock"();`);
  }
}
