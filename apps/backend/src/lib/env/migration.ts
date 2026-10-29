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

/**
 * Tham số query mà node-postgres/libpq hiểu là đích kết nối nhưng không quy về được một (máy chủ, cổng, database) duy nhất
 * một cách chắc chắn → không so được → coi là KHÁC đích.
 */
const AMBIGUOUS_TARGET_PARAMS = ["hostaddr", "service", "dbname", "database"] as const;

/**
 * Đích kết nối THỰC của URL Postgres theo cách pg-connection-string (thứ node-postgres/Medusa dùng) đọc: `?host=` (vd
 * socket Cloud SQL `?host=/cloudsql/…`) và `?port=` không rỗng ĐÈ host/cổng trong phần authority. Host chữ thường (trừ
 * đường dẫn socket), bỏ `[ ]` của IPv6; cổng mặc định 5432; tên database lấy từ đường dẫn. URL hỏng, hoặc có tham số
 * `hostaddr`/`service`/`dbname`/`database` → null.
 */
export function databaseTarget(raw: string): { host: string; port: string; database: string } | null {
  try {
    const u = new URL(raw);
    if (AMBIGUOUS_TARGET_PARAMS.some((p) => u.searchParams.has(p))) return null;
    const queryHost = u.searchParams.get("host") ?? "";
    const queryPort = u.searchParams.get("port") ?? "";
    const host = (queryHost !== "" ? queryHost : u.hostname).replace(/^\[(.+)\]$/, "$1");
    return {
      host: host.startsWith("/") ? host : host.toLowerCase(),
      port: queryPort !== "" ? queryPort : u.port === "" ? DEFAULT_PG_PORT : u.port,
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
