import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261024173035 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "size_chart" drop constraint if exists "size_chart_code_version_unique";`,
    );
    this.addSql(
      `alter table if exists "fashion_size" drop constraint if exists "fashion_size_value_unique";`,
    );
    this.addSql(
      `alter table if exists "fashion_color" drop constraint if exists "fashion_color_value_unique";`,
    );
    this.addSql(
      `create table if not exists "fashion_color" ("id" text not null, "value" text not null, "label" text not null, "hex" text null, "rank" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "fashion_color_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_fashion_color_deleted_at" ON "fashion_color" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fashion_color_value_unique" ON "fashion_color" ("value") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "fashion_product_attributes" ("id" text not null, "kind" text check ("kind" in ('apparel', 'shoes', 'accessory')) not null, "material" text null, "material_label" text null, "composition" text null, "stretch" text check ("stretch" in ('none', 'low', 'medium', 'high')) null, "fit" text null, "care" text null, "origin" text null, "image_exception_by" text null, "image_exception_reason" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "fashion_product_attributes_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_fashion_product_attributes_deleted_at" ON "fashion_product_attributes" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "fashion_model_measurement" ("id" text not null, "image_set" text not null, "color" text null, "height_cm" integer not null, "chest_cm" integer null, "waist_cm" integer null, "hip_cm" integer null, "size_worn" text not null, "note" text null, "attributes_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "fashion_model_measurement_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_fashion_model_measurement_attributes_id" ON "fashion_model_measurement" ("attributes_id") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_fashion_model_measurement_deleted_at" ON "fashion_model_measurement" ("deleted_at") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "fashion_size" ("id" text not null, "value" text not null, "label" text not null, "rank" integer not null default 0, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "fashion_size_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_fashion_size_deleted_at" ON "fashion_size" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_fashion_size_value_unique" ON "fashion_size" ("value") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "size_chart" ("id" text not null, "code" text not null, "version" integer not null, "name" text not null, "garment_type" text not null, "unit" text check ("unit" in ('cm')) not null default 'cm', "columns" jsonb not null, "rows" jsonb not null, "superseded_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "size_chart_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_size_chart_deleted_at" ON "size_chart" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_size_chart_code_version_unique" ON "size_chart" ("code", "version") WHERE deleted_at IS NULL;`,
    );

    this.addSql(
      `alter table if exists "fashion_model_measurement" add constraint "fashion_model_measurement_attributes_id_foreign" foreign key ("attributes_id") references "fashion_product_attributes" ("id") on update cascade;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "fashion_model_measurement" drop constraint if exists "fashion_model_measurement_attributes_id_foreign";`,
    );

    this.addSql(`drop table if exists "fashion_color" cascade;`);

    this.addSql(`drop table if exists "fashion_product_attributes" cascade;`);

    this.addSql(`drop table if exists "fashion_model_measurement" cascade;`);

    this.addSql(`drop table if exists "fashion_size" cascade;`);

    this.addSql(`drop table if exists "size_chart" cascade;`);
  }
}
