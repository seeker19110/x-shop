# ADR-0005 — Ngoại lệ bố cục thư mục Medusa cho `apps/backend/src` (ARC-MOD-008)

## Trạng thái

Accepted (2026-10-28), theo D-047.

## Ngày

2026-10-28

## Bối cảnh

ARC-MOD-008 đòi thư mục cấp một của source chia theo miền nghiệp vụ. `apps/backend/src` dùng Medusa v2 (ADR-0001), nơi framework tự nạp theo tên thư mục theo loại thành phần: `modules/`, `workflows/`, `api/`, `subscribers/`, `jobs/`, `links/`, `admin/`, `scripts/` (cộng `lib/` của dự án). Đổi tên hoặc gom lại theo miền làm framework không tìm thấy thành phần. Miền vẫn tồn tại ở cấp `modules/<module>`, `workflows/<miền>`, `lib/<miền>` và trong lõi thuần `packages/domain/src/*`; ánh xạ miền ↔ module ↔ lõi nằm ở `docs/architecture/domains.md` (kiểu kiến trúc: ADR-0002).

## Phương án đã cân nhắc

1. Đổi bố cục theo miền (`apps/backend/src/<miền>/{api,workflows,…}`) — loại: phá quy ước nạp tự động của Medusa, tăng cấu hình tuỳ biến phải bảo trì, rủi ro khi nâng phiên bản framework.
2. Chấp nhận bố cục Medusa làm ngoại lệ, giữ ranh giới miền ở cấp `modules/*` và `packages/domain/src/*`, kiểm bằng máy — chọn.

## Quyết định

Chấp nhận bố cục thư mục cấp một do Medusa quy định cho `apps/backend/src` thay cho bố cục theo miền thuần. Ranh giới miền được giữ và kiểm bằng `scripts/check-domains.mjs` (chạy trong job `gate` của CI, `pnpm check:domains`): tập thư mục `apps/backend/src/modules/*` và `packages/domain/src/*` phải khớp danh sách khai trong `docs/architecture/domains.md`, hai chiều (chưa khai → đỏ; khai mà không tồn tại → đỏ). Thư mục kỹ thuật không phải miền (`__tests__`, `shared`, `utils`…) chỉ được bỏ qua khi nằm trong `TECH_DIRS` của script kèm lý do.

## Hệ quả

- Thêm module hoặc thư mục lõi mới bắt buộc cập nhật `docs/architecture/domains.md` trong cùng PR.
- Ranh giới miền ở `workflows/<miền>` và `lib/<miền>` chưa được máy kiểm (chỉ `modules/*` và lõi); cần thì mở rộng script.
- Đường lùi: bỏ ADR này và script, hoặc đổi bố cục theo phương án 1.

## Điều kiện đọc lại

- Medusa đổi cơ chế nạp thành phần (cho phép cấu hình thư mục tuỳ ý) khiến phương án 1 rẻ.
- Tách backend thành nhiều dịch vụ/gói theo miền.
- Số module/miền tăng mạnh hoặc xuất hiện vi phạm ranh giới giữa miền mà script không bắt được.
