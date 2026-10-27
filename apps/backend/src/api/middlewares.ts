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
  emailpassOnly,
  loginIdentity,
  mfaIdentity,
  rejectEmailpassGet,
} from "../lib/admin-security/guard";
import { inviteAcceptGuard } from "../lib/admin-security/invite-guard";
import { registerGate } from "../lib/admin-security/register-gate";
import { securityAuditTrail } from "../lib/audit/http";
import { xErrorHandler } from "../lib/errors/error-handler";
import { requestLogContext } from "../lib/log/http";
import { csrfGuard } from "../lib/security/csrf";
import { securityHeaders } from "../lib/security/headers";
import { rejectNulBytes } from "../lib/security/nul-bytes";
import {
  productSearchRateLimit,
  quoteRateLimit,
  searchRateLimit,
  submitRateLimit,
} from "../lib/security/rate-limit";
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
  // Handler lỗi toàn cục (T-088): problem+json có trace_id, 5xx không lộ stack/SQL/đường dẫn (lib/errors/error-handler.ts).
  errorHandler: xErrorHandler,
  routes: [
    // Ngữ cảnh log (trace_id/span_id) + log truy cập đã che cho MỌI request (T-090, lib/log/http.ts). `matcher: "/"`
    // không `methods` → Medusa xếp vào nhóm global, chạy trước mọi middleware khác của dự án.
    { matcher: "/", middlewares: [requestLogContext] },
    // Audit sự kiện xác thực + xuất/truy cập dữ liệu nhạy cảm theo bảng route (T-091, lib/audit/http.ts): ghi SAU khi
    // phản hồi xong, kể cả thất bại/429. Toàn cục → gắn trước rate limit/CSRF nên thấy cả request bị chặn sớm.
    { matcher: "/auth", middlewares: [securityAuditTrail] },
    { matcher: "/admin", middlewares: [securityAuditTrail] },
    // Header bảo mật + CSRF cho thao tác ghi dùng cookie (SEC01, SEC05, T-034). Middleware toàn cục (không `methods`)
    // chạy trước middleware theo method; mảng giữ thứ tự → CSRF trước cổng RBAC admin bên dưới.
    // `rejectNulBytes` (T-085): `%00`/U+0000 ở đường dẫn, query, thân → 400 trước khi tới DB (Postgres không nhận NUL).
    { matcher: "/store", middlewares: [securityHeaders, csrfGuard("store"), rejectNulBytes] },
    { matcher: "/admin", middlewares: [securityHeaders, csrfGuard("admin"), rejectNulBytes] },
    { matcher: "/auth", middlewares: [securityHeaders, csrfGuard("auth"), rejectNulBytes] },
    { matcher: "/x", middlewares: [securityHeaders, rejectNulBytes] },
    // Rate limit Store API theo IP + khoá nghiệp vụ (SEC03, T-034); tra cứu đơn giới hạn trong route (AT20).
    { methods: ["GET"], matcher: "/store/x/search", middlewares: [searchRateLimit] },
    { methods: ["GET"], matcher: "/store/x/products", middlewares: [productSearchRateLimit] },
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
      // Rate limit đăng nhập theo (email + IP), email, IP — chỉ chặn quét hàng loạt theo IP (SEC03, T-024). Matcher THAM SỐ
      // (T-138): identity emailpass dùng chung mọi actor nên `/auth/customer/emailpass`, `/auth/<actor lạ>/emailpass`,
      // `/auth/%75ser/emailpass` (Express khớp literal trên đường dẫn thô nhưng giải mã tham số) cũng đoán được mật khẩu
      // admin — mọi actor cộng chung một bộ đếm theo email.
      methods: ["POST"],
      matcher: "/auth/:actor_type/:auth_provider",
      middlewares: [emailpassOnly(authRateLimit("login", loginIdentity))],
    },
    {
      // GET (HEAD đi theo GET trong Express) của route đăng nhập gốc cũng chạy authenticate → 405 cho emailpass (T-138).
      methods: ["GET", "HEAD"],
      matcher: "/auth/:actor_type/:auth_provider",
      middlewares: [rejectEmailpassGet],
    },
    {
      // Lời mời admin ràng buộc email + identity (T-138, D-075): accept không đổi được email, không gắn identity khác.
      methods: ["POST"],
      matcher: "/admin/invites/accept",
      middlewares: [inviteAcceptGuard],
    },
    {
      // Đăng ký (BE-AUTH-003, T-138, D-068): rate limit rồi cổng lời mời — chỉ actor `user` + `emailpass` có lời mời hợp lệ
      // cho đúng email; mọi ca khác (email admin có thật, email lạ, `customer`, actor lạ) cùng một phản hồi 400, không tạo
      // auth_identity (lib/admin-security/register-gate.ts).
      methods: ["POST"],
      matcher: "/auth/:actor_type/:auth_provider/register",
      middlewares: [authRateLimit("register", loginIdentity), registerGate],
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
