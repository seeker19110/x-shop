<!-- Mẫu nâng MAJOR (OPS-MAINT-005, P8). Mở bằng `?template=major-upgrade.md`. Tiêu đề: `build(deps): nâng <gói> lên <x.y.z>`.
Một PR = một phụ thuộc major; KHÔNG gộp với tính năng/sửa lỗi khác. Gắn nhãn `major`. Mục không áp dụng ghi "không áp dụng — lý do". -->

## Phụ thuộc
<!-- `tên · từ phiên bản → đến phiên bản · giấy phép (đổi không?) · link changelog/migration guide` -->

## Tóm tắt breaking change (đã đọc changelog/migration guide)
<!-- Tự tóm tắt, không dán nguyên văn: API bỏ/đổi, mặc định đổi, yêu cầu runtime (Node/Postgres/…) mới. -->

## Codemod / thay đổi mã
<!-- Codemod chính thức (lệnh + kết quả) nếu có; không có thì ghi "không có". Liệt kê vùng mã bị ảnh hưởng. -->

## Bằng chứng
- [ ] `.xtemplates/scripts/dev-task.sh gate` xanh — kết quả:
- [ ] Toàn bộ test (đơn vị, tích hợp) xanh — link CI:
- [ ] E2E xanh (`pnpm e2e`) — link CI:
- [ ] Không có cảnh báo deprecated mới trong build/test (hoặc đã ghi lại) — bằng chứng:

## Triển khai và đường lùi
- [ ] Triển khai qua canary/cờ tính năng (hoặc "không áp dụng — lý do"):
- [ ] Đường lùi: revert PR + phiên bản lockfile cũ; migration dữ liệu (nếu có) có bước lùi — mô tả:
- [ ] Theo dõi sau triển khai (chỉ số/log cần xem, thời gian quan sát):

## Rủi ro
<!-- Chạm tiền · dữ liệu người dùng thật · auth · mật mã: gắn nhãn `risk:*`. -->

## Phụ thuộc mới (bắt buộc kể cả khi nâng major kéo gói mới)
<!-- `tên · phiên bản ghim · giấy phép · lý do · phương án thay thế đã xét`; không có thì ghi "không có". -->
