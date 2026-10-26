# Audit BLUEPRINT.md — lô 2 (dòng 282–498, 97 mục MUST) · 2026-10-26

Phạm vi: mục `- [ ]` nằm trong dòng 282–498 của `BLUEPRINT.md` (nhóm UX-RESP/STATE, FE-*, BE-*, DB-*). Cách làm như lô 1: đọc code, CI,
`xt.yaml`, hook, docs thật; chạy từng lệnh `— Kiểm:` (exit 0) trước khi tick; không sửa mã/test/CI/xt.yaml, không sửa dòng ngoài dải.

## Tổng hợp

| Kết quả | Số mục | Ghi chú |
|---|---|---|
| Đạt `[x]` kèm `— Kiểm:` chạy lại được | 24 | `blueprint-status --run`: 77/77 lệnh (53 lô 1 + 24 lô 2) exit 0, rc 0 |
| Không áp dụng `[~]` | 11 | FE-PERF-009, BE-CACHE-005, BE-INT-010, BE-RT-001..004, DB-SEARCH-002/003/004, DB-TX-002 |
| Còn mở `[ ]` (ghi `— Thiếu:`) | 62 | danh sách + task đề xuất bên dưới |

Lệnh Kiểm nhanh (mỗi lệnh ≤ 5 s): vitest lọc theo tên (CheckoutForm, security, private-cache, CartContents), jest unit (security), grep
tên test tích hợp còn tồn tại. Các test tích hợp (checkout-submit, payment-ipn, order-lookup, security, notify, checkout-module) chỉ
grep tên vì không chạy được trong 30 s; chúng nằm trong job CI `gate` (lô 1 đã chạy cục bộ xanh 2026-10-26).

**Tick còn hạn chế (đo được nhưng phạm vi hẹp, phiên chính cân nhắc):**
- UX-STATE-006 / FE-FORM-007: đo bằng test component (vitest, nhấp đúp = 1 lần gửi) + test tích hợp server (cùng khoá ×10 = 1 đơn), chưa có E2E Playwright đếm request.
- FE-FORM-010: kiểm CSRF bằng test đơn vị của `proxy`/`checkCsrf` (cross-site POST bị chặn), không phải E2E.
- FE-RENDER-003: không có `'use cache'` nào; cache dùng chung duy nhất là `fetch` `next.revalidate` ở `lib/catalog` (không đọc cookie/header).
- FE-RENDER-005 / BE-AUTH-010: không có tài khoản khách; "route bảo vệ" = trang đơn + giỏ, đo qua test AT20 (token đơn thiếu/giả/của đơn khác = 404 giống nhau) và `assertCartAccess`.
- BE-FILE-005: chỉ có upload Admin (có xác thực/phân quyền, presigned bị tắt); không có tệp riêng tư của người dùng để tải xuống (ảnh sản phẩm là công khai).
- BE-FILE-001: kiểm bằng magic bytes + đuôi khớp loại, chỉ ảnh JPEG/PNG/WebP/AVIF (SVG/HTML/PDF → 415).
- BE-JOB-001, DB-TX-001, DB-TX-004: khoá duy nhất ở DB + test đồng thời tồn tại; chưa có "mutation bỏ khoá thì test đỏ" ghi trong PR.
- BE-REL-006: bộ đếm giới hạn tần suất nằm trong Postgres (bảng `rate_limit_counter`) nên dùng chung nhiều instance; chưa có test hai tiến trình thật.
- DB-BACKUP-003: diễn tập khôi phục cục bộ (RTO 14–16 s, DB ~78 KB), không phải hạ tầng production; bằng chứng ở `docs/ops/RUNBOOK.md` §4.4.
- BE-CACHE-002: chỉ có Redis do `admin-security/store.ts` ghi trực tiếp (luôn có TTL); khoá phân tán do Medusa Locking quản lý.

## Mục MUST còn mở → task đề xuất (mỗi task có Gate máy kiểm)

Việc nhỏ, làm ngay được (ưu tiên):
1. **T-q: Cấu hình CI cho E2E** — UX-RESP-008, FE-TEST-002 (và UX-RESP-001/005 một phần). `xt.yaml` đặt `e2e: "pnpm e2e"` (+ `e2e_setup` cài chromium) —
   hiện khoá rỗng nên job `e2e` trong CI bỏ qua (xem "Ngoài phạm vi"); `playwright.config.ts` thêm project `desktop` + `mobile` (`devices["Pixel 7"]`),
   `e2e/a11y-reflow.spec.ts` phủ mọi route sitemap; bọc `:hover` trong `@media (hover: hover)`. Gate: `pnpm e2e` + `grep -q mobile playwright.config.ts`.
2. **T-r: Tài liệu vận hành DB** — DB-BACKUP-001, DB-PERF-004, DB-MIG-011, BE-JOB-004 (một phần). Tạo `docs/ops/RPO-RTO.md` (bảng kho → RPO → RTO → cơ chế → diễn tập,
   lấy từ RUNBOOK §4), `docs/db/connections.md` (pool × tiến trình ≤ max_connections), thêm mục "Backup trước migrate" vào PR template và bước kiểm backup vào RUNBOOK,
   quy trình redrive outbox `failed`. Gate: `test -f docs/ops/RPO-RTO.md docs/db/connections.md` + `grep -q "Backup trước migrate" .github/pull_request_template.md` + `pnpm format:check`.
3. **T-s: Tài liệu frontend** — FE-RENDER-001 (`docs/ROUTES.md` + script so với `app/`), FE-STATE-008 (`docs/CLIENT-STORAGE.md` + test khoá localStorage), FE-PERF-004
   (`docs/PERF-BUDGET.md`, nối `perf:budget` vào CI). Gate: script `scripts/check-routes.mjs` exit 0 + vitest mới + `pnpm format:check`.
4. **T-t: Lint/hạ tầng test frontend** — FE-SEC-001 (rule `no-danger` + `eslint-disable` có lý do ở 3 chỗ JSON-LD), FE-SEC-002 (`safeUrl()` + test), FE-TEST-001
   (`eslint-plugin-testing-library`), FE-TEST-003 (`TZ=UTC` trong `apps/storefront/scripts/test.mjs`), FE-BUILD-003 (ghi lý do `skipLibCheck`), FE-BUILD-005 (đưa
   `NEXT_PUBLIC_ANALYTICS_TRANSPORT` vào schema, `proxy.ts` đọc qua `getClientEnv`). Gate: `pnpm lint && pnpm --filter storefront test`.
5. **T-u: DB timeout/vai trò** — BE-REL-001 (DB), DB-PERF-004/005, DB-SEC-002. Pool/`statement_timeout`/`idle_in_transaction_session_timeout` cho vai trò `app`
   (cấu hình trong `medusa-config.ts` + migration `ALTER ROLE`), `MIGRATION_DATABASE_URL`. Gate: jest unit mới + `pnpm test:integration` (chạm DB: cần quyết vai trò, xem câu hỏi mở).
6. **T-v: Hợp đồng API** — BE-API-001 (OpenAPI 3.1 cho `/store/x/*`, `/x/webhooks/*`; gộp T-k lô 1), BE-API-003 (test quét mọi route với body xấu → 4xx không 500),
   BE-API-009 / BE-AUTH-009 (test liệt kê route công khai `/store/x`, `/x` so allowlist), BE-API-008 (khớp hợp đồng mã 400/422/409 hoặc ghi ngoại lệ). Gate: `grep -E "^openapi: 3\.1" openapi.yaml` + test mới.
7. **T-w: Tải tệp** — BE-FILE-003 (tên lưu server sinh ULID + đuôi chuẩn hoá, bọc file provider), BE-FILE-004 (production: bucket private + CDN, chờ chọn hạ tầng).
   Gate: jest unit tên `../../etc/passwd` → khoá không chứa `..`.
8. **T-x: Độ bền/job** — BE-JOB-003 (jitter + lỗi vĩnh viễn vào DLQ ngay + unit test `outboxBackoffMs`), BE-JOB-007 (schema payload + test), BE-REL-003 (đọc `Retry-After` của GHN),
   BE-REL-004 (test SIGTERM tắt êm), BE-INT-007 (429 `Retry-After`). Gate: jest unit mới.
9. **T-y: Xoay secret / xác thực** — BE-INT-002 (nhận `VNPAY_HASH_SECRET` + `VNPAY_HASH_SECRET_PREVIOUS`), BE-AUTH-001 (xem câu hỏi mở), BE-AUTH-003 (test thời gian phản hồi),
   BE-AUTH-004 (`__Host-` cho cookie phiên admin nếu Medusa cho cấu hình). Gate: jest unit/integration mới.
10. **T-z: CI migration/schema** — DB-MIG-001 (script drift), DB-MIG-003 (so SHA migration với `master`), DB-MIG-008 (squawk), DB-MODEL-004 (truy vấn catalog FK thiếu index),
    DB-MODEL-005, DB-MODEL-002 (đổi cột tiền `integer` → `bigint` bằng migration mới; không sửa migration cũ). Chạm CI: PR riêng, nêu lý do.
11. **T-aa: Chờ hạ tầng/chủ dự án** — DB-BACKUP-002/004, DB-SEC-003/004, DB-PERF-008, FE-PERF-001 (RUM), BE-FILE-004, DB-SEC-007 (xem câu hỏi mở).
12. **Khác** — UX-STATE-001 (Storybook hoặc đổi cách kiểm), UX-STATE-005 (`app/error.tsx` + `global-error.tsx` + E2E 500), UX-STATE-008 (dialog nêu mã đơn + test Esc),
    FE-FORM-001 (xem câu hỏi mở), FE-STATE-001/005, FE-TEST-006, FE-PERF-002 (Lighthouse trong CI), BE-CACHE-007, DB-PERF-001 (`docs/db/explain/*`), DB-SEARCH-001 (đo + ghi thời gian rebuild), DB-TX-003.

Toàn bộ 62 mục mở (đều MUST): UX-RESP-001/005/008 · UX-STATE-001/005/008 · FE-BUILD-003/004/005 · FE-SEC-001/002 · FE-FORM-001 · FE-TEST-001/002/003/006 ·
FE-PERF-001/002/004 · FE-RENDER-001 · FE-STATE-001/005/008 · BE-API-001/003/008/009 · BE-AUTH-001/003/004/009 · BE-JOB-003/004/007 · BE-CACHE-007 ·
BE-FILE-003/004 · BE-INT-002/007 · BE-REL-001/003/004 · DB-BACKUP-001/002/004 · DB-MODEL-002/004/005 · DB-PERF-001/004/005/008 · DB-MIG-001/003/008/011 ·
DB-SEARCH-001 · DB-SEC-002/003/004/007 · DB-TX-003.

## Câu hỏi mở (cần phiên chính quyết, `xt.py loop decide`)
- **BE-AUTH-001**: Medusa `auth-emailpass` 2.22.1 băm bằng `scrypt-kdf` (logN 15, r 8, p 1), không Argon2id/PHC. (A) giữ scrypt, nâng `hashConfig` (vd logN 16, r 8, p 2 theo OWASP) cho provider
  trong `medusa-config.ts` + test tham số, ghi ADR ngoại lệ "nền tảng không có Argon2id"; (B) viết auth provider Argon2id tuỳ biến (thư viện mới, rủi ro đăng nhập admin).
- **DB-SEC-007**: RLS có áp dụng? Hệ thống một đơn vị bán, khách vãng lai, bảng duy nhất có `user_id` là `user_role` (RBAC admin). (A) ghi `— Không áp dụng` (không đa tenant, quyền kiểm ở server theo token đơn); (B) bật RLS cho `user_role` + vai trò app riêng (kéo theo DB-SEC-002, chi phí lớn với Medusa).
- **FE-FORM-001**: D-008 cấm client import giá trị từ `@x-shop/domain` nên form có bản phản chiếu + test đối chiếu. (A) chấp nhận đây là "một nguồn schema" nếu có test đối chiếu cố định (bổ sung test đối chiếu `normalizePhone`/`validateAddress` với domain, rồi tick);
  (B) đổi D-008: tách gói `@x-shop/domain/validation` thuần (không kéo ledger/state vào bundle client).
- **FE-STATE-001**: 4 fetch trong `useEffect` (đếm giỏ, phường/xã, gợi ý tìm kiếm, đếm bộ lọc) là route handler công khai nhỏ. (A) chuyển sang server action/RSC cho 2 chỗ; (B) giữ và nới mục (cần chủ dự án `— Miễn:` kèm `Duyệt:`); (C) thêm TanStack Query + lint.
- **FE-BUILD-003**: `skipLibCheck: true` ở `tsconfig.base.json` (Medusa/Next cần). (A) giữ và ghi lý do vào ADR (kiểm `grep` ghi "ngoại lệ có lý do"); (B) tắt và sửa lỗi d.ts của phụ thuộc (có thể không khả thi).
- **BE-API-008**: hợp đồng hiện tại (422 thiếu key, 409 khác payload) khác mẫu khung (400/422). (A) đổi mã cho khớp khung (breaking cho storefront đã gọi); (B) giữ và ghi ngoại lệ trong OpenAPI/ADR.
- **UX-STATE-001**: Storybook chưa có. (A) thêm Storybook (phụ thuộc lớn); (B) chấp nhận test vitest theo trạng thái (Loading/Empty/Error/Default) + script đếm test thiếu thay Storybook.
- **BE-CACHE-005** đã đánh `[~]` theo cách hiểu "không có cache tầng ứng dụng"; nếu phiên chính coi `fetch` `revalidate` của storefront là cache thì chuyển thành `[ ]` kèm test Redis/backend tắt.

## Ngoài phạm vi phát hiện
- **`xt.yaml` khoá `e2e` rỗng** (`e2e: ""`): job `e2e` của `.github/workflows/ci.yml` chạy chế độ `off` nên E2E (`pnpm e2e`) KHÔNG chạy trong CI; "CI chạy cả hai project" của UX-RESP-008/FE-TEST-002 không thể đạt. Có sẵn `docs/ops/patches/T-048-ci-e2e.patch` (bản vá ci.yml thêm Postgres/Redis cho job e2e, chưa áp dụng vào `.github/workflows/ci.yml`). Đề xuất đặt `e2e: "pnpm e2e"` + `e2e_setup` (chạm cấu hình CI: PR riêng, nêu lý do).
- `xt.yaml` khoá `perf` rỗng (đề xuất ở `docs/ops/perf/README.md`: `perf: "pnpm perf:budget"`).
- Rate limit `/x/webhooks/shipping/ghn` dùng `FixedWindowLimiter` trong bộ nhớ (từng tiến trình), khác bộ đếm Postgres của các route khác.
- Số lượng test tích hợp ở dải này chỉ grep tên; nên có một job nhẹ chạy tập con "evidence tests" nếu muốn `blueprint-status --run` đo thật.
