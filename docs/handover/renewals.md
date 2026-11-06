# Phụ thuộc có hạn — x-shop

> Cập nhật 2026-10-26. Mục đích: không để thứ gì hết hạn bất ngờ. Ngày lấy từ nguồn nêu ở cột "Nguồn"; "chưa có" = chưa tồn tại; "(chưa xác minh)" = chưa đối chiếu nguồn.
> Quy tắc nhắc: tạo nhắc lịch **≥ 30 ngày** trước hạn cho mọi dòng có ngày; chủ gia hạn ghi tên vào cột "Chủ gia hạn" khi nhận bàn giao. Không ghi bí mật.

## 1. Hạn thương mại và pháp lý

| Hạng mục | Chi tiết | Ngày hết hạn | Chủ gia hạn | Nhắc trước | Nguồn / ghi chú |
| --- | --- | --- | --- | --- | --- |
| Tên miền | chưa có | — | [chủ dự án điền] | ≥ 30 ngày | chưa mua; bật tự gia hạn và khoá chuyển khi mua |
| Chứng chỉ TLS | chưa có (phụ thuộc hạ tầng) | — | nền tảng triển khai | tự động gia hạn | cần bằng chứng gia hạn tự động sau khi chọn hạ tầng (RUNBOOK §8.1) |
| Giấy phép mã nguồn (LICENSE) | chưa tạo, chờ chủ dự án chọn (H-01 trong PLAN-2) | không áp dụng | chủ dự án | — | không có hạn nhưng là điều kiện phát hành công khai |
| Hợp đồng merchant VNPAY | chưa có hợp đồng; khoá `VNPAY_TMN_CODE`/`VNPAY_HASH_SECRET` do VNPAY cấp | — | [chủ dự án điền] | ≥ 30 ngày | `docs/compliance/vendors.yaml` (id `vnpay`) |
| Hợp đồng GHN | chưa có hợp đồng; `GHN_TOKEN` | — (hạn token: chưa xác minh) | [chủ dự án điền] | ≥ 30 ngày | `vendors.yaml` (id `ghn`) |
| Nhà cung cấp email/SMS | chưa chọn | — | [chủ dự án điền] | ≥ 30 ngày | `vendors.yaml` (id `notify-provider`) |
| Gói hạ tầng (máy chủ, Postgres, Redis, kho ảnh) | chưa chọn | — | [chủ dự án điền] | ≥ 30 ngày | `vendors.yaml` (id `hosting`) |
| Thẻ thanh toán cho các dịch vụ trả phí | chưa có dịch vụ trả phí | — | [chủ dự án điền] | ≥ 30 ngày | thẻ hết hạn làm dịch vụ ngừng — ghi khi có |
| `GITLEAKS_LICENSE` (nếu dùng) | tuỳ chọn, workflow `secret-scan` | (chưa xác minh) | chủ kho | ≥ 30 ngày | `.github/workflows/secret-scan.yml` |

## 2. Hạn kỹ thuật (có nguồn máy)

| Hạng mục | Phiên bản dùng | Hết hỗ trợ (EOL) | Chủ | Nhắc | Nguồn |
| --- | --- | --- | --- | --- | --- |
| Node.js | 22.22.0 (`.nvmrc`) | 2027-04-30 | chủ dự án / phiên làm việc | `scripts/eol-check.mjs` chạy tuần (workflow `vuln-scan`, job eol-check), cảnh báo < 183 ngày | endoflife.date, chạy 2026-10-26 |
| PostgreSQL | 16 (`ci.yml`) | 2028-11-09 | như trên | như trên | endoflife.date, chạy 2026-10-26 |
| Redis | 7 (`ci.yml`) | 2029-12-01 | như trên | như trên | endoflife.date, chạy 2026-10-26 |

Kiểm lại bất cứ lúc nào: `node scripts/eol-check.mjs`. Khi nâng major: đổi `.nvmrc`/`ci.yml`, cập nhật dòng này.

## 3. Hạn quy trình (tự đặt trong repo)

| Việc | Chu kỳ | Lần gần nhất | Hạn kế tiếp | Chủ | Nguồn |
| --- | --- | --- | --- | --- | --- |
| Diễn tập khôi phục DB và mất Redis | ≤ 6 tháng | 2026-10-25 | 2027-04-25 | [chủ dự án điền] | RUNBOOK §0, `scripts/ops/restore-drill.sh` |
| Diễn tập deploy/rollback, xoay secret, lộ bí mật | ≤ 6 tháng | chưa diễn tập | khi có hạ tầng | [chủ dự án điền] | RUNBOOK §5, §8–§10 |
| Diễn tập tabletop vi phạm dữ liệu | ≥ 1 lần/năm | chưa diễn tập | trước G7 | [chủ dự án điền] | `docs/ops/runbooks/data-breach.md` §7 |
| Rà soát nhà cung cấp/bên xử lý | ≤ 12 tháng | 2026-10-26 | 2027-10-26 | [chủ dự án điền] | `docs/compliance/vendors.yaml` (`next_review`) |
| Cập nhật hồ sơ dữ liệu cá nhân | rà 6 tháng và khi đổi bên xử lý | 2026-10-26 | 2027-04-26 | [chủ dự án điền] | `docs/privacy/CHANGELOG.md`; nghĩa vụ hồ sơ: chưa xác minh |
| Xoay khoá ký (JWT, cookie, MFA, lookup) | 12 tháng (đề xuất) | chưa có khoá production | 12 tháng sau khi tạo | [chủ dự án điền] | RUNBOOK §9 |
| Kiểm danh sách liên hệ sự cố | mỗi quý | chưa kiểm | khi điền | IC | `docs/ops/INCIDENT-RESPONSE.md` §2 |

## 4. Việc chờ chủ dự án

Điền tên miền, hợp đồng, nhà cung cấp, chủ gia hạn và ngày thật khi có; tạo nhắc lịch ≥ 30 ngày; sau khi chọn hạ tầng, ghi bằng chứng TLS tự gia hạn và thêm cảnh báo hạn chứng chỉ/domain vào giám sát hoặc CI.
