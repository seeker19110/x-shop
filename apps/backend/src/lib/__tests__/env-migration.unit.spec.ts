import {
  ENV_SCHEMA_KEYS,
  REDACTED,
  SECRET_ENV_KEYS,
  formatEffectiveConfig,
  isMigrationCommand,
  parseEnv,
  sameDatabaseTarget,
} from "../env";
import { databaseTarget } from "../env/migration";
import { databaseConfig } from "../infra/timeouts";

/**
 * T-184 (Q-02, DB-SEC-002): MIGRATION_DATABASE_URL — vai trò migration tách khỏi vai trò ứng dụng.
 * Tuỳ chọn (vắng = DATABASE_URL); chỉ lệnh `medusa db:*` dùng; phải cùng máy chủ/cổng/database với DATABASE_URL.
 */

const APP_URL = "postgres://xshop_app:app-pw-SENTINEL@db.example.test:5432/xshop";
const MIGRATOR_URL = "postgres://xshop_migrator:migrator-pw-SENTINEL@db.example.test:5432/xshop";

const ok = (source: Record<string, string | undefined>) => {
  const r = parseEnv(source);
  if (!r.ok) throw new Error(`mong đợi hợp lệ: ${JSON.stringify(r.problems)}`);
  return r.env;
};
const problems = (source: Record<string, string | undefined>) => {
  const r = parseEnv(source);
  if (r.ok) throw new Error("mong đợi lỗi cấu hình");
  return r.problems;
};

describe("MIGRATION_DATABASE_URL — schema env", () => {
  it("vắng / rỗng / chỉ khoảng trắng → mặc định = DATABASE_URL", () => {
    for (const v of [undefined, "", "   "]) {
      expect(ok({ DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: v }).MIGRATION_DATABASE_URL).toBe(APP_URL);
    }
  });

  it("đặt vai trò khác trên cùng DB → giữ nguyên giá trị", () => {
    expect(ok({ DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: MIGRATOR_URL }).MIGRATION_DATABASE_URL).toBe(
      MIGRATOR_URL,
    );
  });

  it("cổng mặc định 5432 ≡ ghi rõ :5432; host không phân biệt hoa/thường; postgresql:// được; tham số khác được", () => {
    expect(
      ok({
        DATABASE_URL: "postgres://xshop_app:a-SENTINEL@DB.Example.test/xshop",
        MIGRATION_DATABASE_URL:
          "postgresql://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop?sslmode=require",
      }).MIGRATION_DATABASE_URL,
    ).toContain("xshop_migrator");
  });

  it.each([
    ["database khác", "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop_other"],
    ["máy chủ khác", "postgres://xshop_migrator:m-SENTINEL@db2.example.test:5432/xshop"],
    ["cổng khác", "postgres://xshop_migrator:m-SENTINEL@db.example.test:6432/xshop"],
    ["không tên database", "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432"],
    // node-postgres để ?host=/?port= đè authority (review T-184): cùng authority nhưng đích thật khác.
    [
      "?host= trỏ máy khác",
      "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop?host=db2.example.test",
    ],
    [
      "?host= socket khác",
      "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop?host=/cloudsql/other",
    ],
    ["?port= cổng khác", "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop?port=6432"],
    [
      "?hostaddr= (không quy được)",
      "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop?hostaddr=10.0.0.9",
    ],
    [
      "?service= (không quy được)",
      "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop?service=prod",
    ],
    [
      "?dbname= (không quy được)",
      "postgres://xshop_migrator:m-SENTINEL@db.example.test:5432/xshop?dbname=other",
    ],
  ])("%s → lỗi nêu tên biến, không lộ mật khẩu", (_label, url) => {
    const p = problems({ DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: url });
    expect(p).toEqual([
      {
        variable: "MIGRATION_DATABASE_URL",
        reason:
          "phải trỏ cùng máy chủ, cổng và database với DATABASE_URL (chỉ khác vai trò; không dùng hostaddr/service/dbname trong query)",
      },
    ]);
    expect(JSON.stringify(p)).not.toContain("SENTINEL");
  });

  it.each([
    ["giao thức sai", "mysql://u:p-SENTINEL@db.example.test/xshop"],
    ["không phải URL", "xshop_migrator:p-SENTINEL"],
    ["thiếu host", "postgres:///xshop"],
  ])("%s → lỗi định dạng, không lộ giá trị", (_label, url) => {
    const p = problems({ DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: url });
    expect(p.map((x) => x.variable)).toEqual(["MIGRATION_DATABASE_URL"]);
    expect(p[0]!.reason).toContain("postgres://");
    expect(JSON.stringify(p)).not.toContain("SENTINEL");
  });

  it("là khoá schema và là bí mật (URL kèm mật khẩu) — cấu hình hiệu lực in ra đã che", () => {
    expect(ENV_SCHEMA_KEYS).toContain("MIGRATION_DATABASE_URL");
    expect(SECRET_ENV_KEYS).toContain("MIGRATION_DATABASE_URL");
    const env = ok({ DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: MIGRATOR_URL });
    expect(JSON.stringify(env)).not.toContain("migrator-pw-SENTINEL");
    const printed = formatEffectiveConfig(env);
    expect(printed).not.toContain("migrator-pw-SENTINEL");
    expect(printed).toContain(REDACTED);
  });
});

describe("isMigrationCommand — lệnh nào dùng vai trò migration", () => {
  const node = ["/usr/bin/node", "/repo/node_modules/@medusajs/cli/cli.js"];
  it.each([
    [["db:migrate"], true],
    [["db:migrate", "--skip-links"], true],
    [["db:rollback", "checkout"], true],
    [["db:sync-links"], true],
    [["db:setup", "--db", "xshop"], true],
    [["db:create"], true],
    [["db:generate", "xShop"], true],
    [["--verbose", "db:migrate"], true],
    [["start"], false],
    [["develop"], false],
    [["exec", "./src/scripts/seed.ts"], false],
    [["exec", "./x.ts", "db:migrate"], false],
    [["build"], false],
    [[], false],
    [["--help"], false],
    [["dbmigrate"], false],
  ])("%j → %s", (args, expected) => {
    expect(isMigrationCommand([...node, ...args])).toBe(expected);
  });

  it("argv của jest/test-utils (không phải CLI medusa) → không phải migration", () => {
    expect(
      isMigrationCommand(["/usr/bin/node", "/repo/node_modules/jest/bin/jest.js", "--runInBand", "env"]),
    ).toBe(false);
  });
});

describe("databaseTarget / sameDatabaseTarget", () => {
  it("chuẩn hoá host thường, cổng mặc định, giải mã tên DB", () => {
    expect(databaseTarget("postgres://u:p@DB.Example.test/x%20shop")).toEqual({
      host: "db.example.test",
      port: "5432",
      database: "x shop",
    });
  });

  it("URL hỏng / %-mã hoá hỏng → null → không cùng đích", () => {
    expect(databaseTarget("không phải url")).toBeNull();
    expect(databaseTarget("postgres://u:p@h/%E0%A4%A")).toBeNull();
    expect(sameDatabaseTarget("không phải url", "không phải url")).toBe(false);
  });

  it("chỉ khác vai trò/mật khẩu/query → cùng đích", () => {
    expect(sameDatabaseTarget(APP_URL, `${MIGRATOR_URL}?sslmode=verify-full`)).toBe(true);
  });

  it("?host=/?port= không rỗng đè authority như pg-connection-string; rỗng thì bỏ qua", () => {
    expect(databaseTarget("postgres://u:p@localhost/xshop?host=/cloudsql/Proj:Region:Db")).toEqual({
      host: "/cloudsql/Proj:Region:Db",
      port: "5432",
      database: "xshop",
    });
    expect(databaseTarget("postgres://u:p@db.example.test:5432/xshop?host=&port=")).toEqual({
      host: "db.example.test",
      port: "5432",
      database: "xshop",
    });
    expect(databaseTarget("postgres://u:p@[::1]:6432/xshop")).toEqual({
      host: "::1",
      port: "6432",
      database: "xshop",
    });
    // Cùng socket Cloud SQL, authority khác nhau → vẫn cùng đích (đích thật là socket).
    expect(
      sameDatabaseTarget(
        "postgres://xshop_app:a@localhost/xshop?host=/cloudsql/p:r:db",
        "postgres://xshop_migrator:m@127.0.0.1/xshop?host=/cloudsql/p:r:db",
      ),
    ).toBe(true);
    expect(
      sameDatabaseTarget(
        "postgres://xshop_app:a@db.example.test/xshop",
        "postgres://xshop_migrator:m@other.example.test/xshop?host=db.example.test&port=5432",
      ),
    ).toBe(true);
  });
});

describe("databaseConfig — chọn URL theo lệnh", () => {
  const base = { DB_POOL_MAX: 5, DB_STATEMENT_TIMEOUT_MS: 30_000 };
  const userOf = (url: string) => new URL(url).username;

  it("lệnh migration → MIGRATION_DATABASE_URL (giữ statement_timeout); runtime → DATABASE_URL", () => {
    const env = { ...base, DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: MIGRATOR_URL };
    const mig = databaseConfig(env, { migration: true }).databaseUrl;
    expect(userOf(mig)).toBe("xshop_migrator");
    expect(new URL(mig).searchParams.get("statement_timeout")).toBe("30000");
    expect(userOf(databaseConfig(env, { migration: false }).databaseUrl)).toBe("xshop_app");
    expect(userOf(databaseConfig(env).databaseUrl)).toBe("xshop_app");
  });

  it("MIGRATION_DATABASE_URL vắng → lệnh migration dùng DATABASE_URL (hành vi cũ)", () => {
    expect(userOf(databaseConfig({ ...base, DATABASE_URL: APP_URL }, { migration: true }).databaseUrl)).toBe(
      "xshop_app",
    );
  });

  it("nối với env đã parse: argv db:migrate → vai trò migration; start → vai trò ứng dụng", () => {
    const env = ok({ DATABASE_URL: APP_URL, MIGRATION_DATABASE_URL: MIGRATOR_URL });
    const pick = (cmd: string) =>
      userOf(databaseConfig(env, { migration: isMigrationCommand(["node", "medusa", cmd]) }).databaseUrl);
    expect(pick("db:migrate")).toBe("xshop_migrator");
    expect(pick("start")).toBe("xshop_app");
  });
});
