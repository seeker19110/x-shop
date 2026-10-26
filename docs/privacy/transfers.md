# Chuyển dữ liệu cá nhân ra nước ngoài — x-shop

> Cập nhật 2026-10-26. Hiện trạng: **chưa xác định** có chuyển ra nước ngoài hay không. Nghĩa vụ lập hồ sơ đánh giá tác động chuyển dữ liệu theo
> Luật 91/2025/QH15 và NĐ 356/2025/NĐ-CP: (chưa xác minh) — chưa đối chiếu văn bản gốc (PROJECT.md §6, DPIA §9).

| Luồng                  | Bên nhận           | Dữ liệu                                                                                                   | Nơi xử lý                         | Căn cứ/hồ sơ | Trạng thái                |
| ---------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------ | ------------------------- |
| Thanh toán             | VNPAY              | mã giao dịch, số tiền, IP khách                                                                           | (chưa xác minh)                   | chưa có      | chưa xác định             |
| Vận chuyển             | GHN                | họ tên, SĐT, địa chỉ, COD                                                                                 | (chưa xác minh)                   | chưa có      | chưa xác định             |
| Thông báo email/SMS    | chưa chọn          | SĐT/email, nội dung giao dịch                                                                             | chưa xác định                     | chưa có      | chờ chọn nhà cung cấp     |
| Lưu trữ/xử lý hệ thống | chưa chọn hạ tầng  | toàn bộ dữ liệu                                                                                           | chưa xác định                     | chưa có      | chờ chọn hạ tầng          |
| Công cụ phát triển/CI  | dịch vụ CI của repo | không có dữ liệu cá nhân thật (dev/CI chỉ dùng dữ liệu tổng hợp — PROJECT.md §6 "Dữ liệu test")           | ngoài Việt Nam (chưa xác minh)    | n/a          | không chuyển dữ liệu cá nhân |

## Quy tắc

- Không bật nhà cung cấp/hạ tầng đặt ngoài Việt Nam khi chưa có dòng ở bảng trên với căn cứ và hồ sơ (CMP-INTL-*).
- Mỗi dòng mới: cập nhật `docs/compliance/vendors.yaml` (`location`), `docs/privacy/processors.md` và `docs/privacy/CHANGELOG.md`.
- Chủ dự án/pháp chế xác nhận nghĩa vụ hồ sơ trước G7.
