import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { APP_ROLE_EXISTS_SQL, REVOKE_BOOKKEEPING_WRITES_SQL } from "../lib/db/app-role";

/**
 * Migration script của Medusa (T-184, review): chạy MỘT lần ở cuối `medusa db:migrate` (sau link sync; runner đã tạo
 * `script_migrations`), bằng vai trò migration (`db:migrate:scripts` là lệnh `db:*` → MIGRATION_DATABASE_URL).
 *
 * Trên DB mới, `link_module_migrations` và `script_migrations` được tạo SAU migration module Migration20261029120000 nên
 * nhận DML cho xshop_app qua default privileges — script này thu hồi INSERT/UPDATE/DELETE trên ba bảng sổ
 * (src/lib/db/app-role.ts). Vai trò xshop_app chưa có → cảnh báo qua logger (quyền + timeout cấp vai trò CHƯA áp; tạo vai
 * trò rồi chạy scripts/db-app-grants.sql), không lỗi. Chạy `db:migrate --skip-links/--skip-scripts` rồi sync sau → cũng
 * chạy scripts/db-app-grants.sql (docs/ops/ENV.md mục "Vai trò DB").
 */
export default async function appRoleBookkeepingReadonly({ container }: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const { rows } = (await pg.raw(APP_ROLE_EXISTS_SQL)) as { rows: Array<{ present: boolean }> };
  if (rows[0]?.present !== true) {
    logger.warn(
      "[x-shop] Vai trò DB xshop_app CHƯA có — quyền DML, bảng sổ chỉ đọc và timeout cấp vai trò chưa áp cho DB này. " +
        "Tạo vai trò (scripts/db-roles.sh hoặc hạ tầng) rồi chạy scripts/db-app-grants.sql bằng vai trò migration " +
        "(docs/ops/ENV.md, mục Vai trò DB).",
    );
    return;
  }
  await pg.raw(REVOKE_BOOKKEEPING_WRITES_SQL);
  logger.info("[x-shop] xshop_app chỉ còn SELECT trên bảng sổ migration (T-184).");
}
