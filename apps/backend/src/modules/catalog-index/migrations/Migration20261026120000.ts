import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * T-061: dấu bẩn của sản phẩm bị bỏ qua vì lệch giá không bị xoá mà thử lại có backoff — `attempts` đếm số lần
 * thất bại, `next_attempt_at` (null = đến hạn ngay) là mốc sớm nhất được lấy lại.
 */
export class Migration20261026120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "catalog_index_dirty" add column if not exists "attempts" integer not null default 0;`,
    );
    this.addSql(
      `alter table "catalog_index_dirty" add column if not exists "next_attempt_at" timestamptz null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "catalog_index_dirty" drop column if exists "next_attempt_at";`);
    this.addSql(`alter table "catalog_index_dirty" drop column if exists "attempts";`);
  }
}
