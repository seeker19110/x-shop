import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { isNonEmpty, kibToBytes, secondsToMs, type Permission } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../modules/checkout";
import type CheckoutModuleService from "../../modules/checkout/service";
import type { AuditOutcome } from "../../modules/audit/service";
import { adminRuleOf } from "../admin-security/guard";
import { normalizeMethod } from "../admin-security/route-match";
import { rawRequestPath } from "../http/request-path";
import { ipRateKey } from "../security/client-ip";
import { clientIpOf } from "../security/config";
import { decideDenyAudit, type WindowCounter } from "./deny-throttle";
import { SECURITY_EVENTS, type SecurityEventName } from "./events";
import { hashIdentifier, recordAudit } from "./record";

/**
 * Audit sự kiện xác thực, xuất/truy cập dữ liệu nhạy cảm, upload và đổi cấu hình qua route native (T-091, T-175,
 * SEC-LOG-001/002, CMP-AUDIT-002).
 *
 * Một middleware toàn cục (`securityAuditTrail`, đăng ký cho `/auth` và `/admin` ở api/middlewares.ts) tra bảng
 * `AUDIT_ROUTES`; route khớp → ghi MỘT dòng audit SAU khi phản hồi xong (`finish` — không thêm độ trễ vào phản hồi, không
 * đổi thời gian phản hồi đăng nhập — BE-AUTH-003) hoặc khi kết nối đóng trước đó (`close` khi chưa `writableFinished`:
 * client ngắt giữa chừng — handler VẪN chạy tiếp, vd workflow xuất PII vẫn tạo file → chờ handler gọi `res.end` tối đa
 * `ABORT_WAIT_MS` rồi lấy kết quả theo status thật, kèm `changes.aborted`; hết hạn chưa có phản hồi → `failure`,
 * `status: null`), kể cả khi thất bại/bị từ chối:
 *   - khớp route NHƯ ROUTER EXPRESS THẤY (T-145, `matchAuditRoute`): pathname từ `rawRequestPath` (URL tuyệt đối, `\`,
 *     `#` như `parseurl`), đoạn tĩnh so với pathname CHƯA giải mã (không phân biệt hoa thường), đoạn tham số giải mã `%xx`
 *     — `/auth/%75ser/emailpass` là đăng nhập (actor `user`), `/admin/customers/cus%5F1` có id `cus_1`;
 *   - kết quả theo status (`outcomeOfStatus`): < 400 success · 403/429 denied · còn lại failure;
 *   - route có rate limit (đăng nhập, xác minh MFA): 429 → sự kiện `auth.lockout` (khoá tạm thời theo định danh/IP);
 *   - chống ngập (`deny-throttle.ts`, ghi lần 1, 10, 100… của nhóm trong cửa sổ): lockout, yêu cầu đặt lại mật khẩu và
 *     MỌI thất bại vô danh gộp theo (nguồn `ipRateKey` — IPv4 nguyên địa chỉ, IPv6 cả /64 —, sự kiện, kết quả) — KHÔNG
 *     theo định danh trong thân (kẻ tấn công tự chọn, đổi email mỗi lần là lách được) và không theo từng địa chỉ IPv6
 *     (xoay địa chỉ trong /64 là lách được); cột `ip_hash` vẫn là băm của địa chỉ đầy đủ;
 *   - riêng `/admin`: 401/403 không ghi ở đây (403 do cổng RBAC ghi `rbac.denied`, kể cả `MFA_REQUIRED`/`REAUTH_REQUIRED`)
 *     — trừ route công khai với cổng RBAC (`recordAuthFailures`: chấp nhận lời mời);
 *   - đổi cấu hình: route liệt kê (`configRoute`) + MỌI lần ghi route native mang quyền `settings.manage` (suy từ bảng
 *     quyền — `NATIVE_CONFIG_ROUTE`); chỉ TÊN trường của thân khi thành công (`changes.fields`), không giá trị; đích tạo
 *     mới lấy id từ thân phản hồi.
 * Không PII thô: định danh đăng nhập (email) → bí danh HMAC `idh_…` (`hashIdentifier`); `actor_id` dạng email (token đặt
 * lại mật khẩu của Medusa mang email làm actor_id) cũng thành bí danh; IP → `ip_hash`; User-Agent cắt ngắn + che.
 * Token trong phản hồi chỉ được giải mã phần payload để lấy actor/auth identity — không lưu token.
 * Ghi audit lỗi → log lỗi (không PII), không ảnh hưởng request.
 */

type Scope = "auth" | "admin";
/** Đích của sự kiện: từ đoạn đường dẫn, request, hoặc thân PHẢN HỒI (route tạo mới — id chỉ có sau khi tạo). */
type TargetFn = (
  segments: readonly string[],
  req: MedusaRequest,
  body?: unknown,
) => { type: string; id: string | null };

export interface AuditRoute {
  /** `WRITE` chỉ dùng cho route suy ra từ bảng quyền (`NATIVE_CONFIG_ROUTE`) — mọi method ghi. */
  method: "GET" | "POST" | "DELETE" | "WRITE";
  /** Mẫu của `matchPath` (`:param` một đoạn; `*` cuối = 0..n đoạn). */
  pattern: string;
  event: SecurityEventName;
  scope: Scope;
  /** Đích = bí danh của định danh lấy từ thân/ctx thay vì `target`. */
  identity?: "body_email" | "body_identifier" | "ctx_actor";
  target?: TargetFn;
  /** Route có rate limit: 429 → `auth.lockout` (gộp tần suất). */
  rateLimited?: boolean;
  /** Mọi lần (kể cả thành công) đều gộp tần suất — route vô danh không có rate limit (yêu cầu đặt lại mật khẩu). */
  throttleAll?: boolean;
  /** Thêm vào `changes` (vd `dataset`, `pii`, `format` cố định). */
  details?: Record<string, unknown>;
  /** `changes.format` lấy từ thân (`format` ∈ values), không có → `fallback` (theo mặc định thật của route native). */
  bodyFormat?: { values: readonly string[]; fallback: string };
  /** Đoạn tham số (đã giải mã, phân biệt hoa thường như Auth Module) phải thuộc tập — vd provider = `emailpass`. */
  segmentIn?: { index: number; values: readonly string[] };
  /** Không ghi (route tĩnh của Medusa trùng hình mẫu tham số phía sau, vd `/auth/verification/request`). */
  skip?: true;
  /**
   * Route `/admin` công khai với cổng RBAC (chấp nhận lời mời): 401/403 KHÔNG do cổng RBAC trả (không có `rbac.denied`)
   * → vẫn ghi ở đây. Mặc định route admin bỏ qua 401/403 (đã có `rbac.denied`).
   */
  recordAuthFailures?: true;
  /** Ghi TÊN trường cấp đầu của thân yêu cầu (không giá trị) vào `changes.fields` — biết cấu hình nào bị đổi. */
  bodyFields?: true;
  /** Chi tiết thêm từ request/phản hồi (vd số file, dung lượng của upload). Không được ném; không chép dữ liệu nhập. */
  extra?: (
    req: MedusaRequest,
    body: unknown,
    status: number | null,
    m: MatchedRoute,
  ) => Record<string, unknown>;
}

/** Actor/provider đã biết; giá trị khác ghi `"other"` (không chép chuỗi do client chọn vào audit). */
export const KNOWN_ACTOR_TYPES: readonly string[] = ["user", "customer"];
export const KNOWN_PROVIDERS: readonly string[] = ["emailpass"];
const known = (v: string | undefined, set: readonly string[]): string =>
  v !== undefined && set.includes(v) ? v : "other";
const seg =
  (type: string, index: number): TargetFn =>
  (s) => ({ type, id: s[index] ?? null });
const authIdentityOf: TargetFn = (_s, req) => {
  const id = (req as AuthedRequest).auth_context?.auth_identity_id;
  return { type: "auth_identity", id: isNonEmpty(id) ? id : null };
};
const fixed =
  (type: string, id: string | null): TargetFn =>
  () => ({ type, id });
/** Id từ thân phản hồi `{ <key>: { id } }` (route tạo mới của Medusa: `api_key`, `invite`, `user`). */
const fromBody =
  (type: string, key: string): TargetFn =>
  (_s, _req, body) => {
    const id = ((body as Record<string, unknown> | null)?.[key] as { id?: unknown } | undefined)?.id;
    return { type, id: typeof id === "string" ? id : null };
  };

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 30;
/** Tên trường cấp đầu của thân yêu cầu (chỉ tên hợp lệ, ≤ 30) — không bao giờ giá trị. Thân không phải object → null. */
export function bodyFieldNames(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Buffer.isBuffer(body)) return null;
  return Object.keys(body)
    .filter((k) => FIELD_NAME.test(k))
    .sort()
    .slice(0, MAX_FIELDS);
}

/** File upload (multer, `req.files`): số file, tổng byte; loại MIME chỉ khi thành công (đã được kiểm bằng magic bytes). */
export function uploadDetails(
  req: MedusaRequest,
  body: unknown,
  status: number | null,
): Record<string, unknown> {
  const files = (req as MedusaRequest & { files?: unknown }).files;
  const list = Array.isArray(files) ? (files as Array<{ size?: unknown; mimetype?: unknown }>) : [];
  const out: Record<string, unknown> = {
    file_count: list.length,
    total_bytes: list.reduce(
      (n, f) => n + (Number.isSafeInteger(f.size) && (f.size as number) >= 0 ? (f.size as number) : 0),
      0,
    ),
  };
  if (status !== null && status < 400) {
    out.mime_types = [
      ...new Set(list.map((f) => (typeof f.mimetype === "string" ? f.mimetype : "unknown"))),
    ].sort();
    const ids = uploadedFileIds(body);
    if (ids.length > 1) out.file_ids = ids;
  }
  return out;
}

function uploadedFileIds(body: unknown): string[] {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => safeId((f as { id?: unknown } | null)?.id))
    .filter((id): id is string => id !== null)
    .slice(0, 10);
}

/** Một file → id của nó; nhiều file → null (danh sách ở `changes.file_ids`). */
const uploadTarget: TargetFn = (_s, _req, body) => {
  const ids = uploadedFileIds(body);
  return { type: "file", id: ids.length === 1 ? (ids[0] as string) : null };
};

/** Đổi cấu hình qua route native (CMP-AUDIT-002): đích = loại + id, `changes.operation`, tên trường đổi (không giá trị). */
const configRoute = (
  method: "POST" | "DELETE",
  pattern: string,
  type: string,
  operation: string,
  target: TargetFn = seg(type, 2),
  extra: Partial<AuditRoute> = {},
): AuditRoute => ({
  method,
  pattern,
  event: SECURITY_EVENTS.CONFIG_CHANGED,
  scope: "admin",
  target,
  details: { operation },
  bodyFields: true,
  ...extra,
});

/** Thứ tự có nghĩa: khớp mẫu đầu tiên (mẫu cụ thể trước mẫu có tham số). */
export const AUDIT_ROUTES: readonly AuditRoute[] = [
  // --- Xác thực (native Medusa 2.22.1 /auth/*) ---
  {
    method: "POST",
    pattern: "/auth/session",
    event: SECURITY_EVENTS.SESSION_CREATED,
    scope: "auth",
    target: authIdentityOf,
  },
  {
    method: "DELETE",
    pattern: "/auth/session",
    event: SECURITY_EVENTS.LOGOUT,
    scope: "auth",
    target: authIdentityOf,
  },
  {
    method: "POST",
    pattern: "/auth/token/refresh",
    event: SECURITY_EVENTS.TOKEN_REFRESHED,
    scope: "auth",
    target: authIdentityOf,
  },
  {
    method: "POST",
    pattern: "/auth/mfa/challenges/:id/verify",
    event: SECURITY_EVENTS.MFA_VERIFIED,
    scope: "auth",
    target: seg("mfa_challenge", 3),
    rateLimited: true,
  },
  {
    method: "POST",
    pattern: "/auth/mfa/factors/:id/verify",
    event: SECURITY_EVENTS.MFA_ENROLLED,
    scope: "auth",
    target: seg("mfa_factor", 3),
    rateLimited: true,
  },
  {
    method: "DELETE",
    pattern: "/auth/mfa/factors/:id",
    event: SECURITY_EVENTS.MFA_FACTOR_REMOVED,
    scope: "auth",
    target: seg("mfa_factor", 3),
  },
  {
    method: "POST",
    pattern: "/auth/mfa/factors",
    event: SECURITY_EVENTS.MFA_ENROLL_STARTED,
    scope: "auth",
    target: authIdentityOf,
  },
  {
    method: "POST",
    pattern: "/auth/mfa/recovery-codes",
    event: SECURITY_EVENTS.MFA_RECOVERY_CODES_ISSUED,
    scope: "auth",
    target: authIdentityOf,
  },
  {
    method: "POST",
    pattern: "/auth/verification/request",
    event: SECURITY_EVENTS.LOGIN,
    scope: "auth",
    skip: true,
  },
  {
    method: "POST",
    pattern: "/auth/verification/confirm",
    event: SECURITY_EVENTS.LOGIN,
    scope: "auth",
    skip: true,
  },
  // Identity emailpass dùng chung mọi actor (T-138): `/auth/<actor bất kỳ>/emailpass` đều đoán được mật khẩu → mọi actor.
  {
    method: "POST",
    pattern: "/auth/:actor_type/:provider/reset-password",
    event: SECURITY_EVENTS.PASSWORD_RESET_REQUESTED,
    scope: "auth",
    identity: "body_identifier",
    throttleAll: true,
  },
  {
    method: "POST",
    pattern: "/auth/:actor_type/:provider/update",
    event: SECURITY_EVENTS.PASSWORD_CHANGED,
    scope: "auth",
    identity: "ctx_actor",
  },
  {
    method: "POST",
    pattern: "/auth/:actor_type/:provider",
    event: SECURITY_EVENTS.LOGIN,
    scope: "auth",
    identity: "body_email",
    rateLimited: true,
  },
  // GET/HEAD đăng nhập emailpass (kèm thân) → 405 từ T-138: vẫn là một lần thử đăng nhập bị chặn → ghi.
  {
    method: "GET",
    pattern: "/auth/:actor_type/:provider",
    event: SECURITY_EVENTS.LOGIN,
    scope: "auth",
    identity: "body_email",
    segmentIn: { index: 2, values: KNOWN_PROVIDERS },
  },
  // --- Xuất dữ liệu ---
  {
    method: "GET",
    pattern: "/admin/x/exports/products.csv",
    event: SECURITY_EVENTS.DATA_EXPORTED,
    scope: "admin",
    target: fixed("export", "products.csv"),
    details: { dataset: "products", format: "csv", pii: false },
  },
  {
    method: "POST",
    pattern: "/admin/orders/export",
    event: SECURITY_EVENTS.DATA_EXPORTED,
    scope: "admin",
    target: fixed("export", "orders"),
    details: { dataset: "orders", format: "csv", pii: true },
  },
  {
    method: "POST",
    pattern: "/admin/customers/export",
    event: SECURITY_EVENTS.DATA_EXPORTED,
    scope: "admin",
    target: fixed("export", "customers"),
    // exportCustomersWorkflow 2.22.1: `format` của thân (csv|json), không có → JSON (mimeType application/json).
    details: { dataset: "customers", pii: true },
    bodyFormat: { values: ["csv", "json"], fallback: "json" },
  },
  {
    method: "POST",
    pattern: "/admin/products/export",
    event: SECURITY_EVENTS.DATA_EXPORTED,
    scope: "admin",
    target: fixed("export", "products"),
    details: { dataset: "products", format: "csv", pii: false },
  },
  {
    method: "POST",
    pattern: "/admin/inventory-items/export",
    event: SECURITY_EVENTS.DATA_EXPORTED,
    scope: "admin",
    target: fixed("export", "inventory_items"),
    details: { dataset: "inventory_items", format: "csv", pii: false },
  },
  // --- Tệp (native Medusa 2.22.1 `/admin/uploads`; `presigned-urls` bị tắt — 403 của uploadPrecheck, không ghi) ---
  {
    method: "POST",
    pattern: "/admin/uploads",
    event: SECURITY_EVENTS.FILE_UPLOADED,
    scope: "admin",
    target: uploadTarget,
    extra: uploadDetails,
  },
  {
    method: "DELETE",
    pattern: "/admin/uploads/:id",
    event: SECURITY_EVENTS.FILE_DELETED,
    scope: "admin",
    target: seg("file", 2),
  },
  // --- Đổi cấu hình qua route native (Medusa 2.22.1: stores, api-keys, invites, users — POST/DELETE) ---
  configRoute("POST", "/admin/stores/:id", "store", "update"),
  configRoute("POST", "/admin/api-keys", "api_key", "create", fromBody("api_key", "api_key")),
  configRoute("POST", "/admin/api-keys/:id/revoke", "api_key", "revoke"),
  configRoute("POST", "/admin/api-keys/:id/sales-channels", "api_key", "update_sales_channels"),
  configRoute("POST", "/admin/api-keys/:id", "api_key", "update"),
  configRoute("DELETE", "/admin/api-keys/:id", "api_key", "delete"),
  // Chấp nhận lời mời = tạo tài khoản admin; route công khai với cổng RBAC → ghi cả 401/403 của chính nó.
  configRoute("POST", "/admin/invites/accept", "user", "invite_accepted", fromBody("user", "user"), {
    recordAuthFailures: true,
  }),
  configRoute("POST", "/admin/invites", "invite", "create", fromBody("invite", "invite")),
  configRoute("POST", "/admin/invites/:id/resend", "invite", "resend"),
  configRoute("DELETE", "/admin/invites/:id", "invite", "delete"),
  // Phản hồi `reset-password` chứa token đặt lại — không đọc (tokenClaims chỉ áp cho /auth).
  configRoute("POST", "/admin/users/:id/reset-password", "user", "reset_password_token_issued"),
  configRoute("POST", "/admin/users/:id/roles", "user", "native_roles_assigned"),
  configRoute("DELETE", "/admin/users/:id/roles/:role_id", "user", "native_role_removed"),
  configRoute("DELETE", "/admin/users/:id/roles", "user", "native_roles_removed"),
  configRoute("POST", "/admin/users/:id", "user", "update"),
  configRoute("DELETE", "/admin/users/:id", "user", "delete"),
  // --- Truy cập dữ liệu nhạy cảm (đối soát, PII khách qua route native) ---
  {
    // Tải file private (T-141): file xuất PII khách/đơn — coi là PII. Đích = khoá file (không chứa dữ liệu người dùng).
    method: "GET",
    pattern: "/admin/x/files/:key",
    event: SECURITY_EVENTS.DATA_ACCESSED,
    scope: "admin",
    target: seg("private_file", 3),
    details: { dataset: "private_file", pii: true },
  },
  {
    method: "GET",
    pattern: "/admin/x/settlements/batches/:id",
    event: SECURITY_EVENTS.DATA_ACCESSED,
    scope: "admin",
    target: seg("settlement_batch", 4),
    details: { dataset: "settlement", pii: false },
  },
  {
    method: "GET",
    pattern: "/admin/customers/*",
    event: SECURITY_EVENTS.DATA_ACCESSED,
    scope: "admin",
    target: seg("customer", 2),
    details: { dataset: "customers", pii: true },
  },
  {
    method: "GET",
    pattern: "/admin/orders/*",
    event: SECURITY_EVENTS.DATA_ACCESSED,
    scope: "admin",
    target: seg("order", 2),
    details: { dataset: "orders", pii: true },
  },
  // Route native RBAC xếp vào `order.read` (native-permissions.ts) — trả tên/địa chỉ/liên hệ khách. Chỉ route có GET
  // trong Medusa 2.22.1 (order-changes/order-edits/fulfillments không có GET → không liệt kê).
  ...(
    [
      ["customer-groups", "customer_group"],
      ["draft-orders", "draft_order"],
      ["returns", "return"],
      ["claims", "claim"],
      ["exchanges", "exchange"],
    ] as const
  ).map(([path, type]): AuditRoute => ({
    method: "GET",
    pattern: `/admin/${path}/*`,
    event: SECURITY_EVENTS.DATA_ACCESSED,
    scope: "admin",
    target: seg(type, 2),
    details: { dataset: path.replace(/-/g, "_"), pii: true },
  })),
];

export interface MatchedRoute {
  route: AuditRoute;
  segments: string[];
  path: string;
  method: string;
}

/**
 * Khớp một mẫu như path-to-regexp của Express (không strict): đoạn tĩnh so với đoạn CHƯA giải mã, không phân biệt hoa
 * thường; `:param` khớp một đoạn khác rỗng, giá trị = đoạn đã giải mã (`decodeURIComponent` — Express `decode_param`);
 * `*` cuối khớp 0..n đoạn còn lại (cũng giải mã). Trả các đoạn đã giải mã, hoặc `null` nếu không khớp/mã hoá hỏng
 * (Express trả 400 — không phải route này).
 */
function matchRoutePattern(pattern: string, rawSegments: readonly string[]): string[] | null {
  const p = pattern.split("/").filter(Boolean);
  const decoded: string[] = [];
  const decode = (v: string): string | null => {
    try {
      return decodeURIComponent(v);
    } catch {
      return null;
    }
  };
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    if (seg === "*" && i === p.length - 1) {
      for (const rest of rawSegments.slice(i)) {
        const d = decode(rest);
        if (d === null) return null;
        decoded.push(d);
      }
      return decoded;
    }
    const actual = rawSegments[i];
    if (actual === undefined) return null;
    if (seg.startsWith(":")) {
      const d = decode(actual);
      if (d === null || d === "") return null;
      decoded.push(d);
    } else if (seg.toLowerCase() === actual.toLowerCase()) {
      decoded.push(seg);
    } else {
      return null;
    }
  }
  return p.length === rawSegments.length ? decoded : null;
}

/**
 * Đoạn của pathname như path-to-regexp (không strict) của Express thấy: bỏ `/` đầu và MỘT `/` cuối; đoạn rỗng ở giữa
 * (`//`) → `null` (Express không khớp route nào → 404, không phải route được audit).
 */
export function routerSegments(pathname: string): string[] | null {
  const parts = pathname.split("/").slice(1);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.some((p) => p === "") ? null : parts;
}

/**
 * Route audit của request — theo pathname router thấy (`rawRequestPath`, T-145): request-target tuyệt đối, `\`, `#` được
 * parse như Express; `null` khi pathname không hợp lệ (nơi khác trả 400) hoặc không route nào khớp.
 */
export function matchAuditRoute(
  rawMethod: string,
  req: { originalUrl?: unknown; url?: unknown },
): MatchedRoute | null {
  const method = normalizeMethod(rawMethod);
  const pathname = rawRequestPath(req);
  if (pathname === null) return null;
  // `//` và `/` cuối gộp như normalizeAdminPath; GIỮ hoa/thường (id Medusa có chữ hoa).
  const rawSegments = routerSegments(pathname);
  if (rawSegments === null) return null;
  for (const route of AUDIT_ROUTES) {
    if (route.method !== method) continue;
    const segments = matchRoutePattern(route.pattern, rawSegments);
    if (segments === null) continue;
    const s = route.segmentIn;
    if (s && !s.values.includes(segments[s.index] ?? "")) continue;
    if (route.skip === true) return null;
    return { route, segments, path: `/${segments.join("/")}`, method };
  }
  return matchNativeConfigRoute(method, req, rawSegments);
}

/**
 * Quyền mà mọi lần GHI vào route native mang quyền đó là "đổi cấu hình" (CMP-AUDIT-002). Suy từ bảng quyền RBAC
 * (`native-permissions.ts` + mặc định đóng: route ghi native chưa khai → `settings.manage`) thay vì liệt kê tay → route
 * native mới (nâng Medusa) thuộc `settings.manage` tự được audit. Test `security-events.unit.spec.ts` quét cây route
 * Medusa đang cài và đỏ nếu một route ghi `settings.manage` không ra sự kiện.
 */
export const CONFIG_PERMISSIONS: readonly Permission[] = ["settings.manage"];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Mẫu route Express đã khớp (`req.route.path`, chỉ có sau khi tới route) — vd `/admin/regions/:id`. */
const ROUTE_PATTERN = /^\/admin(\/[A-Za-z0-9_:-]{1,64}){1,8}$/;
function routePatternOf(req: MedusaRequest): string | null {
  const p = (req as MedusaRequest & { route?: { path?: unknown } }).route?.path;
  return typeof p === "string" && ROUTE_PATTERN.test(p) ? p : null;
}

const RESOURCE_SEGMENT = /^[a-z][a-z0-9-]{0,40}$/;
/** `tax-regions` → `tax_region`, `currencies` → `currency`; đoạn lạ (route không tồn tại — client chọn) → `unknown`. */
export function resourceTypeOf(segment: string | undefined): string {
  if (segment === undefined || !RESOURCE_SEGMENT.test(segment)) return "unknown";
  return segment
    .replace(/-/g, "_")
    .replace(/ies$/, "y")
    .replace(/([^s])s$/, "$1");
}

/** Id từ thân phản hồi: `{ id }` (xoá) hoặc `{ <thực thể>: { id } }` (tạo). */
function responseIdOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id === "string") return b.id;
  for (const v of Object.values(b)) {
    const id = (v as { id?: unknown } | null)?.id;
    if (typeof v === "object" && v !== null && !Array.isArray(v) && typeof id === "string") return id;
  }
  return null;
}

/**
 * Thao tác theo MẪU route (không theo đường dẫn cụ thể — id không vào `operation`): `POST /admin/regions` → `create`,
 * `POST /admin/regions/:id` → `update`, `DELETE …/:id` → `delete`, `POST /admin/workflows-executions/:id/steps/success`
 * → `steps.success`, `DELETE /admin/fulfillment-sets/:id/service-zones/:zone_id` → `delete.service_zones`. Chưa tới
 * route (không có mẫu) → `delete`/`unknown`.
 */
export function nativeOperationOf(method: string, pattern: string | null): string {
  if (pattern === null) return method === "DELETE" ? "delete" : "unknown";
  const segs = pattern.split("/").filter(Boolean);
  const rest = segs
    .slice(2)
    .filter((s) => !s.startsWith(":"))
    .map((s) => s.replace(/-/g, "_"));
  const lastIsParam = segs.length > 2 && (segs[segs.length - 1] ?? "").startsWith(":");
  // Tên thao tác (không phải SQL): ghép bằng join để check-sql-safety không nhận nhầm `update…`/`delete…` là câu lệnh.
  if (method === "DELETE") return ["delete", ...rest].join(".");
  if (segs.length === 2) return "create";
  if (lastIsParam) return ["update", ...rest].join(".");
  return rest.join(".");
}

/**
 * Đích: loại theo đoạn đầu của MẪU route Express (`/admin/<loại>/…`), id = tham số thứ nhất của mẫu, không có → id trong
 * thân phản hồi. Chưa tới route (không có `req.route` — vd 404 do gõ sai đường dẫn): đường dẫn là chuỗi client chọn →
 * KHÔNG lấy loại/id từ đó: `unknown` / NULL.
 */
export const nativeConfigTarget: TargetFn = (segments, req, body) => {
  const pattern = routePatternOf(req);
  if (pattern === null) return { type: "unknown", id: null };
  const parts = pattern.split("/");
  const pathId = (parts[3] ?? "").startsWith(":") ? (segments[2] ?? null) : null;
  return { type: resourceTypeOf(parts[2]), id: pathId ?? responseIdOf(body) };
};

/** Route audit suy ra cho MỌI lần ghi route native mang quyền cấu hình (không có trong `AUDIT_ROUTES`). */
export const NATIVE_CONFIG_ROUTE: AuditRoute = {
  method: "WRITE",
  pattern: "/admin/*",
  event: SECURITY_EVENTS.CONFIG_CHANGED,
  scope: "admin",
  target: nativeConfigTarget,
  bodyFields: true,
  extra: (req, _body, _status, m) => {
    const pattern = routePatternOf(req);
    return {
      operation: nativeOperationOf(m.method, pattern),
      route: `${m.method} ${pattern ?? "(chưa tới route)"}`,
      derived_from: "rbac_permission",
    };
  },
};

function matchNativeConfigRoute(
  method: string,
  req: { originalUrl?: unknown; url?: unknown },
  rawSegments: readonly string[],
): MatchedRoute | null {
  if (READ_METHODS.has(method)) return null;
  if (rawSegments[0]?.toLowerCase() !== "admin" || rawSegments.length < 2) return null;
  if (rawSegments[1]?.toLowerCase() === "x") return null;
  const resolved = adminRuleOf(req, method);
  if (resolved === null || resolved.rule.kind !== "permission") return null;
  const perms = [resolved.rule.permission, ...resolved.rule.also];
  if (!perms.some((p) => CONFIG_PERMISSIONS.includes(p))) return null;
  const segments = matchRoutePattern(`/${rawSegments.map(() => ":p").join("/")}`, rawSegments);
  if (segments === null) return null;
  return { route: NATIVE_CONFIG_ROUTE, segments, path: `/${segments.join("/")}`, method };
}

export function outcomeOfStatus(status: number): AuditOutcome {
  if (status < 400) return "success";
  if (status === 403 || status === 429) return "denied";
  return "failure";
}

interface AuthCtx {
  actor_id?: string;
  actor_type?: string;
  auth_identity_id?: string;
}
type AuthedRequest = MedusaRequest & { auth_context?: AuthCtx };

const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const safeId = (v: unknown): string | null => (typeof v === "string" && SAFE_TOKEN.test(v) ? v : null);

/** Payload JWT trong phản hồi của chính server (không kiểm chữ ký — không phải đầu vào client). Lỗi → null. */
export function tokenClaims(body: unknown): AuthCtx | null {
  const token = (body as { token?: unknown } | null)?.token;
  if (typeof token !== "string") return null;
  try {
    const part = token.split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      actor_id: typeof payload.actor_id === "string" ? payload.actor_id : undefined,
      actor_type: typeof payload.actor_type === "string" ? payload.actor_type : undefined,
      auth_identity_id: typeof payload.auth_identity_id === "string" ? payload.auth_identity_id : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Claims của token TRONG PHẢN HỒI dùng để xác định actor — chỉ ở `/auth` (token vừa cấp cho chính người gọi: đăng nhập,
 * MFA). Ở `/admin` luôn `null`: phòng thủ — phản hồi admin có thể mang token cấp cho NGƯỜI KHÁC (vd `POST
 * /admin/users/:id/reset-password` trả token đặt lại của user đích; JWT đó hiện mang `entity_id`, không `actor_id`, nên
 * hôm nay không gây sai — nhưng một route admin trả token có `actor_id` sẽ ghi sai người thực hiện). Actor ở `/admin` lấy
 * từ `auth_context`.
 */
export function responseClaimsOf(route: Pick<AuditRoute, "scope">, body: unknown): AuthCtx | null {
  return route.scope === "auth" ? tokenClaims(body) : null;
}

export interface ResolvedActor {
  actor_type: string;
  actor_id: string | null;
  /** actor_id dạng email đã được thay bằng bí danh. */
  pseudonymized: boolean;
}

/**
 * Ai thực hiện: actor trong token vừa cấp (đăng nhập/MFA thành công) → auth_context → auth identity (đã qua mật khẩu,
 * chưa gắn actor/chưa qua MFA) → vô danh. actor_id trông như email (token đặt lại mật khẩu) → bí danh, không lưu thô.
 */
export function resolveActor(
  claims: AuthCtx | null,
  ctx: AuthCtx | undefined,
  pseudonym: (v: string) => string | null,
): ResolvedActor {
  for (const c of [claims, ctx]) {
    const id = c?.actor_id;
    if (!isNonEmpty(id)) continue;
    const type = isNonEmpty(c?.actor_type) ? c.actor_type : "unknown";
    if (id.includes("@")) return { actor_type: type, actor_id: pseudonym(id), pseudonymized: true };
    return { actor_type: type, actor_id: safeId(id), pseudonymized: false };
  }
  const authIdentity = safeId(claims?.auth_identity_id) ?? safeId(ctx?.auth_identity_id);
  if (authIdentity !== null)
    return { actor_type: "auth_identity", actor_id: authIdentity, pseudonymized: false };
  return { actor_type: "anonymous", actor_id: null, pseudonymized: false };
}

const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Mã lỗi máy đọc (problem+json `code` hoặc `type` của Medusa) — không lấy `message`/`detail` (có thể chứa dữ liệu nhập). */
function errorCodeOf(body: unknown): string | null {
  const b = body as { code?: unknown; type?: unknown } | null;
  for (const v of [b?.code, b?.type]) if (typeof v === "string" && ERROR_CODE.test(v)) return v;
  return null;
}

function bodyString(req: MedusaRequest, key: string): string | null {
  const v = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof v === "string" ? v.slice(0, 320) : null;
}

/** Khoá nguồn cho nhóm gộp: `ipRateKey` (IPv6 gộp /64) — chỉ đi vào băm của bucket, không lưu. */
export function ipGroupOf(req: MedusaRequest): string | null {
  const ip = clientIpOf(req).ip;
  return isNonEmpty(ip) ? ipRateKey(ip) : null;
}

export const counterOf =
  (req: MedusaRequest): WindowCounter =>
  async (bucket, windowMs, now) =>
    (await req.scope.resolve<CheckoutModuleService>(CHECKOUT_MODULE).hitRateCounter(bucket, windowMs, now))
      .current;

async function recordFinished(
  req: MedusaRequest,
  res: MedusaResponse,
  body: unknown,
  m: MatchedRoute,
  aborted: boolean,
  /** Status lúc handler gọi `res.end` (ca ngắt sớm); `null` = hết hạn chờ mà handler chưa phản hồi. */
  endedStatus: number | null = res.statusCode,
) {
  const { route } = m;
  const status = aborted ? endedStatus : res.statusCode;
  const outcome: AuditOutcome = status === null ? "failure" : outcomeOfStatus(status);
  if (route.scope === "admin" && (status === 401 || status === 403) && route.recordAuthFailures !== true)
    return;

  const ctx = (req as AuthedRequest).auth_context;
  const claims = responseClaimsOf(route, body);
  const pseudonym = (v: string) => hashIdentifier(req.scope, v);
  const actor = resolveActor(claims, ctx, pseudonym);

  let target: { type: string; id: string | null };
  if (route.identity !== undefined) {
    const raw =
      route.identity === "body_email"
        ? bodyString(req, "email")
        : route.identity === "body_identifier"
          ? bodyString(req, "identifier")
          : (ctx?.actor_id ?? null);
    target = { type: "login_identifier", id: pseudonym(raw ?? "") };
  } else {
    target = (route.target ?? fixed("route", null))(m.segments, req, body);
    target = { type: target.type, id: safeId(target.id) };
  }
  const lockout = route.rateLimited === true && status === 429;
  const event = lockout ? SECURITY_EVENTS.LOCKOUT : route.event;
  const changes: Record<string, unknown> = {
    route: `${m.method} ${route.pattern}`,
    status,
    ...route.details,
  };
  if (aborted) changes.aborted = true;
  // Tên trường chỉ khi THÀNH CÔNG: schema strict của route native đã nhận thân → mọi khoá là khoá đã biết của route; thân
  // bị từ chối có thể mang khoá do client tự đặt (vd tên người) → không chép.
  if (route.bodyFields === true && status !== null && status < 400) {
    const fields = bodyFieldNames(req.body);
    if (fields !== null) changes.fields = fields;
  }
  if (route.extra !== undefined) {
    try {
      Object.assign(changes, route.extra(req, body, status, m));
    } catch {
      // chi tiết thêm là phụ — không bỏ dòng audit vì nó
    }
  }
  if (route.bodyFormat !== undefined) {
    const f = bodyString(req, "format");
    changes.format = f !== null && route.bodyFormat.values.includes(f) ? f : route.bodyFormat.fallback;
  }
  if (route.scope === "auth" && route.pattern.startsWith("/auth/:actor_type/:provider")) {
    changes.actor_type = known(m.segments[1], KNOWN_ACTOR_TYPES);
    changes.provider = known(m.segments[2], KNOWN_PROVIDERS);
  }
  if (lockout) {
    changes.event = route.event;
    const retryAfter = Number(res.getHeader("retry-after") ?? NaN);
    if (Number.isSafeInteger(retryAfter)) changes.retry_after = retryAfter;
  }
  const authIdentity = safeId(claims?.auth_identity_id) ?? safeId(ctx?.auth_identity_id);
  if (route.scope === "auth" && authIdentity !== null) changes.auth_identity_id = authIdentity;
  if (actor.pseudonymized) changes.actor_pseudonymized = true;
  if (route.event === SECURITY_EVENTS.LOGIN && outcome === "success") {
    changes.stage =
      (body as { mfa_required?: unknown } | null)?.mfa_required === true ? "mfa_required" : "complete";
  }
  const code = outcome === "success" ? null : errorCodeOf(body);
  if (code !== null) changes.error_code = code;

  // Gộp theo nguồn (IP băm) + sự kiện + kết quả, không theo định danh do client chọn — xem chú thích đầu file.
  const anonymousFailure = outcome !== "success" && actor.actor_id === null;
  if (lockout || route.throttleAll === true || anonymousFailure) {
    const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
    const decision = await decideDenyAudit(
      counterOf(req),
      {
        actorType: "ip",
        actorId: ipGroupOf(req),
        method: m.method,
        routeClass: `audit:${event}`,
        reason: lockout ? "rate_limited" : outcome,
      },
      new Date(),
      () => logger.warn(`[audit] Bộ đếm gộp audit lỗi, vẫn ghi: ${event}`),
    );
    if (!decision.record) return;
    changes.throttle = { occurrence: decision.occurrence, window_seconds: decision.window_seconds };
  }

  await recordAudit(
    req.scope,
    {
      actor_type: actor.actor_type,
      actor_id: actor.actor_id,
      action: event,
      resource_type: target.type,
      resource_id: target.id,
      outcome,
      changes,
    },
    req,
  );
}

/** Chờ handler phản hồi sau khi client ngắt — đủ cho route xuất (native trả 202 ngay; CSV catalog dựng đồng bộ). */
export const ABORT_WAIT_MS = secondsToMs(15);

const MAX_PARSED_BODY_BYTES = kibToBytes(64);
export function parseJsonBody(b: unknown): unknown {
  const text = Buffer.isBuffer(b) ? null : typeof b === "string" ? b : null;
  if (
    text === null ||
    Buffer.byteLength(text, "utf8") > MAX_PARSED_BODY_BYTES ||
    !text.trimStart().startsWith("{")
  )
    return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Middleware toàn cục cho `/auth` và `/admin` — xem chú thích đầu file. Không bao giờ ném, không chặn request. */
export function securityAuditTrail(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction): void {
  let matched: MatchedRoute | null = null;
  try {
    matched = matchAuditRoute(req.method, req);
  } catch {
    matched = null;
  }
  if (matched === null) return next();
  const m = matched;
  // Giữ thân phản hồi (đối tượng) để đọc token/mã lỗi: `res.json` (route native) và `res.send(chuỗi JSON)` (problem+json
  // của dự án). `res.json` của Express gọi lại `res.send` — đã có thân thì bỏ qua.
  let body: unknown = null;
  const w = res as unknown as { json: (b: unknown) => MedusaResponse; send: (b: unknown) => MedusaResponse };
  const originalJson = w.json.bind(res);
  const originalSend = w.send.bind(res);
  w.json = (b: unknown) => {
    body = b;
    return originalJson(b);
  };
  w.send = (b: unknown) => {
    if (body === null) body = parseJsonBody(b);
    return originalSend(b);
  };
  // Status lúc handler gọi `res.end` — kể cả khi socket đã đóng (Express vẫn gọi end, chỉ không gửi được).
  let endedStatus: number | null = null;
  let onEnded: (() => void) | null = null;
  const originalEnd = res.end.bind(res) as (...a: unknown[]) => MedusaResponse;
  (res as unknown as { end: (...a: unknown[]) => MedusaResponse }).end = (...args: unknown[]) => {
    if (endedStatus === null) {
      endedStatus = res.statusCode;
      onEnded?.();
    }
    return originalEnd(...args);
  };
  let recorded = false;
  const fire = (aborted: boolean, status?: number | null) => {
    if (recorded) return;
    recorded = true;
    recordFinished(req, res, body, m, aborted, status).catch((e: unknown) => {
      try {
        req.scope
          .resolve(ContainerRegistrationKeys.LOGGER)
          .error(`[audit] Không ghi được audit ${m.route.event}: ${(e as Error).message}`);
      } catch {
        // không có logger — bỏ qua, không làm hỏng tiến trình
      }
    });
  };
  res.once("finish", () => fire(false));
  // Kết nối đóng trước khi phản hồi xong (client ngắt, timeout proxy): handler vẫn chạy tiếp → chờ nó gọi `res.end`
  // (tối đa ABORT_WAIT_MS) để ghi kết quả thật, đánh dấu aborted.
  res.once("close", () => {
    if (res.writableFinished) return;
    if (endedStatus !== null) return fire(true, endedStatus);
    const timer = setTimeout(() => fire(true, null), ABORT_WAIT_MS);
    timer.unref();
    onEnded = () => {
      clearTimeout(timer);
      fire(true, endedStatus);
    };
  });
  return next();
}
