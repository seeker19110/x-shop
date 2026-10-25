# RUNBOOK — x-shop · nháp 0.1 · 2026-10-24

> Đặc tả §13.2. Hoàn thiện + diễn tập ở T-037 (`scripts/ops/restore-drill.sh`). Mỗi mục: dấu hiệu → kiểm tra → xử lý →
> xác nhận đã ổn. Nguyên tắc: **tiền và tồn đúng quan trọng hơn còn bán được**; mất cơ chế khóa an toàn thì dừng checkout,
> vẫn cho xem catalog.

## 0. Liên lạc và quyền
| Vai trò | Ai | Kênh |
|---|---|---|
| Trực kỹ thuật | [chủ dự án điền] | |
| Kế toán (tiền, hoàn) | [chủ dự án điền] | |
| Liên hệ VNPAY / GHN | theo hợp đồng merchant | |

## 1. Cổng thanh toán lỗi (VNPAY không phản hồi, IPN không về)
- Dấu hiệu: `payment_attempt` ở `pending`/`unknown` tăng; cảnh báo "đã nhận dấu hiệu thanh toán nhưng chưa xử lý > 5 phút".
- Kiểm tra: log `webhook_inbox` (verified, result); job `expire-holds` có chạy; gọi `querydr` thủ công cho vài `txn_ref`.
- Xử lý: KHÔNG hủy hàng loạt đơn `unknown`. Tạm ẩn phương thức VNPAY (cờ cấu hình) để khách chọn COD; giữ endpoint IPN chạy để nhận thông báo đến muộn; đối chiếu `querydr` theo lô khi cổng hồi phục.
- Xác nhận: không còn attempt `unknown` quá hạn chưa có owner trong `ops_exception`.

## 2. Hãng vận chuyển lỗi (GHN)
- Tạo vận đơn timeout → hệ thống tra theo `client_order_code` trước khi tạo lại (không tạo tay vận đơn mới khi chưa tra).
- Callback ngừng: chạy job đồng bộ trạng thái bằng API; không tự đánh dấu "đã giao".

## 3. Redis / worker lỗi
- Mất Redis: Locking Module không khóa được → **dừng tạo đơn** (submit trả 503 có hướng dẫn), catalog vẫn đọc DB. Không bật lại checkout bằng khóa in-memory khi chạy nhiều instance.
- Worker chết: job `reconcile-attempts` khi chạy lại sẽ bù trừ attempt `preparing` quá lease (nhả reservation, hoàn quota mã). Kiểm `ops_exception kind=checkout_stuck`.
- Sau khi Redis trở lại: workflow đang dở trong Redis có thể mất — tạo lại công việc từ bản ghi bền vững (`checkout_attempt`, `outbox_event` `pending`), dedupe tác động ngoài bằng message key/`client_order_code`/`txn_ref`.

## 4. Database outage / khôi phục
- Sao lưu: PITR (RPO ≤ 15 phút) + snapshot hằng ngày, mã hóa, giữ theo chính sách (chủ dự án chọn hạ tầng).
- Khôi phục: dựng DB mới từ PITR → chạy migration tới phiên bản ứng dụng → **đối chiếu giao dịch sau thời điểm khôi phục**: (a) lấy danh sách giao dịch VNPAY từ cổng merchant/`querydr` theo `txn_ref` sinh sau mốc; (b) vận đơn GHN theo `client_order_code`; ghi bổ sung ledger qua đường IPN/query (idempotent), không sửa tay số dư.
- RTO mục tiêu ≤ 2 giờ — chứng minh bằng diễn tập (T-037).

## 5. Triển khai lỗi / rollback
- Rollback ứng dụng không rollback database phá hủy (migration expand/contract). Giữ endpoint IPN/callback chạy ở bản rollback; đối soát giao dịch đang dở sau rollback.
- Không cưỡng ép reload storefront khi khách đang thanh toán (service worker có version, cập nhật ở lần điều hướng sau).

## 6. Ảnh lỗi / CDN
- Ảnh hỏng: storefront vẫn hiển thị alt + khung tỷ lệ cố định (không CLS); thay ảnh tạo URL mới (hash), không ghi đè URL cũ.

## 7. Tiền đến sau khi hủy / thu dư
- `ops_exception late_payment|overpayment`: kế toán xác minh trên cổng → tạo refund (một refund, retry cùng id) → ghi chú khách. Không phục hồi đơn, không giao thay thế khi chưa có xác nhận mới của khách.
