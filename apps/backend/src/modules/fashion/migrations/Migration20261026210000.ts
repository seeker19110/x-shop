import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-101 (DB-MODEL-004, DB-MODEL-005) — vi phạm do `node scripts/ops/check-schema.mjs` tìm ra ở module fashion:
 *  - FK `fashion_model_measurement.attributes_id` không khai ON DELETE (mặc định ngầm NO ACTION) → khai `ON DELETE
 *    RESTRICT`: giữ đúng hành vi hiện tại (xoá bộ thuộc tính còn số đo người mẫu bị từ chối; workflow
 *    set-product-fashion xoá số đo trước khi xoá thuộc tính), chỉ làm tường minh. DML Medusa chỉ biểu diễn được
 *    `cascade` (`.cascades()`), nên model/snapshot giữ nguyên — `db:generate fashion` không sinh lại FK (snapshot không
 *    đổi); đổi FK lần sau phải viết tay như migration này.
 *  - Index duy nhất trên `attributes_id` là partial (`WHERE deleted_at IS NULL`) — không phục vụ kiểm FK khi xoá dòng
 *    cha (dòng đã xoá mềm vẫn phải quét) → thêm index thường.
 *  - CHECK cận dưới: `size_chart.version >= 1` (bản đầu = 1, workflow tăng dần); số đo người mẫu > 0 cm (validator
 *    API chặn chặt hơn: 20–250 cm, chiều cao 50–250 cm).
 *
 * Chạy được trên dữ liệu có sẵn: mỗi CHECK được kiểm trước (đếm dòng vi phạm → dừng migrate kèm số dòng, KHÔNG tự sửa
 * dữ liệu), rồi thêm `NOT VALID` + `VALIDATE` (migration MikroORM chạy trong giao dịch nên VALIDATE vẫn giữ khóa ACCESS EXCLUSIVE của ADD CONSTRAINT tới commit — bảng nhỏ khi chưa ra mắt). `down()` gỡ ràng buộc/index và trả FK về như cũ —
 * dữ liệu không đổi.
 */
const CHECKS = [
  { table: "size_chart", name: "size_chart_version_pos", expr: `"version" >= 1` },
  {
    table: "fashion_model_measurement",
    name: "fashion_model_measurement_height_pos",
    expr: `"height_cm" > 0`,
  },
  {
    table: "fashion_model_measurement",
    name: "fashion_model_measurement_chest_pos",
    expr: `"chest_cm" is null or "chest_cm" > 0`,
  },
  {
    table: "fashion_model_measurement",
    name: "fashion_model_measurement_waist_pos",
    expr: `"waist_cm" is null or "waist_cm" > 0`,
  },
  {
    table: "fashion_model_measurement",
    name: "fashion_model_measurement_hip_pos",
    expr: `"hip_cm" is null or "hip_cm" > 0`,
  },
] as const;

/** Dừng migrate (giữ nguyên dữ liệu) khi còn dòng vi phạm — vận hành sửa dữ liệu có chủ đích rồi chạy lại. */
const guard = (table: string, name: string, expr: string) => `do $$
declare n bigint;
begin
  select count(*) into n from "${table}" where not (${expr});
  if n > 0 then
    raise exception 'T-101: % dòng của ${table} vi phạm ${name} — sửa dữ liệu trước khi migrate', n using errcode = '23514';
  end if;
end $$;`;

export class Migration20261026210000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "fashion_model_measurement" drop constraint if exists "fashion_model_measurement_attributes_id_foreign";`,
    );
    this.addSql(
      `alter table "fashion_model_measurement" add constraint "fashion_model_measurement_attributes_id_foreign" foreign key ("attributes_id") references "fashion_product_attributes" ("id") on update cascade on delete restrict;`,
    );
    this.addSql(
      `create index if not exists "IDX_fashion_model_measurement_attributes_fk" on "fashion_model_measurement" ("attributes_id");`,
    );
    for (const c of CHECKS) {
      this.addSql(guard(c.table, c.name, c.expr));
      this.addSql(`alter table "${c.table}" drop constraint if exists "${c.name}";`);
      this.addSql(`alter table "${c.table}" add constraint "${c.name}" check (${c.expr}) not valid;`);
      this.addSql(`alter table "${c.table}" validate constraint "${c.name}";`);
    }
  }

  override async down(): Promise<void> {
    for (const c of CHECKS) this.addSql(`alter table "${c.table}" drop constraint if exists "${c.name}";`);
    this.addSql(`drop index if exists "IDX_fashion_model_measurement_attributes_fk";`);
    this.addSql(
      `alter table "fashion_model_measurement" drop constraint if exists "fashion_model_measurement_attributes_id_foreign";`,
    );
    this.addSql(
      `alter table "fashion_model_measurement" add constraint "fashion_model_measurement_attributes_id_foreign" foreign key ("attributes_id") references "fashion_product_attributes" ("id") on update cascade;`,
    );
  }
}
