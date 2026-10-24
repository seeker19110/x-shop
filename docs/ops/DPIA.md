# DPIA — Đánh giá tác động xử lý dữ liệu cá nhân · x-shop · nháp 0.1 · 2026-10-24

> Căn cứ: Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 và Nghị định 356/2025/NĐ-CP (hiệu lực 01/01/2026 — nguồn thứ cấp,
> `docs/research/2026-10-24-stack.md` mục 9; **chủ dự án/người phụ trách pháp lý phải đối chiếu văn bản gốc trước ra mắt**).
> Tài liệu kỹ thuật này không thay ý kiến pháp lý. Hoàn tất ở T-038.

## 1. Hoạt động xử lý
| Mục đích | Dữ liệu | Cơ sở | Nơi lưu | Thời hạn (mặc định, cấu hình được) | Bên nhận |
|---|---|---|---|---|---|
| Giao kết và thực hiện đơn hàng | họ tên, SĐT, email (tùy chọn), địa chỉ giao | thực hiện hợp đồng | Postgres (order snapshot) | theo nghĩa vụ chứng từ kế toán — chủ dự án xác nhận | GHN (tên, SĐT, địa chỉ, COD) |
| Thanh toán online | mã đơn, số tiền, IP | thực hiện hợp đồng | Postgres (payment_attempt, ledger) | như trên | VNPAY (không gửi PII ngoài IP/thông tin đơn) |
| Thông báo giao dịch | SĐT/email | thực hiện hợp đồng | outbox | 90 ngày cho bản ghi gửi | nhà cung cấp email/SMS (chưa chọn) |
| Đổi trả, CSKH | ảnh đổi trả, lý do | thực hiện hợp đồng | object storage vùng riêng | 1 năm sau đóng yêu cầu | — |
| Marketing | email/SĐT | **đồng ý riêng, không tick sẵn** | consent table có policy version | đến khi rút | — |
| Đo lường sản phẩm | sự kiện không PII (item id, value) | lợi ích hợp pháp / đồng ý theo cấu hình | analytics | 14 tháng | — |
| Vận hành/an ninh | log đã che PII, audit admin | nghĩa vụ an ninh | log store | 90 ngày log, audit theo chính sách | — |

## 2. Nguyên tắc kỹ thuật (bắt buộc, có test)
- Thu tối thiểu: email tùy chọn khi có SĐT (D-002); không thu ngày sinh/giới tính ở P0.
- Không tạo tài khoản hay gộp lịch sử chỉ vì email trùng; không tiết lộ email đã có tài khoản (AT19).
- Tra cứu đơn: mã đơn + SĐT không đủ để xem PII đầy đủ; link/OTP ngắn hạn, token rời URL (POST01, AT20).
- PII không vào log, URL analytics, error report; sự kiện analytics không PII (AT29).
- Trang/API riêng tư `private, no-store`; service worker không cache (AT22).
- Admin: vai trò CSKH xem dữ liệu đã che; xuất dữ liệu hàng loạt cần quyền riêng + audit.
- Xóa theo yêu cầu: ẩn danh hóa dữ liệu không thuộc chứng từ; chứng từ giữ theo nghĩa vụ.

## 3. Rủi ro và biện pháp
| Rủi ro | Khả năng | Mức | Biện pháp | Liên kết |
|---|---|---|---|---|
| Lộ đơn của khách khác (IDOR) | Trung | Cao | sở hữu ở server, 404, rate limit | THREAT-MODEL T-06 |
| PII qua cache dùng chung | Thấp | Cao | no-store, test AT22 | T-07 |
| Nhân viên xuất PII | Trung | Trung | RBAC, che dữ liệu, audit | T-09, T-16 |
| Gửi dữ liệu cho bên thứ ba vượt cần | Thấp | Trung | adapter chỉ gửi trường cần; DPA với GHN/VNPAY/email (chủ dự án) | — |

## 4. Việc chờ chủ dự án
- Xác nhận thời hạn lưu chứng từ, thủ tục thông báo/đăng ký theo mô hình kinh doanh, ký DPA với bên xử lý.
- Chính sách quyền riêng tư công khai (`/bao-mat`) — nội dung do chủ shop duyệt.
