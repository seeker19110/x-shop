import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261024180640 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `create table if not exists "catalog_import_job" ("id" text not null, "file_hash" text not null, "file_name" text null, "content" text not null, "status" text check ("status" in ('previewed', 'committed', 'failed')) not null default 'previewed', "rows_total" integer not null, "rows_valid" integer not null, "errors" jsonb not null, "summary" jsonb not null, "result" jsonb null, "last_error" text null, "previewed_by" text not null, "committed_by" text null, "committed_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "catalog_import_job_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_catalog_import_job_deleted_at" ON "catalog_import_job" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_catalog_import_job_file_hash" ON "catalog_import_job" ("file_hash") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "catalog_import_job" cascade;`);
  }
}
