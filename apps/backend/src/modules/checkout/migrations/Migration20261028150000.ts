import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-185 (Q-13, RK-001, IND-ECOM-001) — hàng rào phía DB cho bất biến tồn kho: mọi dòng `inventory_level` còn sống
 * (`deleted_at is null`) có `0 <= reserved_quantity <= stocked_quantity`. Bảng thuộc inventory module của Medusa nên
 * KHÔNG thêm CHECK vào bảng của nó (Q-13 phương án A — vỡ khi nâng cấp/đổi thứ tự cập nhật); dùng constraint trigger
 * của module dự án, `DEFERRABLE INITIALLY DEFERRED`: kiểm lúc COMMIT trên trạng thái CUỐI của dòng (đọc lại theo `id`,
 * không dùng `NEW` — `NEW` là bản lúc câu lệnh chạy, có thể là trạng thái trung gian của cùng transaction).
 *
 * Vì sao bộ lọc `when` trên `NEW` vẫn đủ: lần ghi CUỐI vào một dòng trong transaction luôn sinh một sự kiện mà `NEW` =
 * trạng thái cuối → trạng thái cuối vi phạm thì sự kiện đó chắc chắn được xếp hàng; sự kiện trung gian vi phạm mà sau đó
 * được sửa thì hàm đọc lại thấy hợp lệ → cho qua. Dòng hợp lệ (đa số) không xếp sự kiện nào.
 *
 * Luồng ghi của Medusa 2.22.1 (`@medusajs/inventory` dist/services/inventory-module.js): mỗi lời gọi module là MỘT
 * transaction (`InjectTransactionManager`), đọc dòng rồi ghi giá trị tuyệt đối (`reserved = đọc + Δ`, `stocked = đọc + Δ`)
 * — trigger chạy ở commit của từng lời gọi đó. Đường lùi (`down`): gỡ trigger và function — dữ liệu không đổi.
 *
 * Vi phạm → SQLSTATE `23514` (check_violation), thông điệp bắt đầu bằng tên ràng buộc
 * `x_inventory_level_stock_guard` (`INVENTORY_GUARD_CONSTRAINT`, src/lib/inventory/guard.ts) — mã ứng dụng nhận dạng
 * và trả 409 hết hàng thay vì 500.
 *
 * Chạy được trên dữ liệu có sẵn: đếm dòng còn sống đang vi phạm trước và DỪNG kèm số dòng (không tự sửa dữ liệu).
 * Phụ thuộc bảng `inventory_level` của inventory module — Medusa chạy migration module lõi trước module dự án.
 */
export class Migration20261028150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`do $$
declare n bigint;
begin
  if to_regclass('inventory_level') is null then
    raise exception 'T-185: chưa có bảng inventory_level (inventory module của Medusa chưa migrate)';
  end if;
  select count(*) into n from "inventory_level"
  where "deleted_at" is null
    and ("stocked_quantity" < 0 or "reserved_quantity" < 0 or "stocked_quantity" < "reserved_quantity");
  if n > 0 then
    raise exception 'T-185: % dòng inventory_level vi phạm x_inventory_level_stock_guard (0 <= reserved <= stocked) — sửa dữ liệu trước khi migrate', n using errcode = '23514';
  end if;
end $$;`);
    this.addSql(`create or replace function "x_inventory_level_stock_guard"() returns trigger
      language plpgsql
    as $fn$
    declare
      s numeric;
      r numeric;
    begin
      select l."stocked_quantity", l."reserved_quantity" into s, r
      from "inventory_level" l
      where l."id" = new."id" and l."deleted_at" is null;
      if not found then
        return null;
      end if;
      if s < 0 or r < 0 or s < r then
        raise exception using
          errcode = '23514',
          constraint = 'x_inventory_level_stock_guard',
          message = format('x_inventory_level_stock_guard: inventory_level %s stocked_quantity=%s reserved_quantity=%s (cần 0 <= reserved <= stocked)', new."id", s, r),
          hint = 'Giữ hàng/xuất kho/điều chỉnh tồn phải chạy dưới khóa inventory_item và kiểm tồn khả dụng (T-185).';
      end if;
      return null;
    end
    $fn$;`);
    this.addSql(`drop trigger if exists "x_inventory_level_stock_guard" on "inventory_level";`);
    this.addSql(`create constraint trigger "x_inventory_level_stock_guard"
      after insert or update on "inventory_level"
      deferrable initially deferred
      for each row
      when (
        new."deleted_at" is null
        and (new."stocked_quantity" < 0 or new."reserved_quantity" < 0 or new."stocked_quantity" < new."reserved_quantity")
      )
      execute function "x_inventory_level_stock_guard"();`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger if exists "x_inventory_level_stock_guard" on "inventory_level";`);
    this.addSql(`drop function if exists "x_inventory_level_stock_guard"();`);
  }
}
