# Bí mật/PII trong log và trace (SEC-SECRET-007, CMP-PRIV-008)

Cập nhật: 2026-10-29 (T-183).

## Log — đã có lớp chặn

| Lớp | Cơ chế | Kiểm |
| --- | --- | --- |
| Bộ che ở logger backend | che theo tên trường + regex khoá/PII VN | test đơn vị `apps/backend/src/lib/log/__tests__/` |
| Luật ESLint (`no-restricted-syntax`, `LOG_RAW_OBJECT_SYNTAX` trong `eslint.config.mjs`) | cấm truyền nguyên `req`, `req.body/headers/query/params`, `body`, `customer`, `order`, `address`, `cart`, `payload` làm đối số `logger.*`/`log.*`/`console.*` và `track()` (cả khi nằm trong object literal `{ order }`) | `pnpm lint` |
| gitleaks trên log test (job `gate` của `ci.yml`) | output `gate-par` (có log test tích hợp) tee ra file, `gitleaks dir` (không đọc lịch sử git) với `.gitleaks.toml` (D-135) | CI: bước "gitleaks --no-git trên log test" |

Cách viết đúng: log thuộc tính đã chọn (`order.id`) hoặc giá trị đã che (`redact(x)`), không log cả object.

## Trace — không áp dụng tới khi có OTel

Dự án chưa dùng OpenTelemetry (hoặc APM khác): không có span/attribute/exporter nào mang dữ liệu yêu cầu, nên vế "trace"
của SEC-SECRET-007 và CMP-PRIV-008 hiện **không áp dụng**. Chỉ có `trace_id`/`span_id` là định danh tương quan trong log
(không chứa dữ liệu người dùng).

Điều kiện kích hoạt: ngay khi thêm OTel SDK/exporter, phải trước khi merge:

1. Che/không ghi attribute chứa PII/bí mật (header `authorization`/`cookie`, body, query có token, email/SĐT/địa chỉ) bằng processor ở SDK.
2. Thêm test span attribute không chứa giá trị nhạy cảm; mở lại các mục SEC-SECRET-007/CMP-PRIV-008 ở BLUEPRINT.
3. Mở rộng luật ESLint ở trên cho API span (`setAttribute`, `addEvent`, `recordException`).
