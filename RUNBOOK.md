# RUNBOOK — x-shop (lối vào)

> Cập nhật 2026-10-26. File gốc này chỉ chỉ đường; nội dung vận hành đầy đủ nằm ở `docs/ops/`. Không chứa bí mật.

| Cần gì | Mở |
| --- | --- |
| Quy trình vận hành theo tình huống (VNPAY, GHN, Redis, DB/khôi phục, rollback, deploy, xoay và lộ bí mật, dữ liệu staging, outbox) | [`docs/ops/RUNBOOK.md`](docs/ops/RUNBOOK.md) |
| Phân mức sự cố SEV1–4, ai tuyên bố, thứ tự giảm thiệt hại, lệnh lên dữ liệu thật | [`docs/ops/INCIDENT-RESPONSE.md`](docs/ops/INCIDENT-RESPONSE.md) |
| Lộ/mất dữ liệu cá nhân (đồng hồ 72 giờ, mẫu thông báo) | [`docs/ops/runbooks/data-breach.md`](docs/ops/runbooks/data-breach.md) |
| Biến môi trường (tên, ý nghĩa; giá trị mẫu là giả) | [`docs/ops/ENV.md`](docs/ops/ENV.md) |
| Mô hình đe doạ, DPIA, số đo hiệu năng (RPO/RTO: RUNBOOK §4) | [`docs/ops/THREAT-MODEL.md`](docs/ops/THREAT-MODEL.md), [`docs/ops/DPIA.md`](docs/ops/DPIA.md), [`docs/ops/perf/`](docs/ops/perf/) |
| Bàn giao: tài khoản/dịch vụ, hạn gia hạn, offboarding | [`docs/handover/`](docs/handover/README.md) |
| Kiểm sống nhanh | `curl -fsS "$MEDUSA_BACKEND_URL/x/health"` |

Nguyên tắc: **tiền và tồn đúng quan trọng hơn còn bán được**; sự cố bảo mật = SEV1; giảm thiệt hại trước, tìm nguyên nhân sau.
