import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261024193304 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "shipment_event" drop constraint if exists "shipment_event_event_key_unique";`,
    );
    this.addSql(
      `alter table if exists "shipment" drop constraint if exists "shipment_provider_order_code_unique";`,
    );
    this.addSql(
      `alter table if exists "shipment" drop constraint if exists "shipment_client_order_code_unique";`,
    );
    this.addSql(
      `create table if not exists "shipment" ("id" text not null, "order_id" text not null, "client_order_code" text not null, "provider" text not null, "provider_order_code" text null, "state" text check ("state" in ('unfulfilled', 'picking', 'packed', 'shipped', 'delivered', 'failed', 'returning', 'returned')) not null default 'unfulfilled', "cod_amount" integer not null, "shipping_fee" integer null, "payer" text check ("payer" in ('shop', 'recipient')) not null, "label_url" text null, "created_by" text not null, "cod_reported_amount" integer null, "cod_reported_at" timestamptz null, "settlement_state" text check ("settlement_state" in ('unsettled', 'partially_settled', 'settled', 'disputed')) not null default 'unsettled', "delivered_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "shipment_pkey" primary key ("id"), constraint shipment_cod_amount_nonneg check (cod_amount >= 0), constraint shipment_shipping_fee_nonneg check (shipping_fee IS NULL OR shipping_fee >= 0), constraint shipment_cod_reported_nonneg check (cod_reported_amount IS NULL OR cod_reported_amount >= 0));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_shipment_deleted_at" ON "shipment" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_shipment_client_order_code_unique" ON "shipment" ("client_order_code");`,
    );
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shipment_order_id" ON "shipment" ("order_id");`);
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_shipment_provider_order_code_unique" ON "shipment" ("provider", "provider_order_code") WHERE provider_order_code IS NOT NULL AND deleted_at IS NULL;`,
    );

    this.addSql(
      `create table if not exists "shipment_event" ("id" text not null, "provider" text not null, "event_key" text not null, "shipment_id" text null, "provider_order_code" text not null, "type" text not null, "status" text not null, "raw" jsonb not null, "applied" boolean not null default false, "result" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "shipment_event_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_shipment_event_deleted_at" ON "shipment_event" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_shipment_event_event_key_unique" ON "shipment_event" ("event_key");`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_shipment_event_shipment_id" ON "shipment_event" ("shipment_id");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "shipment" cascade;`);

    this.addSql(`drop table if exists "shipment_event" cascade;`);
  }
}
