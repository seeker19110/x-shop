# Offboarding — mẫu

> Sao chép thành `docs/handover/offboarding-<tên>.md` (không dùng tên thật nhạy cảm trong repo công khai: dùng bí danh/mã nhân sự nếu cần). Mở **trước** ngày rời, hoàn tất **trong ngày rời**.
> Mỗi dòng tick kèm ngày (YYYY-MM-DD) và người xác nhận. Không ghi bí mật vào file này.

| Trường | Giá trị |
| --- | --- |
| Người rời / vai trò | |
| Ngày rời (UTC+7) | |
| Người thực hiện thu hồi | |
| Người xác nhận thứ hai | |

## Danh sách thu hồi (trong ngày rời)

| Dịch vụ | Việc phải làm | Xong (ngày) | Xác nhận |
| --- | --- | --- | --- |
| GitHub | gỡ khỏi tổ chức/kho; thu hồi PAT, SSH key, deploy key, GitHub App của người đó | [ ] | |
| GitHub Actions secrets | xoay `XT_STEWARD_TOKEN`, `GITLEAKS_LICENSE` nếu người đó từng thấy hoặc là chủ token | [ ] | |
| Hạ tầng triển khai / cloud (khi đã chọn) | gỡ IAM/user, khoá API, SSH; thu hồi phiên | [ ] | |
| Postgres, Redis | thu hồi vai trò/mật khẩu cá nhân; xoay mật khẩu dùng chung nếu người đó biết (`DATABASE_URL`, `REDIS_URL`) | [ ] | |
| Kho bí mật (khi đã chọn) | gỡ quyền đọc; xoay mọi bí mật người đó từng đọc (RUNBOOK §9) | [ ] | |
| Admin Medusa | vô hiệu hoá tài khoản, huỷ phiên và TOTP (`apps/backend` RBAC/MFA); kiểm `audit_log` vài ngày gần nhất | [ ] | |
| VNPAY merchant | gỡ khỏi danh sách người dùng cổng; đổi mật khẩu cổng nếu dùng chung; nếu người đó biết `VNPAY_HASH_SECRET` → xoay (RUNBOOK §9–§10) | [ ] | |
| GHN | gỡ quyền; xoay `GHN_TOKEN` nếu người đó biết | [ ] | |
| Email/SMS provider (khi đã chọn) | gỡ quyền; xoay khoá API | [ ] | |
| Tên miền/DNS, CDN, kho ảnh (khi đã có) | gỡ quyền, bật lại khoá chuyển domain nếu đã mở | [ ] | |
| Giám sát/cảnh báo, status page, kênh chat | gỡ khỏi lịch trực và kênh sự cố | [ ] | |
| Thiết bị | xoá bản sao `.env` cục bộ, dữ liệu dự án; xác nhận không có dump production (PROJECT.md §6 cấm) | [ ] | |

## Bàn giao kiến thức

- Việc dang dở và trạng thái: cập nhật `PROGRESS.md`; quyết định chưa ghi: thêm vào `docs/adr/` hoặc `docs/autopilot/DECISIONS.md`.
- Rủi ro người đó biết: ghi vào `docs/RISKS.md`.

## Xác minh sau thu hồi

- `gh api orgs/<org>/members` (hoặc Settings → People) không còn người rời.
- Đăng nhập thử bằng thông tin cũ vào từng dịch vụ trên: bị từ chối.
- Cập nhật `docs/handover/accounts.md` (cột chủ/ngày xoay) và sổ sự cố nếu thu hồi muộn hơn ngày rời (ghi nguyên nhân).
