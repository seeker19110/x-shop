# Bên xử lý và bên nhận dữ liệu cá nhân — x-shop

> Cập nhật 2026-10-26. Nguồn máy đọc: `docs/compliance/vendors.yaml` (id, dữ liệu chạm, DPA, hạn rà soát); cột/bảng chạm tới:
> `docs/privacy/data-map.yaml` (`recipients`). Kiểm: `node scripts/check-data-map.mjs`. Mọi thông tin hợp đồng/pháp lý chưa có ghi rõ "chưa có"
> hoặc "(chưa xác minh)" — không suy đoán.

| Bên                                      | Vai trò                            | Dữ liệu cá nhân nhận                                                                                                                                                     | Trạng thái hợp đồng/DPA                                                                                         | Vị trí xử lý    |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------- |
| VNPAY (`vnpay`)                          | cổng thanh toán; bên nhận/xử lý    | mã giao dịch, số tiền, mã đơn, **IP khách** (`vnp_IpAddr`); không nhận tên/SĐT/email/địa chỉ (`packages/domain/src/providers/vnpay/vnpay.ts`)                            | chưa có hợp đồng merchant/DPA                                                                                   | (chưa xác minh) |
| GHN (`ghn`)                              | vận chuyển; bên nhận/xử lý         | họ tên, SĐT, địa chỉ giao, giá trị COD (`packages/domain/src/providers/ghn/`, `apps/backend/src/lib/shipping/`)                                                          | chưa có hợp đồng/DPA                                                                                            | (chưa xác minh) |
| Nhà cung cấp email/SMS (`notify-provider`) | gửi thông báo giao dịch          | SĐT hoặc email + nội dung thông báo (mã đơn, liên kết tra cứu một lần 15 phút)                                                                                           | **chưa chọn**; hiện chỉ adapter `log` (`apps/backend/src/lib/notify/adapters.ts`), không gửi thật               | chưa xác định   |
| Hạ tầng triển khai (`hosting`)           | lưu trữ và chạy hệ thống           | toàn bộ dữ liệu (xem data-map)                                                                                                                                           | **chưa chọn** (RUNBOOK §8.1)                                                                                    | chưa xác định   |

## Dữ liệu từng bên nhận (theo cột)

Lấy từ `recipients` trong `docs/privacy/data-map.yaml`: `order_finance.contact` → GHN, nhà cung cấp thông báo · `order_finance.address` → GHN ·
`checkout_quote.address` → GHN (tính phí) · `shipment.label_url` → GHN · `webhook_inbox.payload`, `payment_attempt.payment_url` → VNPAY.
Hạ tầng triển khai chạm mọi cột nhưng chưa được chọn nên không đứng trong `recipients`; khi chọn, thêm vào vendors.yaml và ghi ở đây.

## Quy trình thay đổi bên xử lý

1. Thêm/đổi nhà cung cấp hoặc SDK của họ: thêm dòng vào `docs/compliance/vendors.yaml` (kèm `packages` nếu có SDK) TRƯỚC khi merge; script
   `scripts/check-data-map.mjs` chặn SDK dịch vụ chưa khai (mẫu tên trong `SERVICE_SDK_PATTERNS`).
2. Cập nhật cột `recipients` trong data-map nếu bên đó nhận thêm cột PII; cập nhật `docs/privacy/transfers.md` nếu xử lý ngoài Việt Nam.
3. Ghi `docs/privacy/CHANGELOG.md`. Thông báo thay đổi sub-processor cho chủ thể/đối tác theo hợp đồng và luật (nghĩa vụ cụ thể: chưa xác minh).
4. Rà soát mỗi nhà cung cấp ≤ 12 tháng (`reviewed_on`); script cảnh báo khi quá hạn.

## Việc chờ chủ dự án

Ký hợp đồng/DPA với VNPAY, GHN; chọn nhà cung cấp email/SMS và hạ tầng; điền vị trí xử lý, chứng chỉ, kết quả đánh giá rủi ro (DPIA §9 mục 4).
