import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-185 (Q-13, RK-001, IND-ECOM-001; D-133, D-134, review T-185) — hàng rào phía DB cho bất biến tồn kho. Với mọi dòng
 * `inventory_level` còn sống (`deleted_at is null`) của cặp (inventory_item_id, location_id), gọi Σ = tổng `quantity` của
 * reservation_item còn sống cùng cặp:
 *   (1) `x_inventory_level_stock_guard`: 0 <= reserved_quantity <= stocked_quantity VÀ Σ <= stocked_quantity (bán âm/hết hàng);
 *   (2) `x_inventory_reserved_drift`: reserved_quantity = Σ (cột đếm khớp sổ reservation).
 * Lý do vế (2) và Σ: inventory module của Medusa 2.22.1 (`@medusajs/inventory` dist/services/inventory-module.js) đọc dòng
 * rồi ghi giá trị TUYỆT ĐỐI (`reserved = đọc + Δ`) trong cùng transaction với việc thêm/xoá reservation. Hai lần giữ hàng
 * không qua khóa Redis cùng đọc số cũ → phiên sau ghi đè: `reserved` thiếu so với Σ. Còn hàng thì (1) không bắt được, và
 * lần nhả sau đó làm `reserved` âm → bị (1) chặn vĩnh viễn (hết hạn/hủy/xuất kho dòng đó hỏng) — nên (2) từ chối ngay
 * phiên ghi đè lúc commit. Kiểm (1) trước (2): trạng thái vi phạm cả hai báo hết hàng.
 * Ánh xạ (src/lib/inventory/guard.ts): (1) → 409 hết hàng; (2) → 409 "xung đột, thử lại" (ghi lại sẽ đọc số mới).
 *
 * D-133: hàng rào chặn MỌI giữ hàng vượt tồn, kể cả reservation có `allow_backorder` — backorder thực tế TẮT theo D-133
 * (đặc tả: backorder mặc định tắt). Mở backorder = quyết định mới + migration mới.
 *
 * Bảng thuộc inventory module của Medusa nên KHÔNG thêm CHECK vào bảng của nó (Q-13 phương án A); dùng constraint
 * trigger `DEFERRABLE INITIALLY DEFERRED` của module dự án: kiểm lúc COMMIT trên trạng thái CUỐI của cặp (đọc lại, không
 * dùng giá trị của `NEW` — trạng thái trung gian trong cùng transaction được phép). Sự kiện:
 *  - inventory_level: INSERT dòng còn sống; UPDATE đổi stocked/reserved/cặp/deleted_at của dòng còn sống;
 *  - reservation_item: INSERT dòng còn sống; UPDATE đổi quantity/cặp/deleted_at (kiểm cả cặp cũ lẫn cặp mới); DELETE dòng
 *    còn sống (cặp cũ). Mọi thay đổi có thể làm trạng thái cuối vi phạm đều xếp ít nhất một sự kiện của cặp đó.
 *
 * Tuần tự hoá: hàm kiểm `select … for update` dòng inventory_level của cặp TRƯỚC khi cộng Σ. Ở READ COMMITTED, phiên sau
 * chờ khóa dòng tới khi phiên trước commit xong, rồi câu `sum` lấy snapshot mới nên thấy reservation vừa commit. (Vế (2)
 * buộc mọi thay đổi Σ đi kèm UPDATE dòng level — đã giữ khóa đó; `for update` là lớp đỡ thứ hai cho đường không qua level.)
 * Cặp không có dòng level còn sống → bỏ qua (Medusa luôn tạo level trước khi giữ hàng; xoá kho/SKU gỡ reservation riêng).
 *
 * Vi phạm → SQLSTATE `23514` (check_violation), `constraint` = tên vế và thông điệp bắt đầu bằng `<tên vế>:`.
 * Function có `search_path` cố định (schema `public` của Medusa, rồi pg_temp) — không phụ thuộc search_path của phiên gọi.
 *
 * Chạy được trên dữ liệu có sẵn: đếm dòng level còn sống vi phạm (1) hoặc (2) và DỪNG kèm số dòng (không tự sửa dữ liệu).
 * `lock_timeout` cục bộ cho transaction của migration: CREATE TRIGGER lấy khóa SHARE ROW EXCLUSIVE trên hai bảng nóng —
 * chờ quá 5 s thì lỗi (chạy lại) thay vì xếp hàng chặn mọi checkout.
 * Phụ thuộc bảng của inventory module — Medusa chạy migration module lõi trước module dự án.
 * Đường lùi (`down`): gỡ năm trigger và hai function — dữ liệu không đổi.
 */
const STOCK = "x_inventory_level_stock_guard";
const DRIFT = "x_inventory_reserved_drift";
const CHECK_FN = "x_inventory_stock_check";
const TRIGGER_FN = STOCK;
const LIVE_RESERVATION_CHANGED = `(old."quantity", old."inventory_item_id", old."location_id", old."deleted_at")
          is distinct from (new."quantity", new."inventory_item_id", new."location_id", new."deleted_at")`;
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
    when: `(old."deleted_at" is null or new."deleted_at" is null) and ${LIVE_RESERVATION_CHANGED}`,
  },
  {
    name: "x_reservation_item_stock_guard_del",
    table: "reservation_item",
    event: "delete",
    when: `old."deleted_at" is null`,
  },
] as const;

/** Σ reservation còn sống của cặp của dòng level `l`. */
const HELD_OF_LEVEL = `coalesce((
        select sum(r."quantity") from "reservation_item" r
        where r."deleted_at" is null
          and r."inventory_item_id" = l."inventory_item_id"
          and r."location_id" = l."location_id"), 0)`;

export class Migration20261028150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`do $$
declare n bigint;
begin
  if to_regclass('inventory_level') is null or to_regclass('reservation_item') is null then
    raise exception 'T-185: chưa có bảng inventory_level/reservation_item (inventory module của Medusa chưa migrate)';
  end if;
  select count(*) into n from "inventory_level" l
  where l."deleted_at" is null
    and (l."stocked_quantity" < 0 or l."reserved_quantity" < 0 or l."stocked_quantity" < l."reserved_quantity"
      or l."stocked_quantity" < ${HELD_OF_LEVEL}
      or l."reserved_quantity" <> ${HELD_OF_LEVEL});
  if n > 0 then
    raise exception 'T-185: % dòng inventory_level vi phạm ${STOCK}/${DRIFT} (0 <= reserved = tổng reservation_item <= stocked) — sửa dữ liệu trước khi migrate', n using errcode = '23514';
  end if;
end $$;`);
    this.addSql(`create or replace function "${CHECK_FN}"(p_item text, p_location text) returns void
      language plpgsql
      set search_path = public, pg_temp
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
      where l."inventory_item_id" = p_item
        and l."location_id" = p_location
        and l."deleted_at" is null
      for update;
      if not found then
        return;
      end if;
      select coalesce(sum(ri."quantity"), 0) into held
      from "reservation_item" ri
      where ri."inventory_item_id" = p_item
        and ri."location_id" = p_location
        and ri."deleted_at" is null;
      if s < 0 or r < 0 or s < r or s < held then
        raise exception using
          errcode = '23514',
          constraint = '${STOCK}',
          message = format('${STOCK}: inventory_level %s stocked_quantity=%s reserved_quantity=%s reservation_items=%s (cần 0 <= reserved <= stocked, tổng giữ <= stocked)', lid, s, r, held),
          hint = 'Giữ hàng/xuất kho/điều chỉnh tồn phải chạy dưới khóa inventory_item và kiểm tồn khả dụng (T-185, D-134).';
      end if;
      if r <> held then
        raise exception using
          errcode = '23514',
          constraint = '${DRIFT}',
          message = format('${DRIFT}: inventory_level %s reserved_quantity=%s khác tổng reservation_item còn sống=%s (ghi đồng thời không qua khóa, thử lại)', lid, r, held),
          hint = 'Thêm/bớt reservation và reserved_quantity phải cùng transaction, dưới khóa inventory_item (T-185).';
      end if;
    end
    $fn$;`);
    this.addSql(`create or replace function "${TRIGGER_FN}"() returns trigger
      language plpgsql
      set search_path = public, pg_temp
    as $fn$
    begin
      if tg_op <> 'DELETE' then
        if new."deleted_at" is null then
          perform "${CHECK_FN}"(new."inventory_item_id", new."location_id");
        end if;
      end if;
      if tg_table_name = 'reservation_item' and tg_op <> 'INSERT' then
        if old."deleted_at" is null then
          if tg_op = 'DELETE' then
            perform "${CHECK_FN}"(old."inventory_item_id", old."location_id");
          elsif new."deleted_at" is not null
            or old."inventory_item_id" is distinct from new."inventory_item_id"
            or old."location_id" is distinct from new."location_id" then
            perform "${CHECK_FN}"(old."inventory_item_id", old."location_id");
          end if;
        end if;
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
      execute function "${TRIGGER_FN}"();`);
    }
  }

  override async down(): Promise<void> {
    for (const t of TRIGGERS) this.addSql(`drop trigger if exists "${t.name}" on "${t.table}";`);
    this.addSql(`drop function if exists "${TRIGGER_FN}"();`);
    this.addSql(`drop function if exists "${CHECK_FN}"(text, text);`);
  }
}
