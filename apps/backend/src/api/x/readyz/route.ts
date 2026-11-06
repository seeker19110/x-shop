import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { checkReadiness, coalesce } from "../../../lib/health/readiness";
import { sendProblem } from "../../../lib/http/problem";
import { isDraining } from "../../../lib/lifecycle/shutdown";
import { RBAC_MODULE } from "../../../modules/rbac";
import type RbacModuleService from "../../../modules/rbac/service";

interface RawQuery {
  raw(sql: string): PromiseLike<unknown>;
}

/**
 * GET /x/readyz — readiness (OPS-OBS-006, T-079): Postgres (`select 1`) + Redis (`PING` trên kết nối dùng chung của kho
 * bảo mật; không REDIS_URL — chỉ dev/test — thì kho bộ nhớ luôn đạt), mỗi phụ thuộc có hạn ngắn (lib/health/readiness.ts).
 * Đạt → 200 `{status:"ready"}`; hỏng → 503 problem+json chung. Công khai cho bộ cân bằng tải nhưng không lộ phụ thuộc nào
 * hỏng, thông điệp lỗi, phiên bản hay cấu hình (D-050) — chi tiết chỉ ở log server.
 * Đang tắt êm (T-094, lib/lifecycle/shutdown.ts) → 503 ngay, không probe: bộ cân bằng tải ngừng gửi request mới.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse): Promise<void> => {
  if (isDraining()) {
    sendProblem(res, 503, "NOT_READY", "Dịch vụ tạm thời chưa sẵn sàng");
    return;
  }
  const pg = req.scope.resolve<RawQuery>(ContainerRegistrationKeys.PG_CONNECTION);
  const result = await coalesce(pg, () =>
    checkReadiness({
      database: () => Promise.resolve(pg.raw("select 1")),
      redis: () => req.scope.resolve<RbacModuleService>(RBAC_MODULE).securityStore().ping(),
    }),
  );
  if (result.ready) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ status: "ready" });
    return;
  }
  req.scope
    .resolve(ContainerRegistrationKeys.LOGGER)
    .warn(`readiness: không sẵn sàng (${result.failed.join(", ")})`);
  sendProblem(res, 503, "NOT_READY", "Dịch vụ tạm thời chưa sẵn sàng");
};
