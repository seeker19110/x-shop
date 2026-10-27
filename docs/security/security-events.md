# Sự kiện bảo mật và audit trail

> T-091 · Đóng/hỗ trợ: SEC-LOG-001, SEC-LOG-002, CMP-AUDIT-002, SEC-LOG-007 (append-only). Cập nhật: 2026-10-26.
> Nguồn tên sự kiện trong mã: `apps/backend/src/lib/audit/events.ts` (`SECURITY_EVENTS`). Test
> `apps/backend/src/lib/audit/__tests__/security-events.unit.spec.ts` đối chiếu bảng dưới với mã: thêm sự kiện mà quên
> tài liệu (hoặc tài liệu nêu `auth.*`/`data.*`/`rbac.*` mà mã không có) → đỏ.

## 1. Nơi ghi

| Lớp                    | Ở đâu                                                                                       | Ghi chú                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Bảng `audit_log` (DB)  | module `xAudit` — `apps/backend/src/modules/audit/`                                         | **Nguồn chính.** Chỉ ghi thêm: trigger `x_append_only_guard` chặn UPDATE/DELETE; không có route sửa/xoá (`/admin/x/audit` chỉ GET).            |
| Dòng log `security.audit` | stdout JSON của logger dự án (`apps/backend/src/lib/log/`), phát bởi `recordAudit`        | Chỉ trường định danh/kết quả (không `changes`/`reason`/User-Agent) — để Collector đưa về kho tập trung (SEC-LOG-006, chưa có hạ tầng).        |
| Ghi theo route         | `securityAuditTrail` — `apps/backend/src/lib/audit/http.ts`, đăng ký ở `src/api/middlewares.ts` cho `/auth` và `/admin` | Ghi **sau khi phản hồi xong** (`finish`): không thêm độ trễ, không đổi thời gian phản hồi đăng nhập (BE-AUTH-003); thất bại/405/429 cũng ghi; kết nối đóng trước khi xong (`close`, chưa `writableFinished`): handler vẫn chạy tiếp (workflow xuất vẫn tạo file) → chờ handler gọi `res.end` tối đa `ABORT_WAIT_MS` (15 s) rồi ghi kết quả theo status thật kèm `changes.aborted`; hết hạn chưa phản hồi → `failure`, `status: null`. Khớp route **như router Express thấy** (§3.0). |
| Ghi trong mã nghiệp vụ | `recordAudit()` — `apps/backend/src/lib/audit/record.ts`                                    | Cổng RBAC (`lib/admin-security/guard.ts`), route vai trò, workflow đổi trả/hoàn tiền, đối soát, nhập catalog, điều chỉnh tồn.                    |

## 2. Trường của một sự kiện (SEC-LOG-002, CMP-AUDIT-002)

JSON Schema: [`security-event.schema.json`](security-event.schema.json) — sinh từ `apps/backend/src/lib/audit/schema.ts`
(`SecurityAuditRecord`); test tích hợp `integration-tests/http/audit-security-events.spec.ts` kiểm mọi dòng sinh ra khớp
schema. Sinh lại sau khi sửa schema: `UPDATE_SECURITY_SCHEMA=1 pnpm --filter @x-shop/backend test -- security-events`.

| Trường yêu cầu (SEC-LOG-002 / CMP-AUDIT-002) | Cột `audit_log`                 | Quy tắc                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp` / when (UTC)                     | `created_at`                    | `timestamptz` = `clock_timestamp()` sinh **tại DB** lúc ghi; API trả ISO-8601 `…Z`.                                                                                                |
| `event` / what                               | `action`                        | Tên trong bảng §3 (dạng `nhóm.việc`).                                                                                                                                              |
| `actor` / who                                | `actor_type`, `actor_id`        | Id hệ thống (`user_…`, `cus_…`, `authid_…`, `script:…`), không tên/email. Đăng nhập thất bại: `anonymous`/NULL. `actor_id` dạng email (token đặt lại mật khẩu của Medusa) → bí danh `idh_…`. |
| `target` (loại + id)                         | `resource_type`, `resource_id`  | Đăng nhập/đặt lại mật khẩu: `login_identifier` + bí danh `idh_<HMAC-SHA256(email chữ thường), khoá server>` — gom mọi lần thử vào một tài khoản mà không lưu email.                    |
| `outcome` / result                           | `outcome`                       | `success` · `failure` · `denied` (CHECK ở DB). Theo status: < 400 success, 403/429 denied, còn lại failure (lỗi hệ thống = `failure` + `changes.status` ≥ 500 — tương ứng `error` của SEC-LOG-002). NULL chỉ ở dòng ghi trước T-091. |
| `source_ip` / where                          | `ip_hash`                       | HMAC-SHA256 (khoá `COOKIE_SECRET`) của IP client (sau proxy tin cậy) — **không lưu IP thô** (tối thiểu hoá dữ liệu; vẫn so trùng được). Độ lệch có chủ ý so với chữ "source_ip".      |
| `user_agent` / where                         | `user_agent`                    | ≤ 256 ký tự (CHECK ở DB), bỏ ký tự điều khiển/bidi/xuống dòng, che email/SĐT lẫn trong chuỗi (`sanitizeUserAgent`).                                                                 |
| `trace_id` / `request_id`                    | `request_id`                    | = `trace_id` của request (cùng mã trong log JSON và problem+json — `lib/errors/trace.ts`).                                                                                         |
| reason                                       | `reason`                        | Lý do nhân viên nhập; che email/SĐT/địa chỉ (`maskFreeText`), ≤ 1000 ký tự.                                                                                                        |
| chi tiết                                     | `changes` (jsonb)               | Đã che PII theo tên khoá + giá trị (`sanitizeChanges`). Sự kiện theo route có `route`, `status`, `error_code`, `stage`, `auth_identity_id`, `throttle`, `aborted`, `dataset`, `pii`; đăng nhập/mật khẩu có `actor_type` (`user`/`customer`/`other`) và `provider` (`emailpass`/`other`) — không chép chuỗi lạ do client chọn.            |

Không bao giờ ghi: mật khẩu, mã TOTP/recovery code, token/JWT, cookie, email/SĐT thô, IP thô.

## 3. Danh mục sự kiện

### 3.0 Khớp route

`matchAuditRoute` (`lib/audit/http.ts`) dùng pathname router thấy (`rawRequestPath`, `lib/http/request-path.ts`, T-145 —
request-target tuyệt đối, `\`, `#` parse như `parseurl` của Express), rồi khớp như path-to-regexp: đoạn tĩnh so với
pathname **chưa giải mã**, không phân biệt hoa thường; đoạn tham số **giải mã** `%xx`. Hệ quả: `POST /auth/%75ser/emailpass`
là đăng nhập (`actor_type: user`), `GET /admin/customers/cus%5F1` ghi `resource_id = cus_1`; mã hoá hỏng không khớp
(Express trả 400). Production: `medusa start` chặn request-target tuyệt đối/`#`/`\`/byte điều khiển ở tầng server (400,
có log truy cập `http.server.request`, không tới Express nên không có audit — T-145); server không có hook đó (test tích
hợp) vẫn audit đúng route.

### 3.1 Xác thực (ghi theo route — `securityAuditTrail`)

| Sự kiện                          | Khi nào (route native Medusa 2.22.1)                         | Actor                                                    | Đích                                 | Kết quả                                                               |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `auth.login`                     | `POST /auth/:actor_type/:provider` (mọi actor — identity emailpass dùng chung, T-138); `GET`/`HEAD /auth/:actor_type/emailpass` (405, T-138) | thành công: actor trong token (chưa qua MFA: `auth_identity`); thất bại: `anonymous` | `login_identifier` (bí danh email)   | success (`changes.stage` = `complete`/`mfa_required`) · failure (sai mật khẩu 401, GET 405) |
| `auth.lockout`                   | 429 ở đăng nhập hoặc xác minh MFA (rate limit theo định danh+IP/định danh/IP — `lib/admin-security/rate-limit.ts`) | như trên                                                 | như route gốc                        | denied; `changes.event` = sự kiện gốc, `retry_after`; gộp tần suất (§4) |
| `auth.mfa.verified`              | `POST /auth/mfa/challenges/:id/verify`                       | user (thành công) / `auth_identity` (thất bại)           | `mfa_challenge`                      | success · failure (mã sai) · lockout                                  |
| `auth.mfa.enroll_started`        | `POST /auth/mfa/factors`                                     | user                                                     | `auth_identity`                      | success · failure                                                     |
| `auth.mfa.enrolled`              | `POST /auth/mfa/factors/:id/verify`                          | user                                                     | `mfa_factor`                         | success · failure · lockout                                           |
| `auth.mfa.factor_removed`        | `DELETE /auth/mfa/factors/:id`                               | user                                                     | `mfa_factor`                         | success · failure                                                     |
| `auth.mfa.recovery_codes_issued` | `POST /auth/mfa/recovery-codes`                              | user                                                     | `auth_identity`                      | success · failure                                                     |
| `auth.session_created`           | `POST /auth/session` (đổi token lấy cookie phiên)            | user                                                     | `auth_identity`                      | success · failure                                                     |
| `auth.logout`                    | `DELETE /auth/session`                                       | user                                                     | `auth_identity`                      | success                                                               |
| `auth.token_refreshed`           | `POST /auth/token/refresh`                                   | user                                                     | `auth_identity`                      | success · failure (phiên quá hạn)                                     |
| `auth.password_reset_requested`  | `POST /auth/:actor_type/:provider/reset-password`            | `anonymous`                                              | `login_identifier`                   | success (luôn 201 — không lộ tài khoản tồn tại); gộp tần suất (§4)    |
| `auth.password_changed`          | `POST /auth/:actor_type/:provider/update` (token đặt lại)    | bí danh `idh_…` (`changes.actor_pseudonymized`)         | `login_identifier`                   | success · failure                                                     |

"Khoá tài khoản": hệ thống không khoá tài khoản vĩnh viễn; khoá **tạm thời** = rate limit đăng nhập/MFA (cửa sổ 15 phút,
`AUTH_RATE_LIMITS`) → `auth.lockout`. Thu hồi quyền/vô hiệu hoá nhân viên = `rbac.role_revoked`.

### 3.2 Phân quyền

| Sự kiện             | Khi nào                                                                        | Nơi ghi                                         | Kết quả                                                    |
| ------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------- |
| `rbac.denied`       | 403 ở cổng RBAC `/admin/*` (thiếu quyền, route không khai báo, actor không phải user) | `lib/admin-security/guard.ts` (`auditDenied`)  | denied; gộp tần suất theo (actor, lớp route, lý do)         |
| `rbac.role_granted` | `POST /admin/x/users/:id/roles` (cấp vai trò); script `rbac:grant-owner`       | `api/admin/x/users/[id]/roles/route.ts`, `scripts/grant-owner.ts` | success (có trước/sau) · failure (`NOT_FOUND`)              |
| `rbac.role_revoked` | `DELETE /admin/x/users/:id/roles`                                              | `api/admin/x/users/[id]/roles/route.ts`         | success · failure (`LAST_OWNER` — không thu hồi owner cuối) |

### 3.3 Xuất và truy cập dữ liệu nhạy cảm (ghi theo route — `securityAuditTrail`)

| Sự kiện         | Route                                                                                                    | Đích                                    | `changes`                                |
| --------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------- |
| `data.exported` | `GET /admin/x/exports/products.csv`                                                                      | `export` / `products.csv`               | `dataset: products`, `format: csv`, `pii: false` |
| `data.exported` | `POST /admin/orders/export` (native, PII khách; workflow 2.22.1 xuất CSV)                                 | `export` / `orders`                     | `format: csv`, `pii: true`               |
| `data.exported` | `POST /admin/customers/export` (native, PII khách)                                                        | `export` / `customers`                  | `format` = `format` của thân (`csv`/`json`), không có → `json` (mặc định của workflow); `pii: true` |
| `data.exported` | `POST /admin/products/export`, `POST /admin/inventory-items/export` (native, CSV)                        | `export` / `products` · `inventory_items` | `format: csv`, `pii: false`            |
| `data.accessed` | `GET /admin/x/settlements/batches/:id` (chi tiết đối soát từng dòng)                                      | `settlement_batch` / id                 | `dataset: settlement`                    |
| `data.accessed` | `GET /admin/customers[/*]`, `GET /admin/orders[/*]` (native — tên, email, SĐT, địa chỉ khách)             | `customer` · `order` / id (danh sách: NULL) | `pii: true`                          |
| `data.accessed` | `GET /admin/{customer-groups,draft-orders,returns,claims,exchanges}[/*]` (native, RBAC `order.read`; `order-changes`, `order-edits`, `fulfillments` không có GET trong Medusa 2.22.1) | loại tương ứng (`draft_order`, `return`…) / id | `pii: true`                |

Kết quả: success · failure (4xx khác 401/403, 5xx). 401/403 ở `/admin` không ghi ở đây — 403 đã có `rbac.denied`. Đường dẫn có `//` ở giữa: Express không khớp route nào (404) → không ghi.

### 3.4 Hành động admin nghiệp vụ (đã có trước T-091, cùng bảng)

`refund.requested|approved|rejected|cancelled|succeeded|failed|unknown`, `return.requested|approved|rejected|received|inspected`,
`order.cancelled`, `inventory.adjusted`, `settlement.batch.imported`, `settlement.discrepancy.resolved`,
`catalog.import.previewed|committed|commit_rejected|commit_failed`. Kết quả mặc định theo tên (`defaultOutcomeOf`:
`refund.failed`, `catalog.import.commit_*` lỗi → failure; còn lại success).

## 4. Chống ngập

Gộp trong cửa sổ 60 giây, chỉ ghi lần 1, 10, 100, 1000… của nhóm (`lib/audit/deny-throttle.ts`, bộ đếm Postgres
`rate_limit_counter` chung mọi instance); `changes.throttle.occurrence` giữ độ lớn đợt; bộ đếm lỗi → vẫn ghi.

| Sự kiện                                                                 | Nhóm gộp                                    |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| Mọi thất bại **vô danh** ghi theo route (đăng nhập sai, thân rỗng, MFA vô danh…) | (nguồn IP, sự kiện, kết quả)         |
| `auth.lockout` (429)                                                    | (nguồn IP, `auth.lockout`, `rate_limited`) |
| `auth.password_reset_requested` (vô danh, không rate limit)             | (nguồn IP, sự kiện, kết quả)                |
| `rbac.denied`                                                           | (actor, lớp route, lý do) — actor đã xác thực |

"Nguồn IP" = `ipRateKey` (`lib/security/client-ip.ts`, cùng khoá với rate limit): IPv4 nguyên địa chỉ, IPv6 gộp cả /64 —
xoay địa chỉ trong một /64 không lách được gộp; cột `ip_hash` của dòng vẫn là băm địa chỉ đầy đủ. Nhóm **không** chứa
định danh trong thân (email do client chọn): đổi email mỗi lần không lách được gộp (test
`audit-security-events.spec.ts`). Đích của dòng được ghi vẫn là bí danh email của lần đó. Thất bại có actor (đã xác thực,
`auth_identity` sau bước mật khẩu) không gộp. Đánh đổi: cùng IP (NAT) nhiều tài khoản sai trong 60 s → chỉ lần 1, 10, 100…
có dòng riêng; tổng số lần vẫn đọc được từ `occurrence`, chi tiết từng lần nằm ở log truy cập.

## 5. Thời hạn lưu

| Dữ liệu                | Thời hạn                                                                                                                         | Thi hành                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `audit_log`            | lớp `audit-1y` ở `docs/privacy/data-map.yaml`: **tối thiểu 12 tháng** (CMP-AUDIT-002 dẫn NĐ 333/2026/NĐ-CP Đ.22–23 — chưa xác minh tại nguồn sống); trần do chủ dự án/pháp chế chốt trước G7 | Chưa có job xoá. Bảng append-only → xoá theo hạn chỉ qua thủ tục có kiểm soát (migration/job riêng có ghi nhận), không qua ứng dụng. |
| Log `security.audit`   | theo kho log tập trung (chưa chọn hạ tầng — SEC-LOG-006/OPS-OBS-001); đề xuất bằng `audit_log`                                    | Chưa có.                                                                                       |
| Chứng từ tiền (ledger, đối soát) | không thuộc bảng này — theo luật kế toán (≥ 10 năm, chưa xác minh) ở data-map                                            | —                                                                                              |

## 6. Ai được đọc

- Qua ứng dụng: `GET /admin/x/audit` (lọc `action`, `outcome`, `actor_id`, `resource_type`, `resource_id`), quyền
  `audit.read` — hiện chỉ vai trò **owner** (`ROLE_GRANTS` ở `packages/domain/src/access/rbac.ts`), qua cổng RBAC + phiên.
  Vai trò khác → 403 và chính lần đó ghi `rbac.denied`.
- Trực tiếp DB/log: người vận hành khi điều tra sự cố (`docs/ops/INCIDENT-RESPONSE.md` — bảo toàn chứng cứ, không sửa/xoá).
- Không ai sửa/xoá qua ứng dụng; trigger DB chặn cả mã lỗi/route tương lai.

## 7. Chưa phủ (theo SEC-LOG-001/CMP-AUDIT-002)

| Sự kiện yêu cầu                                       | Tình trạng                                                                                           |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Từ chối MFA/xác thực lại (403 `MFA_REQUIRED`/`REAUTH_REQUIRED`) | Cổng RBAC chưa ghi audit cho hai mã này (chỉ ghi `rbac.denied` khi thiếu quyền).            |
| Upload, đổi cấu hình (native `/admin/stores`, khoá API, lời mời, xoá user native) | Chưa ghi audit theo route.                                                  |
| Lỗi validate đầu vào, lỗi deserialize, lỗi TLS backend | Chỉ có trong log ứng dụng/log truy cập (không phải audit).                                          |
| DSAR, triển khai                                      | Chưa có chức năng DSAR; triển khai chưa có pipeline production.                                     |
| Đăng ký auth identity (`/auth/*/register`)            | Không ghi audit (T-138: cổng lời mời + rate limit, mọi ca từ chối cùng phản hồi 400).              |
| Route PII native khác ngoài §3.3 (vd `/admin/payments`, `/admin/payment-collections`) | Chưa ghi `data.accessed` (dữ liệu thanh toán, không phải liên hệ khách). |
