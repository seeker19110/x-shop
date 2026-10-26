# Chính sách bảo mật

## Báo cáo lỗ hổng

Vui lòng báo lỗ hổng **riêng tư**, không mở issue công khai và không đăng chi tiết lên nơi công cộng trước khi được sửa.

- Email: lienhe@donghanhcungban.org (tiêu đề bắt đầu bằng `[SECURITY]`).
- Nội dung nên có: thành phần bị ảnh hưởng, các bước tái hiện, tác động dự kiến, phiên bản/commit. Không gửi dữ liệu người
  dùng thật hay bí mật thật; nếu đã vô tình gặp dữ liệu như vậy, hãy dừng và báo ngay.
- Kênh dự phòng: GitHub Private Vulnerability Reporting (tab Security của kho). **Chưa bật** — chờ chủ dự án bật; cho đến
  lúc đó dùng email ở trên.

## Cam kết phản hồi

- Xác nhận đã nhận báo cáo trong **≤ 14 ngày** (mục tiêu 3 ngày làm việc).
- Thông báo kết quả đánh giá ban đầu và kế hoạch sửa; sửa lỗi nghiêm trọng ưu tiên trước mọi việc khác.
- Ghi công người báo (nếu đồng ý) trong mục `Security` của [CHANGELOG](CHANGELOG.md) khi bản vá phát hành.

## Phạm vi và phiên bản được hỗ trợ

Chỉ nhánh mặc định (`master`) và bản phát hành mới nhất được vá. Phạm vi gồm mã trong kho này (`packages/`, `apps/`,
`scripts/`, workflow CI). Dịch vụ bên thứ ba (VNPAY, GHN, hạ tầng lưu trữ) báo cho nhà cung cấp tương ứng.

Mô hình đe doạ: [`docs/ops/THREAT-MODEL.md`](docs/ops/THREAT-MODEL.md). Thông tin liên hệ máy đọc được:
[`/.well-known/security.txt`](apps/storefront/public/.well-known/security.txt).
