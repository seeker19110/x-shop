# PROGRESS.md — x-shop (webapp shop thời trang)

## Đang làm
- Đợt 3 PLAN-2 (mục L, D-129) trên nhánh `claude/festive-wozniak-fwg3eg` — PR #20 (mở, chờ chủ dự án merge). Mọi task agent tự làm được trong PR này đã xong (i18n T-219…T-221 xong).
- `T-236` nâng baseline coverage tích hợp (D-157) — bị chặn: chờ artefact `coverage-integration` của lần CI xanh đầu có T-198 (job `integration-coverage-merge`).

## Tiếp theo
1. `T-236` — tải artefact, `node scripts/coverage-ratchet.mjs --suite integration --update`, commit `coverage-baseline.json`; Gate `node -e "process.exit(require('./coverage-baseline.json').integration.packages['apps/backend'].lines >= 93.5 ? 0 : 1)"`.
2. Sau khi PR #20 merge: cắt lại nhánh làm việc từ master (mỗi lát một PR, người rà): `T-186` migration bigint cột tiền (D-140, 3 commit có sẵn ở nhánh riêng), `T-203` consent → `T-204` thời hạn lưu → `T-205` DSAR (D-158, PII — merge cần người); `T-060` tối ưu PDP p95 ≤ 300 ms (Gate opt-gate tự lấy merge-base, đỏ khi base chưa có opt-gate.sh). Các task này đang ở trạng thái `loop defer`.
3. Chờ người (không tự làm): T-068/T-108/T-113/T-129 (sửa `xt.yaml`), T-130 (người xem migration không đảo ngược rồi áp bản vá) → T-123 (áp sau T-130), T-105 (áp bản vá + duyệt ngoại lệ giấy phép) — bản vá ở `docs/ops/patches/`; T-145 (người rà bảo mật đối nghịch route admin) → T-147 (loop record khi T-145 tick). Trạng thái máy: `python3 .xtemplates/scripts/xt.py loop status`.

## Quyết định
- Toàn bộ ở `docs/autopilot/DECISIONS.md` (D-001…D-159); kiến trúc ở `docs/adr/` (0001 stack … 0008 skipLibCheck backend).
- Gần nhất: D-152…D-155 job `regression` PR fix (đối chiếu từng test case base↔HEAD; đỏ do nạp/hook không tính); D-156 EXPLAIN đường nóng chạy hằng đêm (`perf-nightly.yml`); D-157 coverage tích hợp 8 shard, không đo `src/admin/**` (đã đo ở unit); D-158 PII tách PR sau PR #20; D-159 i18n chỉ chuỗi UI (nội dung CMS, lỗi nội bộ giữ nguyên).
- Tiền = số nguyên VND, logic tiền/tồn/trạng thái chỉ ở `packages/domain` + workflow backend; khoá VNPAY/GHN chỉ ở server, dev/CI dùng mock.

## Bàn giao phiên
- Nhánh chính (master) ở `2993b09`; công việc đợt này nằm ở đầu nhánh `claude/festive-wozniak-fwg3eg` (PR #20, CI bắt buộc `quality` + `gitleaks`). `pr-commits` đỏ do subject dài ở commit cũ đã đẩy → squash-merge; CodeQL còn 2 high báo nhầm (`session.ts:75`, `deny-throttle.ts:36`) + 2 medium báo nhầm (`ghn-client.ts:164`, `retry.ts:167`) chờ chủ dự án dismiss.
- Lệnh kiểm: `bash .xtemplates/scripts/dev-task.sh gate && pnpm check:ci-local && node scripts/check-commits.mjs origin/claude/festive-wozniak-fwg3eg HEAD` (cần `bash scripts/dev-services.sh start`; ~70 phút).
- Bẫy môi trường: worktree trong `.claude/worktrees/` không có node_modules (dùng `cp -al`, không symlink — Turbopack); `check-data-map` quét cả worktree (gỡ worktree trước `check:ci-local`); hook commit chạy `gate-fast` (~10–20 phút khi máy tải) có trần thời gian — máy tải cao thì commit bị timeout.
- Cần chủ dự án: merge PR #20 (squash), dismiss CodeQL, xác nhận Redis 7.2 production (D-147), chọn registry/hạ tầng (D-150), dọn `/var/lib/docker` trên máy agent, khoá sandbox VNPAY/GHN.
