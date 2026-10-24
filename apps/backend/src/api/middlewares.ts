import {
  authenticate,
  defineMiddlewares,
  type MedusaNextFunction,
  type MedusaRequest,
  type MedusaResponse,
} from "@medusajs/framework/http";
import { CheckoutError, sendProblem } from "../lib/checkout/errors";
import {
  adminRefreshGuard,
  adminSecurityGuard,
  authRateLimit,
  loginIdentity,
  mfaIdentity,
} from "../lib/admin-security/guard";

/** Xác thực cho route /auth native (giống middleware lõi) — để rate limit/refresh guard đọc được auth_context. */
const authAny = authenticate("*", ["session", "bearer"], { allowUnregistered: true, requireMfa: false });

/**
 * Chặn đường tạo đơn native `POST /store/carts/:id/complete` (completeCartWorkflow): mọi đơn phải qua checkout tùy biến
 * (giữ hàng dưới khóa, idempotency, quote, ledger — đặc tả §6.2 "Tất cả đường tạo đơn và điều chỉnh tồn phải đi qua quy
 * tắc thống nhất"; docs/design/checkout-flow.md §1).
 */
function blockNativeCartComplete(_req: MedusaRequest, res: MedusaResponse, _next: MedusaNextFunction): void {
  sendProblem(
    res,
    new CheckoutError("NOT_FOUND", "Đặt hàng qua /store/x/checkout/submit", {
      detail: { replacement: "/store/x/checkout/submit" },
    }),
  );
}

export default defineMiddlewares({
  routes: [
    {
      // Khách đăng nhập (phiên/bearer) hoặc vãng lai; quyền với giỏ kiểm trong route (assertCartAccess).
      matcher: "/store/x/checkout*",
      middlewares: [authenticate("customer", ["session", "bearer"], { allowUnauthenticated: true })],
    },
    {
      methods: ["POST"],
      matcher: "/store/carts/:id/complete",
      middlewares: [blockNativeCartComplete],
    },
    {
      // RBAC + chính sách phiên + MFA cho MỌI route /admin/* (T-023, T-024): /admin/x/* theo map tập trung
      // (api/admin/x/permissions.ts, fail-closed), route native theo lib/admin-security/native-permissions.ts.
      matcher: "/admin",
      middlewares: [adminSecurityGuard],
    },
    {
      // Rate limit đăng nhập admin theo (email + IP), email, IP — chỉ chặn quét hàng loạt theo IP (SEC03, T-024).
      methods: ["POST"],
      matcher: "/auth/user/emailpass",
      middlewares: [authRateLimit("login", loginIdentity)],
    },
    {
      methods: ["POST"],
      matcher: "/auth/mfa/challenges/:id/verify",
      middlewares: [authAny, authRateLimit("mfa", mfaIdentity)],
    },
    {
      methods: ["POST"],
      matcher: "/auth/mfa/factors/:id/verify",
      middlewares: [authAny, authRateLimit("mfa", mfaIdentity)],
    },
    {
      // Refresh không kéo dài phiên admin quá hạn tuyệt đối/nhàn rỗi (T-024).
      methods: ["POST"],
      matcher: "/auth/token/refresh",
      middlewares: [authAny, adminRefreshGuard],
    },
  ],
});
