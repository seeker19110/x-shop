import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261024194327 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "outbound_message" drop constraint if exists "outbound_message_key_unique";`,
    );
    this.addSql(
      `create table if not exists "outbound_message" ("id" text not null, "message_key" text not null, "aggregate_id" text not null, "template" text not null, "channel" text check ("channel" in ('email', 'sms')) not null, "recipient_masked" text not null, "adapter" text not null, "live" boolean not null default false, "state" text check ("state" in ('sending', 'sent', 'failed')) not null default 'sending', "attempts" integer not null default 1, "provider_message_id" text null, "last_error" text null, "sent_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "outbound_message_pkey" primary key ("id"), constraint outbound_message_attempts_pos check (attempts >= 1));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_outbound_message_deleted_at" ON "outbound_message" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_outbound_message_key_unique" ON "outbound_message" ("message_key");`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_outbound_message_aggregate" ON "outbound_message" ("aggregate_id");`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "outbound_message" cascade;`);
  }
}
