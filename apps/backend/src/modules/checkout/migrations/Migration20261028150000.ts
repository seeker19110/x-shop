import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-185 (Q-13, RK-001, IND-ECOM-001; D-133, D-134) — hàng rào phía DB cho bất biến tồn kho. Với mọi dòng
 * `inventory_level` còn sống (`deleted_at is null`) của cặp (inventory_item_id, location_id):
 *   0 <= reserved_quantity <= stocked_quantity  VÀ  stocked_quantity >= Σ quantity của reservation_item còn sống cùng cặp.
 * Vế thứ hai (D-134) bắt lost-update: inventory module của Medusa 2.22.1 (`@medusajs/inventory`
 * dist/services/inventory-module.js) đọc dòng rồi ghi giá trị TUYỆT ĐỐI (`reserved = đọc + Δ`) — hai lần giữ hàng không qua
 * khóa Redis cùng đọc số cũ thì phiên sau ghi đè, `reserved_quantity` thiếu mà không vi phạm vế thứ nhất.
 *
 * D-133: hàng rào chặn MỌI giữ hàng vượt tồn, kể cả reservation có `allow_backorder` — backorder thực tế TẮT theo D-133
 * (đặc tả: backorder mặc định tắt). Mở backorder = quyết định mới + migration mới.
 *
 * Bảng thuộc inventory module của Medusa nên KHÔNG thêm CHECK vào bảng của nó (Q-13 phương án A); dùng constraint
 * trigger `DEFERRABLE INITIALLY DEFERRED` của module dự án: kiểm lúc COMMIT trên trạng thái CUỐI (đọc lại theo cặp, không
 * dùng giá trị của `NEW` — trạng thái trung gian trong cùng transaction được phép).
 *  - inventory_level: INSERT dòng còn sống; UPDATE làm đổi stocked/reserved/cặp/deleted_at của dòng còn sống.
 *  - reservation_item: INSERT dòng còn sống; UPDATE tăng quantity, đổi cặp, hoặc khôi phục dòng đã xoá mềm. Xoá (cứng
 *    hay mềm) chỉ làm giảm tổng → không kiểm.
 *  Mọi thay đổi có thể làm trạng thái cuối vi phạm đều xếp ít nhất một sự kiện → hàm luôn kiểm trạng thái cuối.
 *
 * Tuần tự hoá: hàm `select … for update` dòng inventory_level của cặp TRƯỚC khi cộng reservation. Hai phiên cùng cặp: phiên
 * sau chờ khóa dòng tới khi phiên trước commit xong; ở READ COMMITTED câu `sum` sau đó lấy snapshot mới nên thấy
 * reservation vừa commit → không thể cùng lọt. Phiên đã UPDATE dòng level thì đã giữ sẵn khóa này.
 * Cặp không có dòng level còn sống → bỏ qua (Medusa luôn tạo level trước khi giữ hàng; xoá kho/SKU gỡ reservation riêng).
 *
 * Vi phạm → SQLSTATE `23514` (check_violation), `constraint` và tiền tố thông điệp `x_inventory_level_stock_guard`
 * (`INVENTORY_GUARD_CONSTRAINT`, src/lib/inventory/guard.ts) — mã ứng dụng trả 409 hết hàng thay vì 500.
 *
 * Chạy được trên dữ liệu có sẵn: đếm dòng level còn sống đang vi phạm (cả hai vế) và DỪNG kèm số dòng (không tự sửa
 * dữ liệu). Phụ thuộc bảng của inventory module — Medusa chạy migration module lõi trước module dự án.
 * Đường lùi (`down`): gỡ bốn trigger và function — dữ liệu không đổi.
 */
const FN = "x_inventory_level_stock_guard";
const TRIGGERS = [
  {
    name: "x_inventory_level_stock_guard_ins",
    table: "inventory_level",
    event: "insert",
    when: `new."deleted_at" is null`,
  },
  {
    name: "x_inventory_level_stock_guard_upd",
    table: "inventory_level",
    event: "update",
    when: `new."deleted_at" is null
        and (old."stocked_quantity", old."reserved_quantity", old."inventory_item_id", old."location_id", old."deleted_at")
          is distinct from
            (new."stocked_quantity", new."reserved_quantity", new."inventory_item_id", new."location_id", new."deleted_at")`,
  },
  {
    name: "x_reservation_item_stock_guard_ins",
    table: "reservation_item",
    event: "insert",
    when: `new."deleted_at" is null`,
  },
  {
    name: "x_reservation_item_stock_guard_upd",
    table: "reservation_item",
    event: "update",
    when: `new."deleted_at" is null
        and (old."deleted_at" is not null
          or new."quantity" > old."quantity"
          or new."inventory_item_id" is distinct from old."inventory_item_id"
          or new."location_id" is distinct from old."location_id")`,
  },
] as const;

/** Dòng level còn sống vi phạm (dùng cho kiểm trước khi migrate). */
const VIOLATING_LEVELS = `select count(*) from "inventory_level" l
  where l."deleted_at" is null
    and (l."stocked_quantity" < 0 or l."reserved_quantity" < 0 or l."stocked_quantity" < l."reserved_quantity"
      or l."stocked_quantity" < coalesce((
        select sum(r."quantity") from "reservation_item" r
        where r."deleted_at" is null
          and r."inventory_item_id" = l."inventory_item_id"
          and r."location_id" = l."location_id"), 0))`;

export class Migration20261028150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`do $$
declare n bigint;
begin
  if to_regclass('inventory_level') is null or to_regclass('reservation_item') is null then
    raise exception 'T-185: chưa có bảng inventory_level/reservation_item (inventory module của Medusa chưa migrate)';
  end if;
  ${VIOLATING_LEVELS} into n;
  if n > 0 then
    raise exception 'T-185: % dòng inventory_level vi phạm ${FN} (0 <= reserved <= stocked, tổng reservation_item <= stocked) — sửa dữ liệu trước khi migrate', n using errcode = '23514';
  end if;
end $$;`);
    this.addSql(`create or replace function "${FN}"() returns trigger
      language plpgsql
    as $fn$
    declare
      lid text;
      s numeric;
      r numeric;
      held numeric;
    begin
      -- Khóa dòng level của cặp trước khi cộng reservation: tuần tự hoá các phiên cùng cặp (D-134).
      select l."id", l."stocked_quantity", l."reserved_quantity" into lid, s, r
      from "inventory_level" l
      where l."inventory_item_id" = new."inventory_item_id"
        and l."location_id" = new."location_id"
        and l."deleted_at" is null
      for update;
      if not found then
        return null;
      end if;
      select coalesce(sum(ri."quantity"), 0) into held
      from "reservation_item" ri
      where ri."inventory_item_id" = new."inventory_item_id"
        and ri."location_id" = new."location_id"
        and ri."deleted_at" is null;
      if s < 0 or r < 0 or s < r or s < held then
        raise exception using
          errcode = '23514',
          constraint = '${FN}',
          message = format('${FN}: inventory_level %s stocked_quantity=%s reserved_quantity=%s reservation_items=%s (cần 0 <= reserved <= stocked, tổng giữ <= stocked)', lid, s, r, held),
          hint = 'Giữ hàng/xuất kho/điều chỉnh tồn phải chạy dưới khóa inventory_item và kiểm tồn khả dụng (T-185, D-134).';
      end if;
      return null;
    end
    $fn$;`);
    for (const t of TRIGGERS) {
      this.addSql(`drop trigger if exists "${t.name}" on "${t.table}";`);
      this.addSql(`create constraint trigger "${t.name}"
      after ${t.event} on "${t.table}"
      deferrable initially deferred
      for each row
      when (${t.when})
      execute function "${FN}"();`);
    }
  }

  override async down(): Promise<void> {
    for (const t of TRIGGERS) this.addSql(`drop trigger if exists "${t.name}" on "${t.table}";`);
    this.addSql(`drop function if exists "${FN}"();`);
  }
}
