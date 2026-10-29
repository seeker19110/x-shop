/**
 * Tách vai trò DB giữa runtime và migration (T-184, Q-02, DB-SEC-002).
 *
 * - `DATABASE_URL`: vai trò ứng dụng (`xshop_app` — chỉ SELECT/INSERT/UPDATE/DELETE, không owner, không CREATE).
 * - `MIGRATION_DATABASE_URL` (tuỳ chọn, vắng = `DATABASE_URL`): vai trò migration (`xshop_migrator` — owner/DDL). Chỉ lệnh
 *   `medusa db:*` (migrate, rollback, sync-links, setup, create, generate…) dùng URL này — `isMigrationCommand`.
 *
 * Hai URL phải trỏ CÙNG máy chủ, cổng và database (chỉ khác vai trò/mật khẩu/tham số): lệch nghĩa là `db:migrate` sẽ áp
 * schema vào DB khác DB ứng dụng đang chạy — vd script đặt `DATABASE_URL` sang DB tạm trong khi `.env` còn
 * `MIGRATION_DATABASE_URL` của DB dev. Schema env từ chối thay vì để migration chạy nhầm DB.
 */

/** Tiền tố lệnh CLI của Medusa thao tác schema/migration (@medusajs/cli 2.22.1 dist/create-cli.js). */
export const MIGRATION_COMMAND_PREFIX = "db:";

/** Cổng mặc định của Postgres khi URL không ghi cổng. */
const DEFAULT_PG_PORT = "5432";

/**
 * `process.argv` của tiến trình là lệnh `medusa db:*`? Lệnh = đối số đầu tiên không phải tuỳ chọn sau `node <bin>`.
 * `medusa exec ./x.ts db:migrate` → lệnh là `exec` (không phải migration).
 */
export function isMigrationCommand(argv: readonly string[]): boolean {
  const command = argv.slice(2).find((a) => !a.startsWith("-"));
  return command !== undefined && command.startsWith(MIGRATION_COMMAND_PREFIX);
}

/** Đích kết nối của URL Postgres: máy chủ (chữ thường), cổng (mặc định 5432), tên database. URL hỏng → null. */
export function databaseTarget(raw: string): { host: string; port: string; database: string } | null {
  try {
    const u = new URL(raw);
    return {
      host: u.hostname.toLowerCase(),
      port: u.port === "" ? DEFAULT_PG_PORT : u.port,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    };
  } catch {
    return null;
  }
}

/** Hai URL Postgres trỏ cùng máy chủ + cổng + database (vai trò/mật khẩu/tham số được khác). */
export function sameDatabaseTarget(a: string, b: string): boolean {
  const ta = databaseTarget(a);
  const tb = databaseTarget(b);
  return (
    ta !== null && tb !== null && ta.host === tb.host && ta.port === tb.port && ta.database === tb.database
  );
}
