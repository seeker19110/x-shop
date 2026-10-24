# SPEC-admin — Vai trò, quyền, MFA, audit, báo cáo

| Trường | Giá trị |
|---|---|
| ID tính năng | F-010 (yêu cầu gốc: §5.4–5.5, ADM04, SEC02, INV03, AT21) |
| Trạng thái | Approved for implementation (D-001) |

## 2. Tiêu chí chấp nhận
### S-401 Quyền ở API (AT21)
- Given user vai trò `warehouse`
- When gọi trực tiếp `POST /admin/x/refunds`
- Then `403` problem+json; audit ghi lần bị từ chối.
- Ma trận quyền là dữ liệu (`role → permission[]`); test sinh tự động phủ mọi route `/admin/x/*` × 6 vai trò.

### S-402 MFA (SEC02)
- Then admin phải bật TOTP trước khi dùng route nhạy cảm; phiên hết hạn (8 giờ, idle 30 phút); thao tác nhạy cảm (đổi quyền, hoàn tiền vượt ngưỡng) đòi xác thực lại ≤ 5 phút.

### S-403 Hoàn tiền vượt ngưỡng
- Then cần người thứ hai có quyền `refund.approve`, khác người tạo.

### S-404 Điều chỉnh tồn (INV03)
- Then bắt buộc lý do, actor, trước/sau, idempotency key; không giảm dưới số đã giữ.

### S-405 Audit log
- Then lưu actor, thời điểm, hành động, đối tượng, lý do, thay đổi đã che PII; chỉ append.

### S-406 Báo cáo/ngoại lệ (§5.5)
- Then đơn theo trạng thái; giá trị đơn vs tiền đã thu vs COD phải nhận tách riêng; danh sách ngoại lệ (late_payment, overpayment, payment unknown, refund unknown, webhook rejected, COD chưa đối soát) có owner/ưu tiên/tuổi.

## Ma trận vai trò (đặc tả §5.4)
| Vai trò | Quyền chính |
|---|---|
| owner | `*` |
| catalog_manager | `catalog.*`, `content.*`, `price.write` |
| order_staff | `order.read`, `order.confirm`, `fulfillment.*` |
| warehouse | `inventory.*`, `return.receive`, `return.inspect` |
| support | `order.read_masked`, `return.request`, `refund.request` |
| accountant | `payment.read`, `refund.*`, `settlement.*`, `report.read` |
