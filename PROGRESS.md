# PROGRESS.md — x-shop (webapp shop thời trang)

## Đang làm
- PR #20 (đợt 2–3 PLAN-2) đã merge vào master (`f1b19e8`, 2026-11-06). Nhánh `claude/festive-wozniak-fwg3eg` cắt lại từ master; lát hiện tại: `T-186` cột tiền bigint (D-140) — 4 migration mới `Migration20261106100000…100300`, check-schema luật MONEY_TYPE, ADR-0007; Gate xanh, chờ review + full gate rồi mở PR (migration → người merge).

## Tiếp theo
1. Mỗi lát một PR cắt từ master, có người rà (sau khi PR T-186 merge):
   - `T-203` consent → `T-204` thời hạn lưu → `T-205` DSAR (D-158, PII, merge cần người);
   - `T-060` PDP p95 ≤ 300 ms.

   Các task này đang ở trạng thái `loop defer`.
2. Chờ người, không tự làm:
   - T-068/T-108/T-113/T-129: sửa `xt.yaml`;
   - T-130: xem migration không đảo ngược rồi áp bản vá; T-123 áp sau T-130;
   - T-105: áp bản vá và duyệt ngoại lệ giấy phép. Các bản vá ở `docs/ops/patches/`;
   - T-145: rà bảo mật đối nghịch các route admin; T-147 ghi `loop record` khi T-145 được tick.

   Xem trạng thái máy: `python3 .xtemplates/scripts/xt.py loop status`.

## Quyết định
- Toàn bộ quyết định ở `docs/autopilot/DECISIONS.md` (D-001…D-167); quyết định kiến trúc ở `docs/adr/`.
- Gần nhất:
  - D-160…D-167: baseline coverage tích hợp 93,75/82,7. `scripts/coverage-merge.mjs` bù mục vắng ở mỗi shard bằng hit của range chứa trong CÙNG shard (gồm range hàm) — hết phủ ảo, số đo không đổi theo cách chia shard. Không nâng theo một mẫu hay theo tree khác.
  - Hàng rào đỏ giả khi dò rò rỉ: `integration-tests/helpers/leak-probe.ts`. Tầng 1 tách và kiểm định dạng `trace_id`/`span_id` (sai thì ném lỗi). Tầng 2 dò regex phần còn lại. `probeRequestLog` dò cả dòng của ngữ cảnh khác, không bỏ qua dòng nào. Có unit test riêng (`leak-probe.unit.spec`).
- Tiền là số nguyên VND. Logic tiền/tồn/trạng thái chỉ nằm ở `packages/domain` và workflow backend.

## Bàn giao phiên
- Master ở `f1b19e8` (PR #20 đã merge; CodeQL báo nhầm đã được chủ dự án dismiss). CI bắt buộc `quality` + `gitleaks`.
- Lệnh kiểm (~70 phút, cần `bash scripts/dev-services.sh start`): `bash .xtemplates/scripts/dev-task.sh gate && pnpm check:ci-local && node scripts/check-commits.mjs origin/master HEAD`
- Bẫy môi trường:
  - Worktree không có node_modules: dùng `cp -al`, không dùng symlink.
  - Phải gỡ worktree trước khi chạy `check:ci-local`.
  - Hook commit chạy `gate-fast` có trần thời gian, máy tải cao thì bị timeout.
  - Subject commit ≤ 72 ký tự: đếm trước khi commit.
- Cần chủ dự án: merge PR T-186 (migration — ngoại lệ cứng), xác nhận Redis 7.2 production (D-147), chọn registry/hạ tầng (D-150), dọn `/var/lib/docker`, cấp khoá sandbox VNPAY/GHN.
