import type { Knex } from "@medusajs/framework/mikro-orm/knex";
import { ROLES, type Role } from "@x-shop/domain";

const TABLE = "user_role";

export interface UserRoleRow {
  user_id: string;
  role: Role;
  granted_by: string | null;
  granted_at: Date;
}

export const isRole = (v: unknown): v is Role =>
  typeof v === "string" && (ROLES as readonly string[]).includes(v);

/**
 * Lưu vai trò của admin user (T-023). Ma trận vai trò → quyền là dữ liệu ở `@x-shop/domain` (ROLE_GRANTS); bảng này chỉ
 * giữ "ai có vai trò gì". Vai trò lạ trong DB (không thể do CHECK) cũng bị lọc khi đọc → từ chối mặc định.
 */
export default class RbacModuleService {
  protected readonly db: Knex;

  constructor({ __pg_connection__ }: { __pg_connection__: Knex }) {
    this.db = __pg_connection__;
  }

  async rolesOf(userId: string): Promise<Role[]> {
    if (!userId) return [];
    const rows = await this.db(TABLE).select("role").where({ user_id: userId }).orderBy("role");
    return rows.map((r: { role: string }) => r.role).filter(isRole);
  }

  async listAssignments(userId: string): Promise<UserRoleRow[]> {
    return this.db(TABLE).select("*").where({ user_id: userId }).orderBy("role");
  }

  /** Cấp vai trò (idempotent). `created=false` khi user đã có vai trò đó. */
  async grant(userId: string, role: Role, grantedBy: string | null): Promise<{ created: boolean }> {
    const rows = await this.db(TABLE)
      .insert({ user_id: userId, role, granted_by: grantedBy })
      .onConflict(["user_id", "role"])
      .ignore()
      .returning("user_id");
    return { created: rows.length > 0 };
  }

  /**
   * Thu hồi vai trò. Không cho thu hồi owner cuối cùng (khóa bảng theo hàng owner để hai lần thu hồi song song không
   * cùng lọt qua kiểm "còn owner khác").
   */
  async revoke(userId: string, role: Role): Promise<{ removed: boolean; lastOwner: boolean }> {
    return this.db.transaction(async (trx) => {
      if (role === "owner") {
        const owners = await trx(TABLE).select("user_id").where({ role: "owner" }).forUpdate();
        const isOwner = owners.some((o: { user_id: string }) => o.user_id === userId);
        if (isOwner && owners.length <= 1) return { removed: false, lastOwner: true };
      }
      const n = await trx(TABLE).where({ user_id: userId, role }).delete();
      return { removed: n > 0, lastOwner: false };
    });
  }
}
