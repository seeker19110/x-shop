import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Read model tìm/lọc cùng SKU (D-004, SPEC-catalog §4): một dòng / (SKU đã publish × kênh bán).
 * Bảng có thể tái tạo hoàn toàn từ nguồn (job rebuild) — không phải dữ liệu gốc (đặc tả §7.2).
 */
export class Migration20261024180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create extension if not exists pg_trgm;`);
    this.addSql(`create table if not exists "catalog_variant_index" (
      "variant_id" text not null,
      "sales_channel_id" text not null,
      "product_id" text not null,
      "handle" text not null,
      "title" text not null,
      "sku" text not null,
      "search_text" text not null,
      "category_handles" text[] not null default '{}',
      "color" text null,
      "color_label" text null,
      "color_hex" text null,
      "color_rank" integer null,
      "size" text null,
      "size_label" text null,
      "size_rank" integer null,
      "material" text null,
      "material_label" text null,
      "price" bigint not null check ("price" >= 0),
      "compare_at" bigint null check ("compare_at" is null or "compare_at" > "price"),
      "price_valid_until" timestamptz null,
      "in_stock" boolean not null,
      "variant_rank" integer not null default 0,
      "thumbnail" text null,
      "product_thumbnail" text null,
      "created_at" timestamptz not null,
      "indexed_at" timestamptz not null default now(),
      constraint "catalog_variant_index_pkey" primary key ("variant_id", "sales_channel_id")
    );`);
    this.addSql(
      `create index if not exists "IDX_cvi_search_text_trgm" on "catalog_variant_index" using gin ("search_text" gin_trgm_ops);`,
    );
    this.addSql(
      `create index if not exists "IDX_cvi_color_size_price" on "catalog_variant_index" ("color", "size", "price");`,
    );
    this.addSql(`create index if not exists "IDX_cvi_product_id" on "catalog_variant_index" ("product_id");`);
    this.addSql(
      `create index if not exists "IDX_cvi_channel_created" on "catalog_variant_index" ("sales_channel_id", "created_at" desc);`,
    );
    this.addSql(
      `create index if not exists "IDX_cvi_category_handles" on "catalog_variant_index" using gin ("category_handles");`,
    );
    this.addSql(
      `create index if not exists "IDX_cvi_price_valid_until" on "catalog_variant_index" ("price_valid_until") where "price_valid_until" is not null;`,
    );
    // Hàng đợi đồng bộ: sự kiện chỉ đánh dấu sản phẩm "bẩn"; một tiến trình xả gom lô (nhiều sự kiện của cùng sản
    // phẩm → một lần đồng bộ). product_id = '*' nghĩa là cần rebuild toàn phần.
    this.addSql(`create table if not exists "catalog_index_dirty" (
      "product_id" text not null,
      "marked_at" timestamptz not null default clock_timestamp(),
      constraint "catalog_index_dirty_pkey" primary key ("product_id")
    );`);
  }

  override async down(): Promise<void> {
    // Không gỡ extension pg_trgm: có thể đang được module khác dùng.
    this.addSql(`drop table if exists "catalog_index_dirty";`);
    this.addSql(`drop table if exists "catalog_variant_index";`);
  }
}
