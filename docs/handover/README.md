# Gói bàn giao x-shop

> Cập nhật 2026-10-26. Đọc file này đầu tiên khi nhận dự án hoặc khi người mới vào (onboarding). Không file nào trong thư mục này chứa bí mật:
> chỉ ghi **tên** biến/khoá và **nơi** giữ giá trị. Giá trị thật chuyển bằng cơ chế của nền tảng (xem `accounts.md`), không qua chat/email.

## Thứ tự đọc cho người mới (onboarding)

1. [`../../README.md`](../../README.md) — chạy local từ clone sạch (3 lệnh); [`../../PROJECT.md`](../../PROJECT.md) — mục tiêu, phạm vi, kiến trúc, dữ liệu test.
2. [`../../RUNBOOK.md`](../../RUNBOOK.md) — lối vào vận hành; chi tiết ở [`../ops/RUNBOOK.md`](../ops/RUNBOOK.md) (VNPAY, GHN, Redis, DB, deploy, rollback, xoay và lộ bí mật).
3. [`../ops/INCIDENT-RESPONSE.md`](../ops/INCIDENT-RESPONSE.md) — mức SEV1–4, ai được tuyên bố sự cố, thứ tự giảm thiệt hại; vi phạm dữ liệu cá nhân: [`../ops/runbooks/data-breach.md`](../ops/runbooks/data-breach.md).
4. [`../adr/`](../adr/) (quyết định kiến trúc) · [`../../PROGRESS.md`](../../PROGRESS.md) (trạng thái) · [`../RISKS.md`](../RISKS.md) (sổ rủi ro) · [`../ops/THREAT-MODEL.md`](../ops/THREAT-MODEL.md) · [`../ops/ENV.md`](../ops/ENV.md) (biến môi trường).
5. Hồ sơ dữ liệu cá nhân: [`../privacy/`](../privacy/README.md), [`../compliance/vendors.yaml`](../compliance/vendors.yaml).

## Nội dung thư mục

| File                                                    | Dùng khi                                                                                      |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`accounts.md`](accounts.md)                            | Biết dịch vụ/tài khoản nào tồn tại, ai giữ, chuyển bằng cách nào, ngày chuyển và ngày xoay    |
| [`renewals.md`](renewals.md)                            | Biết cái gì hết hạn khi nào, ai gia hạn, nhắc trước bao lâu                                   |
| [`offboarding-TEMPLATE.md`](offboarding-TEMPLATE.md)    | Có người rời dự án: sao chép thành `offboarding-<tên>.md`, thu hồi quyền trong ngày rời       |

## Hiện trạng thật (không che)

Hạ tầng production, tên miền, nhà cung cấp email/SMS, kho bí mật và hợp đồng VNPAY/GHN **chưa có** (RUNBOOK §8.1; `docs/compliance/vendors.yaml`). Các bảng
trong thư mục này ghi "chưa có" ở đúng chỗ đó; chủ dự án điền khi có.
