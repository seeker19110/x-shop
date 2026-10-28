import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-167 (D-076): rebuild toàn phần dựng dòng NGOÀI khoá ghi, chỉ giữ khoá lúc thay bảng. Trong lúc rebuild đọc nguồn, lượt
 * xả vẫn đồng bộ từng sản phẩm (và xoá dấu bẩn) → khi thay bảng, rebuild phải biết sản phẩm nào đã được ghi SAU mốc bắt
 * đầu của nó (kể cả ghi "xoá hết dòng" — sản phẩm bị xoá/ẩn) để giữ bản mới đó thay vì ghi đè bằng ảnh chụp cũ.
 *
 * `catalog_index_write_log`: mỗi sản phẩm một dòng = lần cuối `replaceProducts` ghi sản phẩm đó (cùng giao dịch ghi, đồng
 * hồ DB). Dòng `product_id = '*'` = mốc bắt đầu của lần thay toàn bảng gần nhất đã áp — rebuild có mốc cũ hơn thì bị bỏ
 * (chỉ ảnh chụp mới nhất thắng). Bảng tái tạo được, không phải dữ liệu gốc; `down()` gỡ bảng — chỉ chạy cùng lúc lùi
 * mã T-167 (`replaceProducts`/`replaceAll` ghi bảng này).
 */
export class Migration20261027230000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "catalog_index_write_log" (
      "product_id" text not null,
      "written_at" timestamptz not null default clock_timestamp(),
      constraint "catalog_index_write_log_pkey" primary key ("product_id")
    );`);
    this.addSql(
      `create index if not exists "IDX_catalog_index_write_log_written_at" on "catalog_index_write_log" ("written_at");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "catalog_index_write_log";`);
  }
}
