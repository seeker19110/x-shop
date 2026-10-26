# Audit BLUEPRINT.md — lô 4 (dòng 709–924, 96 mục MUST) · 2026-10-26

Phạm vi: mục `- [ ]` trong dòng 709–924 của `BLUEPRINT.md` (nhóm QA-E2E/INT/PERF/STATIC/DATA/STRAT/UNIT, OPS-DR/COST/DEPLOY/IR/IAC/MAINT/OBS/SLO,
CMP-AI/RIGHTS/INTL/LIC/PRIV/AUDIT/VN, PM-REQ/HANDOVER). Cách làm như lô 1–3: đọc code, CI, `xt.yaml`, hook, docs thật; chạy từng lệnh `— Kiểm:`
(exit 0) trước khi tick; không sửa mã/test/CI/xt.yaml/PLAN/PROGRESS, không sửa dòng ngoài dải (diff: đúng 96 dòng đổi, không đổi chữ mục).

## Tổng hợp

| Kết quả                                  | Số mục | Ghi chú                                                                                                                                            |
| ---------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Đạt `[x]` kèm `— Kiểm:` chạy lại được    |     13 | `blueprint-status --run`: 124 lệnh (53 lô 1 + 24 lô 2 + 34 lô 3 + 13 lô 4) đều exit 0; lô 4 chậm nhất `pnpm lint` ≈ 15 s                           |
| Không áp dụng `[~]`                      |      9 | QA-PERF-008, QA-DATA-007/008, OPS-COST-003, CMP-AI-001/002/003/006, CMP-INTL-005                                                                   |
| Còn mở `[ ]` (ghi `— Thiếu:`)            |     74 | danh sách + task đề xuất bên dưới                                                                                                                  |

Đạt: QA-INT-001/002, QA-STATIC-001/003, QA-STRAT-001, QA-UNIT-004/007/008/010, CMP-RIGHTS-003, PM-REQ-001/007/009.

**Tick còn hạn chế (đo được nhưng phạm vi hẹp, phiên chính cân nhắc):**

- QA-UNIT-007/008/010: test nằm ở integration (`checkout-submit.spec.ts` AT04/AT05, `payment-ipn.spec.ts`, `refund-lock-guard.spec.ts`) — lệnh kiểm chỉ
  grep tên test (chạy thật ở job `gate` của CI, cần Postgres/Redis, quá 30 s cục bộ), như tiền lệ SEC-LOG-007 lô 3.
- QA-STRAT-001: kiểm khớp văn bản `xt.yaml` `test:` ↔ `ci.yml` gọi `dev-task.sh gate-par` (không chạy `pnpm test:integration`).
- QA-STATIC-003: `tsc` chỉ chạy ở `packages/domain` (nhanh); backend/storefront chạy ở `pnpm typecheck` của gate. Mọi tsconfig kế thừa `tsconfig.base.json`
  (`strict`, `noUncheckedIndexedAccess`), không ghi đè `strict: false`.
- QA-INT-001: `PROJECT.md` chỉ ghi "PostgreSQL" không số major; major 16 lấy từ ADR-0001, trùng image `postgres:16-alpine` của CI. QA-INT-002: dùng
  `medusaIntegrationTestRunner` (Medusa dựng DB mới + chạy chuỗi migration) ở 33 suite; không có `schema.sql`.
- CMP-RIGHTS-003: hiện không có script/SDK theo dõi bên thứ ba nào và chưa có UI đồng ý; `track()` chỉ đẩy `dataLayer`, beacon cần
  `NEXT_PUBLIC_ANALYTICS_TRANSPORT=beacon` VÀ đồng ý (unit test). Không phải test Playwright chặn mạng như chữ mục. Phải kiểm lại khi thêm tracker.
- PM-REQ-007: lệnh gốc `rg -o "R-[0-9]{3}" | uniq -d` báo trùng giả vì khớp `ADR-0001` (`R-000`); lệnh kiểm dùng `grep -ow` (ranh giới từ). R-001…R-004 duy nhất.
- PM-REQ-001/009: kiểm có tiêu đề/mục; nội dung "không chứa giải pháp" là phán đoán đã đọc (PROJECT.md §1 không nêu tên công nghệ/tính năng).
- Chưa tick vì cách hiểu chặt hơn: QA-E2E-005 (`retries: 0`, `trace: retain-on-failure`, không `!!process.env.CI`), PM-REQ-019 (một câu
  `[chặn ra mắt]` chưa trỏ `D-NNN`), CMP-AUDIT-002 (thiếu `user_agent`/`outcome`).
- `[~]` CMP-INTL-005 chỉ đúng khi chỉ bán/giao tại VN và không đặt nhà xử lý ngoài VN; phải xem lại cùng CMP-VN-004 khi chọn hạ tầng.

## Mục MUST còn mở → task đề xuất (mỗi task có Gate máy kiểm)

Việc nhỏ, làm ngay được (tài liệu/cấu hình, không chờ hạ tầng):

1. **T-ba: Bộ tài liệu pháp lý/vận hành khung** — CMP-INTL-006, CMP-VN-006, CMP-AUDIT-003/007/010, CMP-PRIV-001, CMP-INTL-002, QA-DATA-001/002, OPS-IR-001/004/006/010,
   OPS-SLO-001 (phần định nghĩa), PM-HANDOVER-002/004/005/009. Files: `docs/privacy/data-map.yaml`, `docs/privacy/{processors,transfers}.md` + `CHANGELOG.md`,
   `docs/compliance/{vendors.yaml,test-data-policy.md}`, `docs/ops/runbooks/data-breach.md`, `docs/ops/INCIDENT-RESPONSE.md` (SEV1–4, thứ tự xử lý, "Trước khi chạy lệnh
   lên dữ liệu", sự cố bảo mật), `docs/ops/incidents/.gitkeep`, `docs/handover/{accounts,renewals}.md` + mẫu offboarding, `README.md` + `RUNBOOK.md` gốc, mục "Dữ liệu test" trong
   `PROJECT.md`. Gate: `test -f docs/ops/INCIDENT-RESPONSE.md && test -f docs/ops/runbooks/data-breach.md && test -f docs/privacy/data-map.yaml && grep -q "Dữ liệu test" PROJECT.md && test -f README.md && pnpm format:check`.
2. **T-bb: Quét CI nhẹ + chính sách phụ thuộc** — OPS-MAINT-001/003/004/005, CMP-LIC-001/002/003/004, QA-STRAT-005, QA-DATA-002 (quét fixture). Files:
   `.github/dependabot.yml` (thêm `npm` cho 4 manifest, `groups`, `open-pull-requests-limit`), `scripts/eol-check.mjs`, `.github/workflows/vuln-scan.yml` (`schedule`, osv-scanner — trùng
   T-ai lô 3), `docs/ops/VULN-SLA.md`, `LICENSE` (proprietary + chủ sở hữu), `license-policy.yaml`, `scripts/licenses.mjs` (+ SBOM CycloneDX trong CI), `.github/PULL_REQUEST_TEMPLATE/major-upgrade.md`,
   job kiểm `fix:` có test, `scripts/check-fixtures.mjs`. Chạm CI: PR riêng nêu lý do. Gate: `python3 .xtemplates/scripts/xt.py ci-check && node scripts/eol-check.mjs && node scripts/check-fixtures.mjs && test -f LICENSE && pnpm format:check`.
3. **T-bc: Lint cưỡng chế** — QA-STATIC-004/005, QA-STRAT-008 (trùng QA-COV-004 T-aj lô 3). Files: `eslint.config.mjs` (`no-console`, `eslint-comments/require-description` hoặc
   `linterOptions.reportUnusedDisableDirectives`, eslint-plugin-vitest/jest `no-focused-tests`/`no-disabled-tests`), thêm lý do cho 10 `eslint-disable` hiện có (apps/storefront/src/components/{catalog/ListAnalytics,orders/PurchaseAnalytics,
   checkout/CheckoutForm,product/ProductExperience}.tsx, các test, `returns-flow.ts`, `order-lookup.spec.ts`). Không hạ ngưỡng. Gate: `pnpm lint`.
4. **T-bd: `/readyz` + tag authz** — OPS-OBS-006, QA-INT-006. Files: `apps/backend/src/api/x/readyz/route.ts` (kiểm DB/Redis có timeout, 503 khi down, không lộ chi tiết) + integration test;
   gắn tag `api1-bola`/`api5-bfla` vào test hiện có + `scripts/check-authz-tests.mjs` đối chiếu route chạm dữ liệu cá nhân. Gate: `pnpm --filter @x-shop/backend test:integration -- health` + `node scripts/check-authz-tests.mjs`.
5. **T-be: Sửa E2E cấu hình + tag** — QA-E2E-003/005/006 (cùng T-048). Files: `playwright.config.ts` (`forbidOnly: !!process.env.CI`, `retries: process.env.CI ? 2 : 0`, `trace: "on-first-retry"` — xem câu hỏi mở 2),
   `e2e/helpers.ts` (`expectNoA11yViolations`), gắn `@smoke` + quét axe vào checkout-cod/vnpay, email `+e2e-<uuid>`. Gate: `pnpm e2e`.
6. **T-bf: PERF gọn** — QA-PERF-006/007, QA-PERF-002 (phần nightly). Files: `docs/ops/perf/load-smoke-latest.md` (thêm SHA commit — `scripts/load/report.mjs`), `.github/workflows/load-nightly.yml`
   (BASE_URL từ secret, grep cấm domain production; chạy khi có staging), mục hiệu năng GO-NO-GO. Gate: `pnpm load:test` + `python3 .xtemplates/scripts/xt.py ci-check`.
7. **T-bg: Sửa PM-REQ-019** — thêm `D-NNN`/tên + ngày cho câu "Chính sách đổi trả, thuế/hóa đơn, phí ship" ở `PROJECT.md` §10. Gate: `grep -n "chặn ra mắt" PROJECT.md | grep -q "D-"`.

Task trung bình (cần thiết kế/quyết định):

8. **T-bh: Đồng ý + quyền chủ thể** — CMP-RIGHTS-001/004/007, CMP-VN-001/007, CMP-PRIV-005, CMP-INTL-007, CMP-PRIV-010. Files: module `consent` (bảng append-only `subject_id, purpose_id, policy_version, granted_at,
   channel, ui_snapshot_hash, withdrawn_at` + migration MỚI), UI đồng ý/rút cùng số bước, workflow xoá/ẩn danh PII đơn (giữ chứng từ), cấu hình `dsar_days`, lớp redaction PII VN (SĐT/CCCD/email/địa chỉ). Gate: `pnpm --filter @x-shop/backend test && pnpm --filter @x-shop/backend test:integration && pnpm e2e`.
9. **T-bi: Audit trail đủ trường** — CMP-AUDIT-002 (+ SEC-LOG-001/002 lô 3, CMP-PRIV-008). Files: migration mới thêm `user_agent`, `outcome` vào `audit_log`; ghi thêm xuất dữ liệu/DSAR. Gate: `pnpm --filter @x-shop/backend test:integration -- audit`.
10. **T-bj: Tối ưu chi phí/giám sát trong ứng dụng** — OPS-COST-004, OPS-OBS-001/003/008 (phần in-app: log JSON + redact; OTel khi chọn nền tảng), OPS-DEPLOY-003 (`scripts/check-migrations.mjs` cấm `DROP COLUMN`/`RENAME` không cờ contract). Gate: `node scripts/check-migrations.mjs && pnpm --filter @x-shop/backend test`.

Việc chờ người / hạ tầng:

11. **Chọn hạ tầng production** (RUNBOOK §4.5, PROJECT.md "Khi chạy thật") — OPS-DR-003/004/007/008, OPS-COST-001/005, OPS-DEPLOY-001/002/004, OPS-IAC-001/003/004/006, OPS-SLO-004/005/006,
    OPS-OBS-001/003/008, CMP-VN-004, QA-PERF-002 (staging). Gate sau khi chọn: IaC trong repo + `plan` sạch, diễn tập rollback/khôi phục có ngày + thời gian (rollback-drills.md, runbooks/restore-*.md).
12. **Chủ repo bật ruleset sống** — QA-STRAT-002 (cùng WF-GIT-001/002 lô 3): `gh api repos/seeker19110/x-shop/rules/branches/master` phải chứa `required_status_checks` `quality`.
13. **E2E trong CI** — QA-E2E-001: áp `docs/ops/patches/T-048-ci-e2e.patch` (`xt.yaml` `e2e: "pnpm e2e"`), kèm T-be để có `@smoke` ≥ 3.
14. **Pháp lý** (chủ shop/luật sư): rà DPIA, thời hạn lưu chứng từ, DPA với GHN/VNPAY/email-SMS — nền cho CMP-AUDIT-007, CMP-VN-004/006.

Toàn bộ 74 mục mở (đều MUST): QA-E2E-001/003/005/006 · QA-INT-006/007 · QA-PERF-002/006/007 · QA-STATIC-004/005 · QA-DATA-001/002 · QA-STRAT-002/005/008 ·
OPS-DR-003/004/007/008 · OPS-COST-001/004/005 · OPS-DEPLOY-001/002/003/004 · OPS-IR-001/004/006/010 · OPS-IAC-001/003/004/006 · OPS-MAINT-001/003/004/005 ·
OPS-OBS-001/003/006/008 · OPS-SLO-001/004/005/006 · CMP-RIGHTS-001/004/007 · CMP-INTL-002/006/007 · CMP-LIC-001/002/003/004 · CMP-PRIV-001/005/008/010 ·
CMP-AUDIT-002/003/007/010 · CMP-VN-001/004/006/007 · PM-REQ-019 · PM-HANDOVER-002/004/005/009.

## Câu hỏi mở (phiên chính quyết — `xt.py loop decide`)

1. **`[~]` cho mục AI (CMP-AI-001/002/003/006, OPS-COST-003) và CMP-INTL-005:** (a) giữ `[~]` — dựa PROJECT.md §3 (AI là P2 "Không làm", chỉ bán/giao tại VN), rẻ, nhưng phải rà lại
   khi roadmap đổi; (b) giữ `[ ]` kèm `— Thiếu:` đến khi có tính năng — chặt hơn nhưng mở vĩnh viễn một nhóm không áp dụng. Đề xuất (a), thêm ghi chú "áp dụng lại khi…" (đã ghi trong từng mục).
2. **Cấu hình retry/trace E2E (QA-E2E-005):** (a) làm đúng chữ mục (`retries` 2 ở CI, `trace: on-first-retry`, `forbidOnly: !!CI`) — nhưng các spec dùng chung một DB/kho (`workers: 1`, tuần tự) nên retry có thể
   chạy lại trên trạng thái đã đổi (đơn đã tạo, tồn đã trừ) → kết quả xanh giả; (b) giữ `retries: 0` + `trace: retain-on-failure`, ghi miễn kèm `Duyệt` của chủ dự án (LOOP-STOP-024). Dữ kiện: `e2e/run.mjs` dựng DB mới mỗi lần chạy, `boost-stock.mjs` chỉnh tồn.
3. **QA-INT-007 (hợp đồng API):** (a) oasdiff trên OpenAPI do Medusa sinh/tự viết cho các route `/store/x/*`; (b) contract test tiêu thụ ở storefront (Zod schema dùng chung ở `packages/domain` + test fixture đối chiếu); (c) `[~]` vì một monorepo triển khai cùng nhau. Đề xuất (b): rẻ, bắt phá vỡ hợp đồng ở PR không thêm công cụ.
4. **Mức "đạt" của test tích hợp trong lệnh `— Kiểm:`** (QA-UNIT-007/008/010): chấp nhận grep tên test (CI `gate` chạy thật) hay đòi lệnh chạy thật? Chạy thật cần Postgres/Redis và > 30 s; đề xuất giữ grep, và để `loop verify` chạy `pnpm test:integration` ở cổng cuối.
5. **Lệnh kiểm gốc của PM-REQ-007** khớp nhầm `ADR-0001` (lỗi của mẫu khung: regex không có ranh giới từ) — gửi phản hồi về khung (`xt.py feedback add`)? Phiên chính quyết.
6. **Tiền lệ `.autopilot/`** (câu hỏi 1 của lô 3) vẫn áp dụng: lô 4 không dùng lệnh nào đọc `.autopilot/`.
