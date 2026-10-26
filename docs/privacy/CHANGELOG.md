# CHANGELOG — hồ sơ quyền riêng tư

Mỗi lần đổi sổ dữ liệu (`data-map.yaml`, `data-inventory.csv`), bên xử lý, chuyển dữ liệu hoặc DPIA: thêm mục `## YYYY-MM-DD` ở đầu.
`node scripts/check-data-map.mjs` cảnh báo khi mục mới nhất quá 183 ngày (nhịp rà 6 tháng; mốc luật cụ thể: chưa xác minh).

## 2026-10-26

- T-091: `audit_log` thêm `user_agent` (PII cơ bản — cắt ≤ 256 ký tự, che email/SĐT lẫn trong chuỗi) và `outcome` (không PII); `resource_id` chuyển sang PII cơ bản (có thể là id khách/nhân viên hoặc bí danh HMAC `idh_…` của email đăng nhập). Danh mục sự kiện: `docs/security/security-events.md`.
- Tạo sổ dữ liệu theo bảng/cột: `docs/privacy/data-map.yaml`, `docs/compliance/data-inventory.csv` (51 cột PII), đối chiếu máy với migration bằng `scripts/check-data-map.mjs`.
- Tạo `docs/privacy/processors.md`, `docs/privacy/transfers.md`, `docs/compliance/vendors.yaml` (VNPAY, GHN, nhà cung cấp email/SMS và hạ tầng — hai bên sau chưa chọn).
- Sửa DPIA §1/§5 cho khớp mã: `payment_attempt.payment_url` lưu `vnp_IpAddr` (IP thô); bản sao PII ở đơn Medusa native; token liên kết tra cứu nằm ở URL, token phiên đơn nằm ở header.
- Thời hạn lưu: các lớp đề xuất trong `retention_classes`; pháp chế xác nhận trước G7 (PLAN-2 Q-20).
