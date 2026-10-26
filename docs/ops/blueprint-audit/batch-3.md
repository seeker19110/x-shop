# Audit BLUEPRINT.md — lô 3 (dòng 499–708, 90 mục MUST) · 2026-10-26

Phạm vi: mục `- [ ]` nằm trong dòng 499–708 của `BLUEPRINT.md` (nhóm WF-*, LOOP-*, SEC-*, QA-COV-*). Cách làm như lô 1/2: đọc code, CI,
`xt.yaml`, hook, docs thật; chạy từng lệnh `— Kiểm:` (exit 0) trước khi tick; không sửa mã/test/CI/xt.yaml/PLAN/PROGRESS, không sửa dòng ngoài dải.

## Tổng hợp

| Kết quả | Số mục | Ghi chú |
|---|---|---|
| Đạt `[x]` kèm `— Kiểm:` chạy lại được | 34 | `blueprint-status --run`: mọi lệnh exit 0 (tổng 111 lệnh: 53 lô 1 + 24 lô 2 + 34 lô 3), ~105 s toàn bộ |
| Không áp dụng `[~]` | 6 | WF-TEAM-007, SEC-AI-001/002/005/007, SEC-WEB-008 |
| Còn mở `[ ]` (ghi `— Thiếu:`) | 50 | danh sách + task đề xuất bên dưới |

Phát hiện quan trọng (đo thật 2026-10-26): ruleset sống `main — bảo vệ nhánh chính` (id 25788340) có `enforcement: disabled`;
`gh api repos/seeker19110/x-shop/rules/branches/master` trả `[]`, `branches/master/protection` trả 404 — `master` hiện **không** được bảo vệ dù
`.github/rulesets/main.json` đúng. Kéo theo WF-GIT-001/002, WF-REVIEW-005 còn mở. Chỉ chủ repo bật được (Settings → Rules).

**Tick còn hạn chế (đo được nhưng phạm vi hẹp, phiên chính cân nhắc):**
- WF-CI-001: kiểm trên file ruleset + `quality` (`if: always()`, `needs: [gate, e2e]`, bước protection-guard); `merge-gate.yml` là stub D-122 vẫn còn, không nằm trong ruleset của repo.
- WF-CI-003/004/005, SEC-SUPPLY-001/009: không có zizmor/actionlint/pinact trong máy; dùng `xt.py ci-check` (permissions, ghim SHA 40 ký tự, timeout, không `write-all`) + awk tự viết quét `${{ }}` trong khối `run:` (đã thử âm tính trên file mẫu) + grep `pull_request_target` = 0.
- WF-REVIEW-001: PR template không có nhãn "CI xanh" mà có mục Bằng chứng `dev-task.sh gate`; `quality` là required check trong file ruleset (chưa hiệu lực, xem trên).
- WF-GIT-003: `protection-guard` là bước trong job `quality` (không phải job riêng); chỉ kiểm sự có mặt của luật đỏ/cảnh báo, chưa chạy nhánh thử đổi tên job.
- WF-GIT-010 / SEC-SECRET-001 / LOOP-FB-003: gitleaks không cài cục bộ; kiểm `secret-scan.yml` (fetch-depth 0, action ghim) + `.env` không có trong index; quét thật nằm ở CI.
- LOOP-CTX-017: kiểm có hook PreCompact + `loop checkpoint`; điều kiện "chỉ cập nhật Bàn giao khi ≥ 80% trần" là quy trình, không có lệnh.
- LOOP-STOP-001/002/003/005, LOOP-ORCH-001/003/009, LOOP-CI-001/004: dựa `xt.py harness-check` (guard chặn lệnh mẫu, `ask` rỗng, `tools:` agent tường minh) + grep cấu hình guard; không chạy lại bộ test hook của khung (`tests/test_hooks.py` không có trong repo). LOOP-STOP-003: mặc định guard đánh dấu nhưng cho chạy (ADR-0018), `strict` mới hỏi.
- LOOP-STOP-005: máy chặn merge PR ngoại lệ cứng nhờ `merge_hard_exceptions: human`; GitHub không chặn thêm vì ruleset sống disabled và `required_approving_review_count: 0`.
- SEC-WEB-007: test đơn vị `checkCsrf`/`proxy` (storefront, vitest) + tên test CSRF tích hợp backend (chỉ grep, không chạy); cookie SameSite=Lax ở giỏ/đơn. "GET không side-effect" chưa có kiểm máy.
- SEC-LOG-007: chống UPDATE/DELETE bằng trigger `x_append_only_guard` + test tích hợp `audit.spec.ts` (chỉ grep tên); chưa phải quyền DB theo vai trò (DB-SEC-002 lô 2 còn mở).
- SEC-TM-001/003: THREAT-MODEL.md nằm ở `docs/ops/` (mục nói `docs/`), không có frontmatter `updated`; sơ đồ là ASCII, đủ VNPAY/GHN/Postgres/Redis/Email-SMS/Admin. Nội dung còn nháp (xem SEC-TM-005/006).
- LOOP-HARNESS-001/002: kiểm cú pháp/số Gate của PLAN.md (61 task = 61 `— Gate:`), không chạy từng Gate trong CI.

## Mục MUST còn mở → task đề xuất (mỗi task có Gate máy kiểm)

Việc nhỏ, làm ngay được (ưu tiên):
1. **T-ab: Mẫu PR/issue + pr-policy** — WF-REVIEW-002, WF-DOC-001, WF-TEAM-003, WF-TEAM-004, WF-SDD-003 (một phần). Files: `.github/pull_request_template.md` (thêm mục "Docs cập nhật/không cần (lý do)", DoD: lỗi/rỗng/tải, tự review diff, deploy thử, map tiêu chí → test), `.github/ISSUE_TEMPLATE/task.md` (checklist DoR), `.github/workflows/pr-policy.yml` (kiểm mục bắt buộc trong body qua `env:`, không checkout code PR). Chạm CI: PR riêng nêu lý do. Gate: `python3 .xtemplates/scripts/xt.py ci-check && grep -q "Docs cập nhật" .github/pull_request_template.md && test -f .github/ISSUE_TEMPLATE/task.md && pnpm format:check`.
2. **T-ac: Sửa link hỏng + link check trong CI** — WF-DOC-002. Sửa 12 liên kết (10 anchor ở `docs/specs/DAC-TA-GOC.md`, 1 ở `BLUEPRINT.md`, 1 ở `BLUEPRINT-BACKLOG.md`), thêm bước `python3 .xtemplates/scripts/check-links.py` vào `gate` (chạm CI). Gate: `python3 .xtemplates/scripts/check-links.py` (hiện exit 1).
3. **T-ad: Mở rộng RUNBOOK** — WF-DOC-008, WF-REL-004, SEC-SECRET-011, WF-ENV-010 (chính sách), WF-REL-007 (ngưỡng lùi). Files: `docs/ops/RUNBOOK.md` (mục Deploy, Rollback có lệnh, Xoay secret, Lộ bí mật theo từng khoá VNPAY/GHN/JWT/MFA, chính sách dữ liệu staging, trường `last_drilled`), `docs/ops/ENV.md`. Diễn tập rollback thật cần cơ chế deploy (chờ hạ tầng). Gate: `grep -q "last_drilled" docs/ops/RUNBOOK.md && grep -q "Lộ bí mật" docs/ops/RUNBOOK.md && pnpm format:check`.
4. **T-ae: THREAT-MODEL hoàn tất** — SEC-TM-005, SEC-TM-006 (và làm tươi SEC-TM-001/003). Files: `docs/ops/THREAT-MODEL.md` (thêm cột Quyết định, cập nhật Trạng thái theo task đã `[x]`, frontmatter `updated`, duyệt). Gate: `! grep -E '^\| T-[0-9]+ ' docs/ops/THREAT-MODEL.md | grep -vqE 'mitigate|eliminate|transfer|accept'` + `grep -q '^updated:' docs/ops/THREAT-MODEL.md`.
5. **T-af: Tài liệu/ kiểm spec** — WF-SDD-001/002/003. Files: `docs/specs/SPEC-*.md` (thêm `approved_by`/`approved_at`), `scripts/check-specs.mjs` (liệt kê spec thiếu trường; đối chiếu ID `S-NNN`/`AT-NN` ↔ test), nối vào `pnpm lint` hoặc CI. Gate: `node scripts/check-specs.mjs`.
6. **T-ag: CODEOWNERS + đường dẫn rủi ro** — WF-REVIEW-007. Files: `.github/CODEOWNERS` (auth/payment/migration/.github/hook/ruleset/PII), `xt.yaml` `merge_risk_paths` (chạm cấu hình cổng: nêu lý do, PR riêng). Gate: `test -f .github/CODEOWNERS && grep -q merge_risk_paths xt.yaml` + `python3 .xtemplates/scripts/xt.py merge-check` trên PR thử.

Task trung bình:
7. **T-ah: Log bảo mật có cấu trúc + che bí mật** — SEC-LOG-001/002, SEC-SECRET-007. Files: `docs/security/security-events.md`, `apps/backend/src/lib/log/` (schema, `redactLog`, logger bọc), test jest unit (log object chứa `password`/`token` → `[REDACTED]`, validate schema), thêm cột/ghi `outcome`/`user_agent` cần migration mới (không sửa migration cũ). Gate: `pnpm --filter @x-shop/backend test`.
8. **T-ai: AppSec trong CI** — SEC-WEB-001 (CodeQL/Semgrep `js/sql-injection` + allowlist `knex.raw`), SEC-WEB-004 (allowlist 3 điểm JSON-LD + rule lint, trùng FE-SEC-001 lô 2), SEC-SUPPLY-006 (workflow `osv-scanner` PR + lịch tuần, `osv-scanner.toml`, dependabot `npm`). Chạm CI: PR riêng. Gate: `python3 .xtemplates/scripts/xt.py ci-check && test -f osv-scanner.toml` + lint.
9. **T-aj: Coverage** — QA-COV-001/002/004. Files: `apps/storefront/vitest.config.ts` + `apps/backend/jest.config.js` (coverage nhánh + ngưỡng), `package.json` `test:coverage`, CI lưu artifact `coverage/`, `eslint.config.mjs` thêm `expect-expect` (eslint-plugin-vitest). Không hạ ngưỡng sẵn có. Gate: `pnpm -r --if-present test:coverage && pnpm lint`.
10. **T-ak: Tham số vòng lặp + tối ưu** — LOOP-CTX-002, LOOP-DESIGN-001, LOOP-HARNESS-003 (ghi số ngân sách/hạn chót vào PLAN.md `loop init --hours H`; sửa PLAN là việc phiên chính), LOOP-OPT-001..004 (viết lại T-060: mục tiêu số, Gate `perf compare` + `perf guard --locked`, PERF-LOG.md). Gate: `python3 .xtemplates/scripts/xt.py loop status` + `grep -q "perf compare" docs/autopilot/PLAN.md`.
11. **T-al: Release tự động** — WF-REL-001/003 (có thể làm trước hạ tầng): workflow release-please/changesets, ruleset tag `v*`. Chạm CI. Gate: `test -f .github/workflows/release.yml && python3 .xtemplates/scripts/xt.py ci-check`.

Việc chờ người / hạ tầng:
12. **Chủ repo bật ruleset sống** (`enforcement: active`) — WF-GIT-001/002, WF-REVIEW-005. Gate (người chạy): `gh api repos/seeker19110/x-shop/rules/branches/master` chứa `pull_request`, `required_status_checks`, `deletion`, `non_fast_forward`. Không có quyền agent.
13. **Chờ chọn hạ tầng production** — WF-ENV-006/008/012, WF-REL-007 (smoke sau deploy), SEC-INFRA-001/002/003/010, SEC-LOG-006, SEC-SECRET-005. Cần quyết hạ tầng trước (PROJECT.md "Khi chạy thật").
14. **E2E trong CI** — LOOP-HARNESS-008: áp `docs/ops/patches/T-048-ci-e2e.patch` (chạm `xt.yaml`/CI, chờ người) để `e2e: "pnpm e2e"`.

Toàn bộ 50 mục mở (đều MUST): WF-REVIEW-002/005/007 · WF-DOC-001/002/008 · WF-ENV-006/008/010/012 · WF-GIT-001/002 · WF-REL-001/003/004/007 ·
WF-SDD-001/002/003 · WF-TEAM-003/004 · LOOP-CTX-002/006 · LOOP-HARNESS-003/008 · LOOP-DESIGN-001/003 · LOOP-OPT-001/002/003/004 · LOOP-ORCH-004 ·
SEC-WEB-001/004 · SEC-INFRA-001/002/003/010 · SEC-LOG-001/002/006 · SEC-SECRET-005/007/011 · SEC-SUPPLY-006 · SEC-TM-005/006 · QA-COV-001/002/004.

## Câu hỏi mở (phiên chính quyết — `xt.py loop decide`)

1. **Bằng chứng `.autopilot/` (LOOP-DESIGN-003, LOOP-ORCH-004, LOOP-CTX-002/DESIGN-001):** `.autopilot/` bị gitignore nên lệnh `— Kiểm:` đọc evidence/state chỉ xanh ở checkout chính (58 evidence = 58 task `[x]`), đỏ ở clone/worktree sạch.
   Phương án: (a) chấp nhận kiểm chỉ ở checkout chính, tick bằng `— Bằng chứng:` (file cục bộ); (b) xuất tóm tắt evidence (task, cmd, exit_code, sha) vào file commit được (vd `docs/autopilot/EVIDENCE.md` do `loop record` sinh) rồi kiểm bằng grep; (c) giữ mở tới khi khung hỗ trợ.
2. **"4 con số" ở chế độ `--single-session` (LOOP-HARNESS-003, LOOP-DESIGN-001, LOOP-CTX-002):** ngân sách "trong ngân sách token của phiên" và hạn chót "không đặt" có đủ không? Phương án: (a) cách hiểu chặt — đặt số cụ thể (`--hours`, ngân sách USD/token) và ghi PLAN; (b) coi single-session (ADR-0009) đủ, đổi tick sang `[~] — Miễn:` kèm duyệt của chủ dự án.
3. **ID tiêu chí chấp nhận (WF-SDD-002/003):** spec dùng `S-NNN` + `AT-NN`, framework gọi `AC-xx`. Phương án: (a) chấp nhận `S-NNN`/`AT-NN` và viết script đối chiếu theo tên đó (rẻ, không đổi spec); (b) đổi nhãn sang `AC-` ở 6 spec + test (tốn, phá tham chiếu `AT` của đặc tả gốc).
4. **WF-TEAM-007 đánh `[~]` theo giả định dự án một người + agent** (repo cá nhân `seeker19110`; `gh api …/collaborators` bị proxy chặn nên không đếm được). Chủ dự án xác nhận hoặc đổi lại `[ ]`.
5. **LOOP-CTX-006 (phiên mới chỉ với AGENTS.md + PROGRESS.md):** chỉ kiểm được bằng phiên thật. Phương án: (a) chạy một phiên thử và ghi file bằng chứng (`docs/ops/` hoặc PROGRESS) rồi tick `— Bằng chứng:`; (b) giữ mở.

## Ngoài phạm vi phát hiện

- `merge-gate.yml` là stub D-122, chờ chủ repo gỡ context khỏi ruleset sống rồi T-1834 xoá (đã ghi trong file).
- `BLUEPRINT.md` / `BLUEPRINT-BACKLOG.md` có link nội bộ hỏng (WF-DOC-002) — ngoài dải 499–708 nên không sửa ở lô này.
