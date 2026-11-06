# Chính sách xử lý lỗ hổng phụ thuộc (VULN-SLA)

Áp dụng cho BASE-DEP-004, SEC-SUPPLY-006, OPS-MAINT-004. Phát hiện bằng OSV-Scanner (`.github/workflows/vuln-scan.yml`): **mỗi PR**, **mỗi lần push vào `master`** và **hằng tuần** (thứ Hai 02:17 UTC). Nguồn dữ liệu: osv.dev (GHSA, CVE, các nguồn hệ sinh thái).

## SLA theo mức (tính từ lúc lỗ hổng xuất hiện ở lượt quét đầu tiên)

Mức theo điểm CVSS v3/v4 của OSV (`max_severity`). Lỗ hổng không có điểm được coi là **high** cho tới khi phân loại xong.

| Mức      | CVSS     | Hạn xử lý (nâng bản/vá/gỡ) | Hành vi của CI                             |
| -------- | -------- | -------------------------- | ------------------------------------------ |
| Critical | 9.0–10.0 | 7 ngày                     | Job `vuln-scan` đỏ                         |
| High     | 7.0–8.9  | 14 ngày                    | Job `vuln-scan` đỏ                         |
| Medium   | 4.0–6.9  | 60 ngày                    | Cảnh báo (`::warning::`), không đỏ         |
| Low      | 0.1–3.9  | 90 ngày                    | Cảnh báo (`::warning::`), không đỏ         |

Quá hạn SLA mà chưa xử lý: ghi vào review tháng (số finding quá SLA phải về 0) và tăng ưu tiên lên đầu PLAN.

## Cách xử lý

1. Ưu tiên nâng bản có vá (Dependabot gom minor/patch; major theo mẫu `major-upgrade`). Phụ thuộc gián tiếp: dùng `pnpm.overrides` kèm ghi chú lý do và bỏ khi upstream nâng.
2. Không có bản vá hoặc không gọi tới mã bị ảnh hưởng: ghi **ngoại lệ có hạn** vào `osv-scanner.toml`.
   - Bắt buộc: `id` (GHSA/CVE), `reason`, `ignoreUntil` (YYYY-MM-DD, **tối đa 90 ngày**), dòng chú thích `# approved_by: <tên>`.
   - `scripts/osv-gate.mjs` đỏ khi thiếu trường, sai định dạng ngày, quá hạn hoặc hạn vượt 90 ngày. Hết hạn thì OSV-Scanner báo lại lỗ hổng.
   - Ngoại lệ do chủ dự án (hoặc người được ủy quyền) duyệt; ghi vào PR kèm đường đi tới bản vá.
3. Không nới ngưỡng (`HIGH` trong `scripts/osv-gate.mjs`) và không tắt job để làm xanh CI.

## Phạm vi quét

- Phụ thuộc gói: `pnpm-lock.yaml` (toàn workspace), mỗi PR + tuần.
- Image nền của CI (`postgres`, `redis`): ghim digest ở `ci.yml` (T-106); quét image và SBOM CycloneDX bổ sung cùng lô giấy phép/SBOM (T-105) — chưa nằm trong job này.
- EOL của Node/PostgreSQL/Redis: job `eol-check` hằng tuần (`scripts/eol-check.mjs`, OPS-MAINT-003).

## Quyền hạn

`vuln-scan` chỉ cần `contents: read`, không dùng bí mật. Để job chặn merge, thêm `vuln-scan` vào required check của `.github/rulesets/main.json` (đổi ruleset là quyết định riêng; mặc định hiện tại chưa bắt buộc).
