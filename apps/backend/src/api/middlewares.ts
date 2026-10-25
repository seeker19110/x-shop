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
import { csrfGuard } from "../lib/security/csrf";
import { securityHeaders } from "../lib/security/headers";
import { quoteRateLimit, searchRateLimit, submitRateLimit } from "../lib/security/rate-limit";
import { uploadContentCheck, uploadPrecheck } from "../lib/security/upload";

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
    // Header bảo mật + CSRF cho thao tác ghi dùng cookie (SEC01, SEC05, T-034). Middleware toàn cục (không `methods`)
    // chạy trước middleware theo method; mảng giữ thứ tự → CSRF trước cổng RBAC admin bên dưới.
    { matcher: "/store", middlewares: [securityHeaders, csrfGuard("store")] },
    { matcher: "/admin", middlewares: [securityHeaders, csrfGuard("admin")] },
    { matcher: "/auth", middlewares: [securityHeaders, csrfGuard("auth")] },
    { matcher: "/x", middlewares: [securityHeaders] },
    // Rate limit Store API theo IP + khoá nghiệp vụ (SEC03, T-034); tra cứu đơn giới hạn trong route (AT20).
    { methods: ["GET"], matcher: "/store/x/search", middlewares: [searchRateLimit] },
    { methods: ["POST"], matcher: "/store/x/checkout/quote", middlewares: [quoteRateLimit] },
    { methods: ["POST"], matcher: "/store/x/checkout/submit", middlewares: [submitRateLimit] },
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
      // Upload ảnh admin (SEC04): kiểm Content-Type/Content-Length TRƯỚC multer (toàn cục), MIME bằng magic bytes SAU
      // multer (theo method — đăng ký sau middleware native của route).
      matcher: "/admin/uploads",
      middlewares: [uploadPrecheck],
    },
    {
      methods: ["POST"],
      matcher: "/admin/uploads",
      middlewares: [uploadContentCheck],
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
