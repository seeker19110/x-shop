# PROGRESS.md — x-shop (webapp shop thời trang)

## Đang làm
- Đợt 3 PLAN-2 (mục L, D-129) trên nhánh `claude/festive-wozniak-fwg3eg`, PR #20 đang mở, chờ chủ dự án merge. Các task agent tự làm được trong PR này đã xong, chỉ còn `T-239`.
- `T-239`: nâng baseline coverage tích hợp (D-162 → D-163). Chỉ nâng khi có ≥ 2 mẫu CI (job `integration-coverage-merge`) trên cùng tree code. Tính từ số dòng/nhánh và ghi SHA. Gate của task ở `docs/autopilot/PLAN-2.md`, yêu cầu ≥ 93,75/83,65. Không ép baseline cho khớp Gate: mẫu không đủ biên thì để mở.

## Tiếp theo
1. `T-239`: lấy coverage của 2 lần chạy CI trên `218d408` (một lần chạy + một lần rerun). Baseline = min − độ lệch quan sát, làm tròn xuống. Đủ ngưỡng Gate thì commit `coverage-baseline.json`, `loop record`. Không đủ thì `loop defer`.
2. Sau khi PR #20 merge, cắt lại nhánh làm việc từ master, mỗi lát một PR, có người rà:
   - `T-186` migration bigint cột tiền (D-140, có sẵn 3 commit ở nhánh riêng);
   - `T-203` consent → `T-204` thời hạn lưu → `T-205` DSAR (D-158, PII, merge cần người);
   - `T-060` PDP p95 ≤ 300 ms.

   Các task này đang ở trạng thái `loop defer`.
3. Chờ người, không tự làm:
   - T-068/T-108/T-113/T-129: sửa `xt.yaml`;
   - T-130: xem migration không đảo ngược rồi áp bản vá; T-123 áp sau T-130;
   - T-105: áp bản vá và duyệt ngoại lệ giấy phép. Các bản vá ở `docs/ops/patches/`;
   - T-145: rà bảo mật đối nghịch các route admin; T-147 ghi `loop record` khi T-145 được tick.

   Xem trạng thái máy: `python3 .xtemplates/scripts/xt.py loop status`.

## Quyết định
- Toàn bộ quyết định ở `docs/autopilot/DECISIONS.md` (D-001…D-163); quyết định kiến trúc ở `docs/adr/`.
- Gần nhất:
  - D-160…D-163: baseline coverage tích hợp 93,7/83,6. Không nâng theo một mẫu hay theo mẫu của tree khác.
  - Hàng rào đỏ giả khi dò rò rỉ: `integration-tests/helpers/leak-probe.ts`. Tầng 1 tách và kiểm định dạng `trace_id`/`span_id` (sai thì ném lỗi). Tầng 2 dò regex phần còn lại. `probeRequestLog` dò cả dòng của ngữ cảnh khác, không bỏ qua dòng nào. Có unit test riêng (`leak-probe.unit.spec`).
- Tiền là số nguyên VND. Logic tiền/tồn/trạng thái chỉ nằm ở `packages/domain` và workflow backend.

## Bàn giao phiên
- Master ở `2993b09`. PR #20 chạy CI bắt buộc `quality` + `gitleaks`.
  - `pr-commits` đỏ do commit cũ đã đẩy có subject dài → cần squash-merge.
  - CodeQL báo nhầm 2 high (`session.ts:75`, `deny-throttle.ts:36`) và 4 medium (`ghn-client.ts:167`, `retry.ts:170`, `scripts/perf/baseline.mjs:380`, `e2e/lb.mjs:67`), chờ chủ dự án dismiss.
- Lệnh kiểm (~70 phút, cần `bash scripts/dev-services.sh start`): `bash .xtemplates/scripts/dev-task.sh gate && pnpm check:ci-local && node scripts/check-commits.mjs origin/claude/festive-wozniak-fwg3eg HEAD`
- Bẫy môi trường:
  - Worktree không có node_modules: dùng `cp -al`, không dùng symlink.
  - Phải gỡ worktree trước khi chạy `check:ci-local`.
  - Hook commit chạy `gate-fast` có trần thời gian, máy tải cao thì bị timeout.
  - Subject commit ≤ 72 ký tự: đếm trước khi commit.
- Cần chủ dự án: merge PR #20 (squash), dismiss CodeQL, xác nhận Redis 7.2 production (D-147), chọn registry/hạ tầng (D-150), dọn `/var/lib/docker`, cấp khoá sandbox VNPAY/GHN.
