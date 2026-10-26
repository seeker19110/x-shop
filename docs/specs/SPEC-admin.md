# SPEC-admin — Vai trò, quyền, MFA, audit, báo cáo

| Trường | Giá trị |
|---|---|
| ID tính năng | F-010 (yêu cầu gốc: §5.4–5.5, ADM04, SEC02, INV03, AT21) |
| Trạng thái | Approved for implementation (D-001) |
| approved_by | Phiên chính, tự duyệt theo AGENTS.md §5 (D-001) |
| approved_at | 2026-10-24 |

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

## 3. Ca biên
| Nhóm | Ca | Hành vi | Scenario |
|---|---|---|---|
| Rỗng/null | audit log không có bản ghi khớp bộ lọc; báo cáo ngoại lệ không có ngoại lệ | trả danh sách rỗng `count: 0`, không lỗi | S-405, S-406 |
| Cực đại | `limit` audit > 100; `limit` < 1 | `limit` trong [1, 100], mặc định 50; ngoài khoảng bị schema zod từ chối | S-405 |
| Trùng/idempotency | gửi lại tạo hoàn tiền/điều chỉnh tồn với cùng `Idempotency-Key` | 200 bản cũ; khác nội dung → 409 | S-403, S-404 |
| Song song | hai người hoàn tiền cùng đơn; thu hồi vai trò đồng thời | tổng hoàn ≤ tổng đã thu kể cả yêu cầu đang xử lý; không thu hồi `owner` cuối cùng (409 `LAST_OWNER`) | S-403 |
| Mất mạng giữa chừng | TOTP/đăng nhập lại bị ngắt, client gửi lại thao tác nhạy cảm | cùng `Idempotency-Key` → một bản ghi; thiếu xác thực lại → 403 `REAUTH_REQUIRED` | S-402, S-403 |
| Thời gian/múi giờ | phiên quá 8 giờ hoặc idle quá 30 phút; xác thực lại cũ hơn 5 phút | 401/403 (`SESSION_EXPIRED`, `SESSION_IDLE`, `REAUTH_REQUIRED`); mốc tính bằng UTC, cấu hình ở `ADMIN_SESSION_MAX_AGE_SECONDS`, `ADMIN_SESSION_IDLE_SECONDS`, `ADMIN_REAUTH_MAX_AGE_SECONDS` | S-402 |
| Quyền | vai trò thiếu quyền; thử quá nhiều lần | 403 problem+json + audit ghi từ chối (gộp theo lớp route, đổi id không lách được giới hạn); 429 `RATE_LIMITED` | S-401 |
| Tiền/đơn vị | hoàn tiền vượt ngưỡng; điều chỉnh tồn xuống dưới số đã giữ | cần người duyệt thứ hai khác người tạo; từ chối, tồn không giảm dưới `reserved` | S-403, S-404 |

## Ma trận vai trò (đặc tả §5.4)
| Vai trò | Quyền chính |
|---|---|
| owner | `*` |
| catalog_manager | `catalog.*`, `content.*`, `price.write` |
| order_staff | `order.read`, `order.confirm`, `fulfillment.*` |
| warehouse | `inventory.*`, `return.receive`, `return.inspect` |
| support | `order.read_masked`, `return.request`, `refund.request` |
| accountant | `payment.read`, `refund.*`, `settlement.*`, `report.read` |
