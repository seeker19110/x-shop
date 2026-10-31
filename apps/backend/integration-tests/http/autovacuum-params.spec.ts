import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Migration20261031090100 } from "../../src/modules/audit/migrations/Migration20261031090100";
import { Migration20261031090000 } from "../../src/modules/checkout/migrations/Migration20261031090000";

jest.setTimeout(120 * 1000);

/**
 * T-196 (DB-PERF-008) — tham số autovacuum riêng của bốn bảng ghi nhiều trên DB test THẬT (DB riêng của suite, đã chạy
 * mọi migration): giá trị đúng sau migrate; `up()` chạy lại hai lần không lỗi, giữ nguyên; nhiều phiên chạy đồng thời
 * không lỗi; không chặn ghi đang mở (SHARE UPDATE EXCLUSIVE không xung đột ROW EXCLUSIVE); gặp khoá xung đột thì hết
 * `lock_timeout` 5 s → lỗi 55P03 thay vì treo; `down()` RESET đúng ba tham số (tham số khác của bảng giữ nguyên).
 */
const EXPECTED: Record<string, string[]> = {
  audit_log: [
    "autovacuum_analyze_scale_factor=0.05",
    "autovacuum_vacuum_cost_limit=200",
    "autovacuum_vacuum_scale_factor=0.1",
  ],
  outbox_event: [
    "autovacuum_analyze_scale_factor=0.02",
    "autovacuum_vacuum_cost_limit=400",
    "autovacuum_vacuum_scale_factor=0.02",
  ],
  rate_limit_counter: [
    "autovacuum_analyze_scale_factor=0.05",
    "autovacuum_vacuum_cost_limit=400",
    "autovacuum_vacuum_scale_factor=0.01",
  ],
  webhook_inbox: [
    "autovacuum_analyze_scale_factor=0.05",
    "autovacuum_vacuum_cost_limit=400",
    "autovacuum_vacuum_scale_factor=0.05",
  ],
};
const TABLES = Object.keys(EXPECTED);
const MIGRATIONS = [Migration20261031090000, Migration20261031090100] as const;
const LOCK_NOT_AVAILABLE = "55P03";

/** SQL thật của migration (MikroORM chỉ gom câu addSql) — không chép tay. */
async function migrationSql(direction: "up" | "down"): Promise<string[]> {
  const out: string[] = [];
  for (const M of MIGRATIONS) {
    const m = new M({} as never, {} as never);
    await m[direction]();
    out.push(...m.getQueries().map(String));
  }
  return out;
}

medusaIntegrationTestRunner({
  testSuite: ({ getContainer }) => {
    const pg = (): Knex => getContainer().resolve(ContainerRegistrationKeys.PG_CONNECTION);

    /**
     * Như Medusa: migration chạy trong transaction (MikroORM `allOrNothing` — các migration chờ của MỘT module chung một
     * transaction, mỗi cái một savepoint), nên `set local lock_timeout` còn hiệu lực tới COMMIT của lượt đó, không rò sang phiên khác.
     */
    const run = (direction: "up" | "down", db: Knex = pg()) =>
      db.transaction(async (trx) => {
        for (const sql of await migrationSql(direction)) await trx.raw(sql);
      });

    const reloptions = async (db: Knex | Knex.Transaction = pg()) => {
      const { rows } = await db.raw(
        `select c.relname, coalesce(c.reloptions, '{}') as reloptions from pg_class c
          where c.relnamespace = current_schema()::regnamespace and c.relkind = 'r' and c.relname = any(?)
          order by c.relname`,
        [TABLES],
      );
      return Object.fromEntries(
        (rows as Array<{ relname: string; reloptions: string[] }>).map((r) => [
          r.relname,
          [...r.reloptions].sort(),
        ]),
      );
    };

    it("sau migrate: bốn bảng có đúng ba tham số autovacuum riêng", async () => {
      expect(await reloptions()).toEqual(EXPECTED);
    });

    it("migration lũy đẳng: chạy lại up() hai lần không lỗi, tham số giữ nguyên", async () => {
      for (let i = 0; i < 2; i++) await run("up");
      expect(await reloptions()).toEqual(EXPECTED);
    });

    it("ĐỒNG THỜI: 6 phiên cùng chạy up() → tất cả thành công, tham số đúng", async () => {
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => run("up")));
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(await reloptions()).toEqual(EXPECTED);
    });

    it("không chặn ghi: transaction đang giữ ROW EXCLUSIVE trên cả bốn bảng → up() vẫn xong", async () => {
      const writer = await pg().transaction();
      try {
        for (const t of TABLES) await writer.raw(`lock table "${t}" in row exclusive mode`);
        await expect(run("up")).resolves.toBeUndefined();
      } finally {
        await writer.rollback();
      }
      expect(await reloptions()).toEqual(EXPECTED);
    });

    it("khoá xung đột (SHARE UPDATE EXCLUSIVE như vacuum đang chạy) → hết lock_timeout, lỗi 55P03, không treo", async () => {
      const holder = await pg().transaction();
      const started = Date.now();
      try {
        await holder.raw(`lock table "outbox_event" in share update exclusive mode`);
        const err = await run("up").then(
          () => null,
          (e: unknown) => e as { code?: string },
        );
        expect(err?.code).toBe(LOCK_NOT_AVAILABLE);
        const waited = Date.now() - started;
        expect(waited).toBeGreaterThanOrEqual(4_500);
        expect(waited).toBeLessThan(30_000);
      } finally {
        await holder.rollback();
      }
      expect(await reloptions()).toEqual(EXPECTED);
    });

    it("down() RESET đúng ba tham số, giữ tham số khác (trong transaction rồi rollback); up() lại thì về như cũ", async () => {
      const trx = await pg().transaction();
      try {
        await trx.raw(`alter table "outbox_event" set (fillfactor = 90)`);
        for (const sql of await migrationSql("down")) await trx.raw(sql);
        expect(await reloptions(trx)).toEqual({
          audit_log: [],
          outbox_event: ["fillfactor=90"],
          rate_limit_counter: [],
          webhook_inbox: [],
        });
        for (const sql of await migrationSql("up")) await trx.raw(sql);
        expect((await reloptions(trx)).outbox_event).toEqual(
          [...EXPECTED.outbox_event!, "fillfactor=90"].sort(),
        );
      } finally {
        await trx.rollback();
      }
      expect(await reloptions()).toEqual(EXPECTED);
    });

    it("down() hai lần liên tiếp không lỗi (RESET tham số đã vắng); up() khôi phục", async () => {
      await run("down");
      await run("down");
      expect(Object.values(await reloptions()).every((o) => o.length === 0)).toBe(true);
      await run("up");
      expect(await reloptions()).toEqual(EXPECTED);
    });
  },
});
