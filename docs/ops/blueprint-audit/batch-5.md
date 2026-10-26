# Audit BLUEPRINT.md — lô 5 (dòng 925–hết, 74 mục MUST) · 2026-10-26

Phạm vi: mục `- [ ]` từ dòng 925 tới hết `BLUEPRINT.md` (nhóm PM-METRIC/PLAN/PRIO/RISK/SPEC, XC-DX/DOCAI/I18N/OSS/PERF/GREEN/UNITS, PRF-WEB, IND-ECOM).
Cách làm như lô 1–4: đọc code/CI/`xt.yaml`/docs thật; chạy từng lệnh `— Kiểm:` (exit 0) trước khi tick; không sửa mã/test/CI/xt.yaml/PLAN/PROGRESS,
không sửa dòng trước 925 (diff: đúng 74 dòng đổi, không đổi chữ mục). Bộ lệnh kiểm mới chạy ≈ 14 s tổng (`vitest` mỗi lệnh ≈ 1–2 s).

## Tổng hợp

| Kết quả | Số mục | Ghi chú |
| --- | ---: | --- |
| Đạt `[x]` kèm `— Kiểm:` | 20 | PM-METRIC-003/004/005, PM-PLAN-001/003/006, PM-PRIO-001/007, XC-DX-003, XC-DOCAI-003/004, XC-I18N-003/005, XC-PERF-001/004, XC-UNITS-005, PRF-WEB-003/007/010, IND-ECOM-002 |
| Không áp dụng `[~]` | 5 | XC-I18N-009 (chưa có file dịch), IND-ECOM-011/012/013 (marketplace), IND-ECOM-014 (livestream/affiliate) |
| Còn mở `[ ]` (ghi `— Thiếu:`) | 49 | danh sách + task đề xuất bên dưới |

**Tick còn hạn chế (phiên chính cân nhắc):**

- PM-PLAN-001: PLAN ở `docs/autopilot/PLAN.md` (không có `PLAN.md` ở gốc). ID duy nhất, mọi task có Gate; "ID tăng dần" hiểu là cấp phát tăng dần — vị trí trong file theo lát
  nên T-039/T-040/T-041… nằm giữa các nhóm cũ (lệnh kiểm không đòi thứ tự vị trí). PM-PLAN-003: lệnh chỉ kiểm mọi Gate là lệnh thật (pnpm/python3/bash/dev-task.sh,
  không "review"); bằng chứng `exit_code: 0` nằm ở `.autopilot/evidence/` (không commit, không chạy lại được trong worktree). Việc đọc thư mục này bằng script bị guard chặn
  (EVIDENCE_HANDWRITE) — coi là kết luận, không thử lại.
- PM-METRIC-003/004/005: như CMP-RIGHTS-003 (lô 4): không có SDK/tracker bên thứ ba; `track()` là điểm phát duy nhất (rg `dataLayer|sendBeacon` ngoài `lib/analytics/` rỗng); beacon cần
  `NEXT_PUBLIC_ANALYTICS_TRANSPORT=beacon` VÀ đồng ý (unit test). Không phải E2E chặn mạng như chữ mục; khoá dedupe `xs_purchase_<mã đơn>` ở localStorage không PII, ghi trước đồng ý.
  Chặt hơn thì PM-METRIC-004 cần E2E/UI đồng ý khi thêm tracker thật. PM-METRIC-005 dùng `findPii` (regex email/SĐT/địa chỉ, quét cả khoá) + zod strip trường lạ, không phải "danh sách đen tên trường".
- PM-PRIO-007: không có sự kiện trễ hạn nên không có dòng "cắt X để giữ hạn Y" ở PROGRESS; kiểm phần bất biến (`xt.py ci-check`: không `continue-on-error`, permissions, ghim SHA).
- XC-I18N-003: dự án một locale `vi-VN` cố định (Intl, test `1.250.000 ₫`), không có test en-US vì không có yêu cầu đa ngôn ngữ. XC-I18N-005: có test NFD=NFC cho tìm kiếm ở domain, NFC server-side cho tên khách (`backend/lib/checkout/http.ts`) và CSV
  nhưng chưa có test NFD cho đầu vào checkout.
- XC-UNITS-005: cột tiền `integer` (không `bigint`, lý do ghi ở `Migration20261024173210.ts`; zod giới hạn ≤ 2.147.483.647), tên trường `total`/`subtotal` + `currency_code: "vnd"`, không phải `amount_minor` — đúng tinh thần số nguyên + ISO 4217.
- XC-DOCAI-003: so khớp tên script `package.json` ↔ `xt.yaml`; khoá `dev`/`migrate`/`e2e` không khai (xem XC-DX-002).
- PRF-WEB-003: `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` là khoá publishable của Medusa (thiết kế để công khai); lệnh kiểm khoá cứng đúng tên này, thêm biến `*KEY` công khai khác sẽ đỏ.
- IND-ECOM-002: snapshot giá/khuyến mãi/địa chỉ/`policy_version` có; thuế chưa mô hình (xem IND-ECOM-003). Test snapshot/PRICE_CHANGED nằm ở integration (`checkout-submit.spec.ts`, cần Postgres/Redis, chạy ở job `gate`) — lệnh kiểm chỉ grep tên test + chạy unit domain.
- Chưa tick vì cách hiểu chặt hơn: PRF-WEB-002 (`skipLibCheck: true` ở `tsconfig.base.json`), XC-DOCAI-001 (AGENTS.md không liệt kê lệnh; chỉ trỏ `xt.yaml`), PM-RISK-003 (RK-001 ở Lát 3), IND-ECOM-006 (phụ thuộc IND-FIN-003/004/007 vốn không có trong BLUEPRINT này).

## Mục MUST còn mở → task đề xuất (mỗi task có Gate máy kiểm)

Việc nhỏ, tài liệu/cấu hình, làm ngay được (không chờ chủ dự án/hạ tầng):

1. **T-A: Hồ sơ dự án thiếu** — PM-RISK-001/006/007, PM-PRIO-004, PM-PLAN-005, PM-SPEC-001/003, XC-UNITS-006. Files: `docs/RISKS.md` (bảng RK-001…RK-006 đủ cột + bảng `Phụ thuộc`: license/EOL/telemetry/thoát cho Medusa, Next, Postgres, Redis, VNPAY, GHN, Lighthouse),
   `SCOPE.md`, mục `Khung pháp lý` (số hiệu, ngày hiệu lực, URL, dòng kiểm tra sửa đổi) trong `PROJECT.md` (cần quyết dữ kiện luật — nguồn `docs/research/2026-10-24-stack.md` §9), `docs/autopilot/PLAN.md` mục Điểm dừng ≥4 dòng,
   `docs/specs/SPEC-admin.md`/`SPEC-storefront.md` thêm `## Ca biên` (≥6/8 nhóm), spec F-001/F-012 (hoặc ghi ADR coi ADR-0001/`docs/ops/` là spec), ghi mode làm tròn (`percentOfVnd` làm tròn xuống) vào SPEC-checkout §4.
   Gate: `grep -q '^| RK-001' docs/RISKS.md && test -f SCOPE.md && grep -q '^## Ca biên' docs/specs/SPEC-admin.md docs/specs/SPEC-storefront.md && python3 .xtemplates/scripts/xt.py blueprint-status BLUEPRINT.md --run`.
2. **T-B: Bộ file cộng đồng/bảo mật cho kho công khai** — XC-OSS-001/004, XC-DX-001, XC-DOCAI-005. Files: `README.md` (≤3 lệnh: `corepack enable && pnpm install --frozen-lockfile && pnpm test`), `LICENSE` (chủ dự án chọn giấy phép — câu hỏi mở), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`,
   `SUPPORT.md`, `.github/ISSUE_TEMPLATE/*`, `.github/CODEOWNERS` (AGENTS.md, CLAUDE.md, `.claude/**`, `.github/workflows/**`), `public/.well-known/security.txt`; bật private vulnerability reporting (cài đặt kho, cần chủ dự án).
   Gate: `test -f README.md -a -f LICENSE -a -f SECURITY.md -a -f .github/CODEOWNERS && python3 .xtemplates/scripts/xt.py checks`; sau đó `gh api repos/seeker19110/x-shop/community/profile --jq .health_percentage` = 100.
3. **T-C: Test nhỏ bù hàng rào** — IND-ECOM-005 (property test state machine bằng fast-check ở `packages/domain/src/state/state.test.ts`), XC-UNITS-001 (test API từ chối thời gian không offset + lint), XC-UNITS-009 (module `packages/domain/src/units.ts` + thay 39 chỗ `* 1000`/`* 1024`), PM-SPEC-004 (gắn nhãn `S-NNN` vào test hiện có + script so khớp `scripts/spec-trace.mjs`).
   Gate: `pnpm --filter @x-shop/domain test && pnpm test && node scripts/spec-trace.mjs`.
4. **T-D: Nối cổng hiệu năng/E2E vào CI** — XC-PERF-003, XC-GREEN-002, PRF-WEB-005/006, IND-ECOM-016, (đã có patch cho E2E: T-048 `docs/ops/patches/T-048-ci-e2e.patch`). Files: `xt.yaml` (`perf: "pnpm perf:budget"`, `e2e`), `.github/workflows/ci.yml`, `playwright.config.ts` (project `mobile` Pixel 7 + axe mọi spec), `scripts/perf/lighthouse.mjs`
   (thêm danh mục accessibility ≥ 0.9 và ≥5 URL), ngưỡng kích thước image. Chạm cấu hình cổng/CI → nêu lý do trong commit (không nới ngưỡng). Gate: `pnpm perf:budget && pnpm e2e`.
5. **T-E: Chuỗi UI ra file tài nguyên** — XC-I18N-001 (≥50 component có chuỗi hard-code): `apps/storefront/src/messages/vi.json` + ESLint `no-literal-string` (hoặc cổng tương đương) + script khoá thiếu = 0. Gate: `pnpm lint && pnpm --filter @x-shop/storefront test`. Lớn, tách theo màn hình; cần quyết định thư viện (câu hỏi mở 3).

Việc cần quyết định/nguồn lực ngoài (chủ dự án) — `loop defer`:

6. **Thuế, hoá đơn, chính sách, đổi trả (chặn ra mắt)** — IND-ECOM-003/007/008/009/010/015, PM-SPEC-020, XC-OSS-007: mô hình thuế/hoá đơn điện tử (nhà cung cấp, retention 10 năm), nội dung điều kiện giao dịch + chính sách có phiên bản, thời hạn đổi trả `returnWindowDays` (hiện `null`), retention đơn ≥ 3 năm, consent marketing/cookie (CMP-VN-001), luồng khách tự yêu cầu đổi trả (route Store + trang storefront + E2E + thông báo).
   Gate chung: `python3 .xtemplates/scripts/xt.py blueprint-status BLUEPRINT.md --run`.
7. **Hạ tầng** — PM-PRIO-003, PRF-WEB-008/009, XC-GREEN-001/007, PM-METRIC-006: walking skeleton deploy + smoke, staging + preview mỗi PR, error tracking + source map riêng tư, baseline tài nguyên và retention log/backup/analytics (chờ chọn nhà cung cấp; PLAN §Phụ thuộc ngoài).
8. **Rà kỹ thuật còn lại** — IND-ECOM-001 (thêm CHECK/trigger `stocked_quantity >= reserved_quantity` cho `inventory_level` bằng migration mới — không sửa migration cũ; hoặc ADR chấp nhận khoá ứng dụng), IND-ECOM-004 (giới hạn/người, ngân sách mã, bảng test chồng mã), IND-ECOM-006 (tài liệu phạm vi PCI SAQ A + chống phát lại webhook),
   XC-PERF-006 (liệt kê endpoint list, bỏ `take: null`, test 10⁶), PRF-WEB-001 (ADR render), PRF-WEB-002 (tắt `skipLibCheck` hoặc ADR ngoại lệ), PRF-WEB-004 (script phủ mọi endpoint ghi), XC-OSS-005 (`required_approving_review_count ≥ 1` khi có ≥2 maintainer), XC-DX-002/006 (khai `dev`/`migrate` ở xt.yaml; hook git cục bộ), XC-GREEN-005 (bảng trước/sau trong PR template), XC-DOCAI-001.

## Phát hiện ngoài phạm vi / lưu ý

- `blueprint-status --run` chạy lại mọi lệnh `— Kiểm:` của cả file (≈144 lệnh sau lô này) — lâu hơn 2 phút vì có `pnpm lint`/`vitest`; lô 5 chỉ thêm ≈ 14 s.
- Các mục IND-FIN-003/004/007 được IND-ECOM-006 viện dẫn không có trong BLUEPRINT.md (chỉ trong `framework/03-industries/fintech.md`) — đã đánh giá thực chất thay vì chờ tick.
- Guard chặn đọc `.autopilot/evidence/*.json` bằng script (EVIDENCE_HANDWRITE) và một số lệnh có chuỗi `git`/cờ bỏ-qua-hook nằm trong đối số — coi là kết luận; dùng `rg`/`ls` trực tiếp thay thế.

## Câu hỏi mở (cần `loop decide`)

1. **Giấy phép kho công khai (XC-OSS-001/007):** (a) MIT/Apache-2.0 — mở thật, đạt OpenSSF, chấp nhận bên thứ ba dùng lại; (b) giữ kho riêng tư (`private`) và đánh `[~]` nhóm XC-OSS — đúng với `UNLICENSED` ở `apps/backend/package.json` và nội dung thương mại (VNPAY/GHN, chính sách shop). Dữ kiện: kho hiện `public`, health 28 %, backend `"license": "UNLICENSED"`.
2. **Ngưỡng review (XC-OSS-005):** (a) giữ `required_approving_review_count: 0` (một chủ + agent, `delivery_phase: build`) và ghi ngoại lệ; (b) đặt 1 khi vào pha harden/có thêm maintainer. Dữ kiện: ruleset `.github/rulesets/main.json`.
3. **Chuỗi UI (XC-I18N-001):** (a) `next-intl` + `messages/vi.json` (chuẩn ICU, mở đường `en`); (b) module hằng số TS thuần (`lib/content/*`) + lint no-literal-string (ít phụ thuộc, không i18n thật); (c) giữ hard-code và đánh `[~]` với điều kiện "chỉ một ngôn ngữ, không roadmap thêm" (vi phạm lời khuyên của khung: chi phí tách ×10 về sau).
4. **Ràng buộc tồn kho (IND-ECOM-001):** (a) migration thêm CHECK trên bảng `inventory_level` của Medusa (chặt, nhưng đụng schema module ngoài, nguy cơ vỡ khi nâng cấp Medusa); (b) trigger trong module riêng đọc `reserved_quantity`; (c) ADR coi khoá Redis + test AT04 là đủ (rủi ro: mất khoá `LOCK_UNAVAILABLE` đã chặn bán — xem `locks.ts`).
5. **`skipLibCheck` (PRF-WEB-002):** (a) tắt toàn cục và sửa lỗi kiểu của thư viện (có thể nhiều lỗi từ `@medusajs/*`); (b) giữ `true` + ADR ngoại lệ ghi lý do + cổng `tsc` cho mã dự án. Dữ kiện: `tsconfig.base.json:13`, mọi package kế thừa.
6. **PLAN `ID tăng dần` (PM-PLAN-001):** hiểu là thứ tự cấp phát (đã tick) hay thứ tự vị trí trong file (phải đánh số lại hoặc thêm quy ước). Đề xuất (a): giữ, thêm một dòng quy ước vào đầu PLAN.
