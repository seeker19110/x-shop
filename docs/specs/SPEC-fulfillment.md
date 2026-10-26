# SPEC-fulfillment — Địa chỉ, giao vận GHN, COD, đổi trả, hoàn tiền, đối soát

| Trường | Giá trị |
|---|---|
| ID tính năng | F-008, F-009 (yêu cầu gốc: CHK03, POST01–03, INV01, INV04, §6.3–6.5, AT13–15, AT17, AT20, AT23) |
| Trạng thái | Approved for implementation (D-001) |
| approved_by | Phiên chính, tự duyệt theo AGENTS.md §5 (D-001) |
| approved_at | 2026-10-24 |
| Nguồn | `docs/specs/DAC-TA-GOC.md` §4.5, §5.3, §6.3–6.5, §9.3 |

## 2. Tiêu chí chấp nhận
### S-301 Địa chỉ hai cấp (CHK03, AT23)
- Given danh mục tỉnh/thành → phường/xã hiện hành
- When khách chọn tỉnh, phường/xã, nhập địa chỉ chi tiết
- Then lưu bản gốc + bản chuẩn hóa + mã của hãng trong namespace `ghn:`; không bắt quận/huyện; địa chỉ cũ mơ hồ cần khách xác nhận ánh xạ.

### S-302 COD bằng 0 khi đã trả đủ (AT13)
- Then `cod_amount = max(0, total − Σ captured + Σ refunded)`; phí ship đã thu không tính lại.

### S-303 Tạo vận đơn không trùng (AT11)
- Given tạo vận đơn timeout
- Then tra theo `client_order_code` trước khi gửi lại; 1 shipment/1 fulfillment.

### S-304 Delivered ≠ settled (AT14)
- Then settlement `unsettled` tới khi có batch COD/chứng từ; dashboard thấy số phải thu.

### S-305 Callback giao vận không chữ ký đáng tin
- Then đối chiếu qua API có xác thực trước khi đổi trạng thái có hệ quả tài chính; callback sai thứ tự không làm lùi trạng thái.

### S-306 Trả một phần (AT15)
- Given đơn 2 món 700.000 + 300.000, giảm 100.000 phân bổ 70.000 + 30.000
- When trả món 300.000
- Then hoàn 270.000 (giá thực trả đã phân bổ), món còn lại giữ nguyên.

### S-307 Hàng trả chưa kiểm định (AT17, INV04)
- Then nhận hàng → tồn ở trạng thái `pending_inspection` (location không bán); chỉ khi kiểm định `restock` mới cộng tồn bán; retry không cộng hai lần (khóa theo return line + quantity).

### S-308 Tra cứu đơn (POST01, AT20)
- Then mã đơn + SĐT không đủ xem PII; cần phiên đã đặt hoặc link/OTP ngắn hạn; link đổi thành cookie phiên rồi xóa token khỏi URL; dò ID → 404 + rate limit.

### S-309 Hủy đơn (POST02)
- Then chỉ ở trạng thái cho phép (chưa giao cho hãng); đơn đã trả tiền → mở hoàn tiền không cần chờ hàng trả.

### S-310 Đổi size
- Then tạo đơn thay thế liên kết, không sửa dòng lịch sử đã giao.

## 3. Ca biên
| Nhóm | Ca | Hành vi |
|---|---|---|
| Trùng | callback GHN lặp | dedupe theo (order_code, status, time) |
| Song song | 2 nhân viên cùng tạo vận đơn | khóa đơn; UNIQUE client_order_code |
| Thời gian | callback cũ đến muộn | không lùi trạng thái |
| Quyền | khách trả số lượng > đã giao | 422 |
| Tiền | hoàn > đã thu | chặn (S-108) |
