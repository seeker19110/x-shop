import { readFileSync } from "node:fs";
import path from "node:path";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import appRoleBookkeepingReadonly from "../../../migration-scripts/app-role-bookkeeping-readonly";
import { Migration20261029120000 } from "../../../modules/checkout/migrations/Migration20261029120000";
import {
  APP_ROLE_EXISTS_SQL,
  MIGRATION_BOOKKEEPING_TABLES,
  REVOKE_BOOKKEEPING_WRITES_SQL,
  revokeBookkeepingStatement,
} from "../app-role";

/**
 * T-184 (review): SQL quyền của xshop_app nằm ở ba nơi (migration — không import được mã; migration script; file
 * scripts/db-app-grants.sql cho DB đã migrate trước khi có vai trò). Ba nơi phải khớp; script xử lý đúng vai trò vắng/có.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");

async function upSql(): Promise<string[]> {
  const out: string[] = [];
  const capture = { addSql: (sql: string) => out.push(sql) } as unknown as Migration20261029120000;
  await Migration20261029120000.prototype.up.call(capture);
  return out;
}

describe("bảng sổ migration chỉ SELECT cho xshop_app — ba nguồn SQL khớp nhau", () => {
  it("đủ ba bảng sổ của Medusa/MikroORM", () => {
    expect([...MIGRATION_BOOKKEEPING_TABLES].sort()).toEqual([
      "link_module_migrations",
      "mikro_orm_migrations",
      "script_migrations",
    ]);
  });

  it.each([...MIGRATION_BOOKKEEPING_TABLES])(
    "%s: migration up(), migration script và db-app-grants.sql đều thu hồi ghi",
    async (table) => {
      const stmt = revokeBookkeepingStatement(table);
      expect((await upSql()).join("\n")).toContain(stmt);
      expect(REVOKE_BOOKKEEPING_WRITES_SQL).toContain(stmt);
      expect(readFileSync(path.join(REPO_ROOT, "scripts/db-app-grants.sql"), "utf8")).toContain(stmt);
    },
  );

  it("scripts/db-app-grants.sql chứa NGUYÊN VĂN hai khối DO của migration up()", async () => {
    const file = readFileSync(path.join(REPO_ROOT, "scripts/db-app-grants.sql"), "utf8");
    const blocks = await upSql();
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(file).toContain(block);
  });

  it("timeout cấp vai trò đặt DƯỚI xshop_app (không cần CREATEROLE) và trả lại vai trò trước đó", async () => {
    const [roleBlock] = await upSql();
    expect(roleBlock).toContain("set_config('role', 'xshop_app', true)");
    expect(roleBlock).toContain("set_config('role', prev_role, true)");
    expect(roleBlock).not.toMatch(/\bexecute\b|format\(/i);
  });
});

describe("migration script app-role-bookkeeping-readonly", () => {
  function fakeContainer(present: boolean) {
    const sqls: string[] = [];
    const logs = { warn: [] as string[], info: [] as string[] };
    const pg = {
      raw: async (sql: string) => {
        sqls.push(sql);
        return { rows: sql === APP_ROLE_EXISTS_SQL ? [{ present }] : [] };
      },
    };
    const logger = { warn: (m: string) => logs.warn.push(m), info: (m: string) => logs.info.push(m) };
    const container = {
      resolve: (key: string) =>
        key === ContainerRegistrationKeys.LOGGER
          ? logger
          : key === ContainerRegistrationKeys.PG_CONNECTION
            ? pg
            : undefined,
    };
    return { container, sqls, logs };
  }

  it("vai trò có → chạy câu thu hồi, ghi log info", async () => {
    const f = fakeContainer(true);
    await appRoleBookkeepingReadonly({ container: f.container } as never);
    expect(f.sqls).toEqual([APP_ROLE_EXISTS_SQL, REVOKE_BOOKKEEPING_WRITES_SQL]);
    expect(f.logs.warn).toEqual([]);
    expect(f.logs.info).toHaveLength(1);
  });

  it("vai trò vắng → không thu hồi, cảnh báo qua logger chỉ cách áp lại (db-app-grants.sql)", async () => {
    const f = fakeContainer(false);
    await appRoleBookkeepingReadonly({ container: f.container } as never);
    expect(f.sqls).toEqual([APP_ROLE_EXISTS_SQL]);
    expect(f.logs.warn).toHaveLength(1);
    expect(f.logs.warn[0]).toContain("scripts/db-app-grants.sql");
  });
});
