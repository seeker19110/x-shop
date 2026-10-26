# Chính sách dữ liệu test — x-shop

> Cập nhật 2026-10-26. Bổ sung cho PROJECT.md §6 "Dữ liệu test". Kiểm bằng máy: `node scripts/check-fixtures.mjs` (test: `node --test scripts/check-fixtures.test.mjs`).

## Quy tắc

1. Fixture, seed và test chỉ dùng dữ liệu tổng hợp. Không đưa tên, email, SĐT, CCCD, địa chỉ của người thật; không dump/export từ production.
2. Email dùng miền dành riêng (RFC 2606/6761): `example.test` (khuyến nghị), `example.com|net|org`, hoặc TLD `.test`, `.example`, `.invalid`, `.localhost`.
   Địa chỉ ẩn danh `users.noreply.github.com` được chấp nhận. Không dùng miền thật (kể cả `.vn`) và không dùng `+tag` trên miền thật.
3. Số điện thoại chỉ dùng số mẫu ở bảng dưới (script đọc danh sách từ chính file này: mọi chuỗi 10 số trong dấu backtick). Thêm số mới = sửa file này và nêu lý do trong PR.
4. Không có chuỗi 12 số giống CCCD (`0` + mã tỉnh 001–096 + 9 số).

## Số điện thoại mẫu được phép

Việt Nam chưa có dải số điện thoại dành riêng cho thử nghiệm (chưa xác minh). Vì vậy chỉ cho phép các số có dạng dãy/lặp rõ ràng là giả; không thể bảo đảm tuyệt đối
chưa có thuê bao nào mang số đó, nên **không bao giờ gọi hay nhắn tin thật tới các số này** (adapter gửi thật bị tắt ở dev/CI: `live=false`).

| Số mẫu       | Dùng ở                                                      |
| ------------ | ----------------------------------------------------------- |
| `0912345678` | số khách chính trong test và e2e                            |
| `0987654321` | số khách thứ hai (khác khách chính)                         |
| `0900000000` | seed diễn tập khôi phục (`scripts/ops/drill/seed-before.sql`) |
| `0933222111` | số thứ ba trong test tra cứu đơn                            |
| `0806000000` | test chống liệt kê/giới hạn tần suất (security.spec)        |
| `0212345678` | ca âm: số cố định phải bị từ chối (address, checkout-lib)   |
