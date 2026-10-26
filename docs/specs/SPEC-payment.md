# SPEC-payment — COD, VNPAY, ledger, IPN, hoàn tiền

| Trường | Giá trị |
|---|---|
| ID tính năng | F-007 (yêu cầu gốc: §6.1–6.2, §9.2, AT06–09, AT11, AT16, AT18, AT24, AT35, AT36) |
| Trạng thái | Approved for implementation (D-001) |
| approved_by | Phiên chính, tự duyệt theo AGENTS.md §5 (D-001) |
| approved_at | 2026-10-24 |
| Nguồn | `docs/specs/DAC-TA-GOC.md` §6, §9.2; protocol VNPAY xác minh ở `docs/research/2026-10-24-stack.md` |

## 1. User story
Là khách, tôi trả tiền qua VNPAY và chỉ thấy "đã thanh toán" khi server đã xác minh; là kế toán, tôi thấy mọi khoản
thu/hoàn đúng một lần.

## 2. Tiêu chí chấp nhận
### S-101 IPN hợp lệ xác nhận chính đơn đã có (§6.2 bước 6–7, AT35)
- Given đơn `awaiting_payment`, payment attempt `pending` ref R, số tiền A
- When IPN GET có chữ ký đúng, `vnp_TxnRef=R`, `vnp_Amount=A×100`, `vnp_ResponseCode=00`, `vnp_TransactionStatus=00`
- Then ledger ghi 1 bút toán `capture` A; đơn `confirmed`; `order_id` và số reservation không đổi; phản hồi `{"RspCode":"00","Message":"Confirm Success"}`.

### S-102 IPN lặp 20 lần (AT06)
- Then đúng 1 bút toán; lần 2+ phản hồi `{"RspCode":"02","Message":"Order already confirmed"}`; không thêm email/đơn/refund.

### S-103 Chữ ký sai / số tiền sai (AT07)
- Then chữ ký sai → `97`; số tiền sai → `04`; không ghi paid; ghi webhook inbox `rejected` + audit + cảnh báo.

### S-104 Redirect trước IPN (AT08, AT24)
- Given browser về `return_url` với tham số "thành công", chưa có IPN
- Then trang hiển thị "Đang xác nhận thanh toán", nút "Kiểm tra lại" gọi status (server có thể `querydr`); không đổi trạng thái tiền từ URL browser.

### S-105 Tiền đến sau khi đơn hủy (AT09)
- Then ledger ghi capture; mở ngoại lệ `late_payment` cho hoàn tiền/CSKH; đơn giữ `cancelled`, không giao, không tự đổi SKU.

### S-106 Hai giao dịch thật cùng thành công (AT36)
- Then ledger có 2 capture; đơn xác nhận 1 lần, 1 quyền fulfillment; ngoại lệ `overpayment` với số dư = tổng thu − tổng phải trả.

### S-107 Timeout (AT11)
- Given gọi provider timeout
- Then attempt `unknown`; truy vấn cùng reference trước khi tạo attempt mới; không gửi giao dịch trùng.

### S-108 Hoàn tiền (AT16, §6.5)
- Then `Σ refund succeeded + Σ refund đang xử lý ≤ Σ captured hợp lệ` (khóa theo payment); retry dùng cùng refund id; timeout → `unknown` rồi query.

### S-109 Thông báo lỗi không mất đơn (AT18)
- Then email/SMS qua outbox có message key; lỗi gửi chỉ retry thông báo, đơn giữ nguyên.

## 3. Ca biên
| Nhóm | Ca | Hành vi |
|---|---|---|
| Rỗng/null | thiếu `vnp_SecureHash` | `97` |
| Cực đại | tham số lạ/dài | bỏ qua khi tính chữ ký theo protocol (chỉ `vnp_*`), giới hạn kích thước query |
| Trùng | IPN lặp; event key = ref + `vnp_TransactionNo` + status | dedupe ở inbox; UNIQUE `(provider, provider_txn_id, kind)` ở ledger |
| Song song | IPN ∥ expiry | S-006 của SPEC-checkout |
| Mất mạng | không có IPN | job reconcile `querydr` attempt `pending` quá hạn |
| Thời gian | `vnp_CreateDate`/`vnp_ExpireDate` theo giờ VN (GMT+7) | chuyển từ UTC có test biên |
| Quyền | IPN từ IP lạ | xác minh chữ ký là bắt buộc; allowlist IP là lớp thêm (cấu hình) |
| Tiền | `vnp_Amount` = VND × 100 | so khớp số nguyên tuyệt đối |

## 4. Quyết định
- Trạng thái tài chính đơn điệu: không lùi từ `captured` về `pending` (D-003).
- Dev/CI dùng `MockVnpayServer` cùng thuật toán chữ ký; sandbox thật khi có khoá (RK-006).
