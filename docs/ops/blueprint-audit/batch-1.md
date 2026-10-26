# Audit BLUEPRINT.md — lô 1 (dòng 29–281, 133 mục MUST) · 2026-10-26

Phạm vi: mục `- [ ]` nằm trong dòng 29–281 của `BLUEPRINT.md` (nhóm BASE-*, STD-*, ARC-*, UX-*). Cách làm theo `/blueprint audit`: đọc code,
CI, `xt.yaml`, hook, docs thật; chạy từng lệnh `— Kiểm:` (exit 0) trước khi tick. Không sửa mã/test/CI/xt.yaml, không sửa dòng ngoài dải.

## Tổng hợp

| Kết quả | Số mục | Ghi chú |
|---|---|---|
| Đạt `[x]` kèm `— Kiểm:` chạy lại được | 53 | `blueprint-status --run`: 53/53 exit 0 (~60 s toàn bộ) |
| Không áp dụng `[~]` | 9 | STD-A11Y-005, STD-API-005, STD-API-006, ARC-STYLE-006, UX-AI-001/002/004/007, UX-VIZ-002 |
| Còn mở `[ ]` (ghi `— Thiếu:`) | 71 | danh sách + task đề xuất bên dưới |

Phân loại bằng chứng: **đo được** — mọi mục `[x]` có lệnh exit 0. Trong đó chạy test thật: env/security/admin-security (jest unit), env + a11y +
search-suggest (vitest), domain money/catalog, `format:check`, `lint`, `ci-check`, `progress-check`, `contrast`. Ba mục dựa test tích hợp
(BASE-DATA-008/009, ARC-INT-003/005): lệnh Kiểm chỉ grep tên test còn tồn tại (không chạy tích hợp trong 30 s); **đã chạy thật cục bộ 2026-10-26
và xanh**: checkout-submit, payment-ipn, security, rbac, health, notify, refund-guard (Postgres/Redis cục bộ), CI job `gate` chạy cả bộ.
**Tick còn hạn chế (đo được nhưng phạm vi hẹp, phiên chính cân nhắc):**
- BASE-SEC-006: chưa có Dockerfile nên phần "USER không root" chưa có đối tượng; kiểm sudo + quyền token CI.
- UX-DS-003 / UX-A11Y-002: dự án mới có một theme sáng (DESIGN.md: chế độ tối chưa có) → "cả hai theme" đạt theo nghĩa 1 theme.
- BASE-GATE-005: kiểm cấu hình (không continue-on-error, CI chạy toàn bộ); chưa đo "chạy 3 lần cùng kết quả".
- BASE-REPO-008: đọc ruleset trong repo (`.github/rulesets/main.json`), chưa đọc API GitHub để xác nhận đang hiệu lực.
- BASE-DATA-001: `.editorconfig` + quét `file --mime-encoding`; chưa có test riêng cho encoding DB.
- UX-VISUAL-002: không có `setInterval`/autoplay, chỉ 2 animation `infinite` (spinner, skeleton shimmer).

## Mục MUST còn mở → task đề xuất (mỗi task có Gate máy kiểm)

Việc nhỏ, làm ngay được (ưu tiên):
1. **T-a: Tài liệu gốc** — BASE-DOC-001, BASE-DOC-005 (một phần), BASE-REPO-004, BASE-REPO-007, BASE-REPO-003, BASE-SEC-009. Thêm `README.md`
   (mô tả, yêu cầu, cài/chạy/test, cấu hình trỏ `docs/ops/ENV.md`), `LICENSE` (Proprietary) + `license` trong package.json, `CHANGELOG.md`
   (Keep a Changelog), `.gitattributes` (`* text=auto`, `eol=lf` cho `*.sh`), `SECURITY.md`. Gate: `python3 .xtemplates/scripts/xt.py changelog-check`
   + `test -f README.md LICENSE SECURITY.md .gitattributes` + `pnpm format:check`.
2. **T-b: Tương phản/a11y E2E** — STD-A11Y-002, UX-A11Y-001, UX-A11Y-003. Thêm tag `wcag22aa` và chặn mọi vi phạm (không chỉ serious/critical) trong
   `e2e/a11y-reflow.spec.ts`; thêm E2E bàn phím (Tab/Enter/Escape) cho luồng giỏ→thanh toán. Gate: `pnpm e2e` + `grep -q wcag22aa e2e/a11y-reflow.spec.ts`.
3. **T-c: Token màu** — UX-DS-002. Thay `rgb(...)` ở `CatalogView.module.css:186` và `Dialog.module.css:6` bằng token (`--shadow-*`, `--overlay`);
   thêm cặp tương phản nếu cần. Gate: `! grep -rEn '#[0-9a-fA-F]{3,8}\b|rgba?\(' apps/storefront/src --include=*.css | grep -v tokens.css` + `xt.py contrast ...`.
4. **T-d: Tài liệu chuẩn** — STD-SEC-001 (đổi thành "ASVS 5.0.0 L2" trong PROJECT.md), STD-PROC-001 (bảng ISO/IEC 25010 ≥ 3 đặc tính có ngưỡng),
   STD-SEC-003 (bảng A01–A10:2025 trong THREAT-MODEL.md), BASE-SEC-013/STD-PRIV-002 (phân loại + `docs/compliance/data-inventory.csv`),
   UX-VISUAL-007 (`assets/CREDITS.md`, hoặc ghi rõ ảnh demo SVG do dự án tự tạo), BASE-DOC-004 (RUNBOOK: deploy, chẩn đoán, nơi giữ bí mật), ARC-MOD-008
   (`docs/architecture/domains.md`). Gate: các lệnh grep ghi ở mục BLUEPRINT tương ứng + `pnpm format:check`.
5. **T-e: ADR** — ARC-STYLE-001, ARC-STYLE-002, BASE-DOC-003, ARC-ADR-003, ARC-ADR-004. ADR mới chốt modular monolith + 2 deployable (có mục
   "Điều kiện đọc lại", "Bằng chứng"); bổ sung Date/Context/Decision Outcome/Consequences (ADR-0001 chỉ thêm heading — cần phiên chính quyết, xem câu hỏi);
   script lint heading ADR chạy trong CI. Gate: script `scripts/check-adr.mjs` exit 0 (mới) + `node --test`.
6. **T-f: Phụ thuộc/CI** — BASE-DEP-004, 005, 006, 007, 008. `dependabot.yml` thêm `npm`; `license-allow.json` (`xt.py license-check` exit 0); bước CI quét
   lỗ hổng mỗi PR + cron tuần (`pnpm audit --prod --audit-level high` hoặc osv-scanner) ; ghim digest image `postgres`/`redis`. Gate:
   `python3 .xtemplates/scripts/xt.py license-check && python3 .xtemplates/scripts/xt.py ci-check`. (Chạm cấu hình CI: PR riêng, nêu lý do.)
7. **T-g: Lint nới chặt** — BASE-DATA-003 (`prefer-nullish-coalescing`, `strict-boolean-expressions` bật dần), BASE-ERR-001 (sửa 2 `.catch(() => {})`
   trong scripts + rule chặn), ARC-MOD-004/005 (dependency-cruiser hoặc test import: không vòng, không import nội bộ module). Gate: `pnpm lint`.
8. **T-h: Log/lỗi có cấu trúc** — BASE-ERR-002, 003, 005 (storefront), 006, 007, 008, 009, 011. Handler lỗi toàn cục + `trace_id` trong problem+json, logger
   tối thiểu trường `service/version/env/trace_id`, redaction, chống log injection, test 500 không lộ stack; cảnh báo lỗi (cần chọn Sentry/GlitchTip — việc cần
   chủ dự án cung cấp tài khoản). Gate: jest unit mới `error-handler.unit.spec.ts`, `logging.unit.spec.ts`.
9. **T-i: Timeout/độ bền** — BASE-ERR-004, ARC-RES-001, ARC-RES-002, ARC-RES-005, ARC-RES-009. `statement_timeout`/connect timeout trong
   `medusa-config.ts`; jitter cho `outboxBackoffMs`; test SIGTERM tắt êm; E2E hai bản sao. Gate: jest unit mới + `pnpm test:integration`.
10. **T-j: Quyền riêng tư vận hành** — STD-PRIV-004 (E2E `rights-access/delete/withdraw-consent`), STD-PRIV-005 (job hết hạn lưu + test seed quá hạn). Cần
    quyết chính sách thời hạn lưu (DPIA mục 4: chờ chủ dự án). Gate: test đặt tên đúng chạy trong CI.
11. **T-k: API contract** — BASE-DOC-007, STD-API-001, STD-API-008, STD-PROC-003, STD-SEC-004. Sinh OpenAPI 3.1 cho `/store/x/*`, `/x/webhooks/*`; `oasdiff` trong CI;
    đặt tên test `api1-bola`/`api5-bfla` cho các ca rbac/returns-privacy. Gate: `grep -E "^openapi: 3\.(1|2)" openapi.yaml` + job `oasdiff`.
12. **T-l: Cấu hình** — BASE-CFG-003 (test so khớp khoá `docs/ops/ENV.md` với schema zod — vì `.env*` bị chặn ghi), BASE-CFG-005 (đánh dấu trường bí mật + hàm che),
    BASE-CFG-007 + BASE-SEC-010 (xác nhận/khai `--host` mặc định an toàn). Gate: jest unit mới `env-doc.unit.spec.ts`.
13. **T-m: Đạo đức nội dung/kiểm tay** — UX-CONTENT-001 (`check:vi-diacritics`), UX-CONTENT-005 (rà dark pattern, ghi biên bản), UX-CONTENT-006 (E2E so tổng
    bước đầu = bước xác nhận), STD-A11Y-004 (biên bản kiểm tay trong `GO-NO-GO.md`, cần người). Gate: script exit 0 + E2E.
14. **T-n: Tích hợp webhook/idempotency** — ARC-INT-001, ARC-INT-008 (xem câu hỏi mở: cách hiểu).
15. **T-o: Repo/phát hành** — BASE-REPO-005 (commit-msg regex hook hoặc commitlint), BASE-REPO-006, STD-PROC-002 (chọn SemVer/CalVer, tag `v0.x.y` khi có
    bản phát hành, nguồn phiên bản duy nhất), BASE-GATE-009 (CODEOWNERS/hook hỏi người cho đường dẫn cấu hình cổng — cần quyết). Gate: `git tag -l 'v*'` + commitlint.
16. **T-p: Chờ hạ tầng** — BASE-DEP-009, STD-SEC-007, BASE-SEC-007 (lint chặn nối SQL), BASE-SEC-001 (kiểm tự động mọi route có schema). Hạ tầng chưa chọn nên
    hai mục đầu chưa làm được; hai mục sau làm được ngay bằng test quét route.

Toàn bộ 71 mục mở (đều MUST): BASE-CFG-003/005/007 · BASE-DATA-003 · BASE-DEP-004..009 · BASE-DOC-001/003/004/005/006/007 · BASE-ERR-001..009, 011 ·
BASE-GATE-009 · BASE-REPO-003..007 · BASE-SEC-001/007/009/010/013 · STD-A11Y-002/004 · STD-API-001/008 · STD-PRIV-002/004/005 · STD-PROC-001/002/003 ·
STD-SEC-001/003/004/007 · ARC-STYLE-001/002 · ARC-MOD-004/005/008 · ARC-ADR-003/004 · ARC-INT-001/008 · ARC-RES-001/002/005/009 · UX-A11Y-001/003 ·
UX-CONTENT-001/005/006 · UX-DS-002 · UX-VISUAL-007. BASE-DOC-006 (lychee/kiểm liên kết) thuộc T-a/T-d.

## Câu hỏi mở (cần phiên chính quyết, `xt.py loop decide`)
- **ARC-INT-001**: bắt buộc mọi POST nhận `Idempotency-Key` (A) hay chấp nhận idempotent theo máy trạng thái cho POST admin (approve/execute/receive...) có test song song (B)?
  Dữ kiện: checkout, tạo hoàn tiền, IPN đã có khoá/dedupe; 20 route POST admin/store khác chỉ idempotent theo trạng thái (refund-guard.spec có ca song song).
- **ARC-INT-008**: IPN VNPAY ký HMAC-SHA512 theo giao thức nhà cung cấp (khác mẫu HMAC-SHA256 + timestamp + webhook-id). (A) ghi ADR ngoại lệ theo giao thức nhà cung cấp, thêm cửa sổ
  `vnp_PayDate`; (B) giữ mở. GHN callback chưa kiểm chữ ký: cần xem tài liệu GHN (token/IP allowlist).
- **BASE-DOC-003 / ARC-ADR-003**: ADR-0001 đã accepted thiếu Date/Context/Decision Outcome/Consequences. (A) sửa chỉ thêm heading (doc, không đổi nội dung); (B) viết ADR-0002 "supersedes" mẫu MADR.
- **BASE-GATE-009**: có thêm CODEOWNERS/hook hỏi người cho đường dẫn cấu hình cổng (trái autopilot không chờ người, ADR-0018 khung), hay ghi miễn có duyệt chủ dự án (`— Miễn:` cần chủ dự án)?
- **BASE-CFG-003**: `.env.example` bị chặn ghi trong môi trường agent. (A) người tạo file; (B) chấp nhận `docs/ops/ENV.md` là "file tương đương" kèm test khớp khoá với schema (T-l).

## Ngoài phạm vi phát hiện
- Chưa có `README.md`, `LICENSE`, `CHANGELOG.md`, `.gitattributes`, `SECURITY.md` — nằm trong T-a.
- Lệnh `pnpm lint` và `pnpm format:check` (dùng làm Kiểm BASE-GATE-002/003) mỗi lệnh ~14–17 s; nếu cần nhanh hơn có thể đổi sang kiểm theo gói.
- Ở dải khác: `blueprint-status --run` chạy không có lệnh đỏ (chỉ các mục lô này có lệnh Kiểm).
