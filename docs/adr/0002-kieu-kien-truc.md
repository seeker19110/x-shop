# ADR-0002 — Kiểu kiến trúc: modular monolith, hai đơn vị triển khai (backend, storefront)

## Trạng thái

Accepted (2026-10-26) — ghi lại quyết định đã thể hiện trong mã từ ADR-0001 (D-005); bổ sung ADR-0001, không thay stack.

## Ngày

2026-10-26

## Bối cảnh

Cửa hàng thời trang một đơn vị bán, quy mô M, đội nhỏ. Cần giữ tiền/tồn/trạng thái đúng và dễ lùi lại (đặc tả gốc §7). ARC-STYLE-002 mặc định một đơn vị triển khai; mỗi đơn vị thêm phải có bằng chứng tách. Hiện trạng thật trong repo:

- `apps/backend`: một ứng dụng Medusa v2 chứa các module tùy biến; chế độ chạy chọn bằng `MEDUSA_WORKER_MODE` (`shared`/`server`/`worker`, `apps/backend/src/lib/env.ts`) — cùng một mã/ảnh, không phải dịch vụ riêng.
- `apps/storefront`: ứng dụng Next.js (App Router) riêng.
- `packages/domain`: thư viện TS thuần, hai app cùng import — không phải deployable.
- Chưa có IaC/pipeline deploy trong repo (`.github/workflows` chỉ chạy cổng kiểm); số deployable tính theo ứng dụng có `start` riêng: 2.

## Phương án đã cân nhắc

1. Một deployable duy nhất (Next.js gánh cả API commerce) — loại: Medusa v2 là server riêng có Admin, workflow engine, worker; nhúng vào Next buộc tự viết lại phần đó (ADR-0001 phương án 2).
2. Microservices theo miền (catalog, đơn, thanh toán, vận chuyển, kho) — loại: một đội, một DB, giao dịch tiền/tồn cần nhất quán mạnh; phân tán thêm saga, chi phí vận hành và bề mặt lỗi mà chưa có tải/đội để biện minh.
3. Modular monolith với hai deployable — chọn: backend (Medusa + module, một Postgres, một Redis) và storefront (Next.js) tách theo bằng chứng bên dưới; mọi miền nghiệp vụ là module trong backend, ranh giới ghi ở `docs/architecture/domains.md`.

## Quyết định

Chọn phương án 3. Backend là một codebase/một DB; không thêm dịch vụ thứ ba nếu chưa có ADR kèm mục "Bằng chứng tách". Worker là chế độ chạy của chính backend, không tính là dịch vụ mới.

### Bằng chứng tách (storefront khỏi backend)

- Cách ly bảo mật: khóa VNPAY/GHN và `DATABASE_URL` chỉ ở backend; storefront chỉ giữ địa chỉ backend và khóa công khai (`docs/ops/ENV.md`). Lộ storefront không lộ khóa cổng thanh toán.
- Nhịp co giãn khác nhau: storefront phục vụ lưu lượng đọc công khai (cache theo ADR-0003); backend giữ ghi tiền/tồn, cần khóa Redis và giao dịch DB.
- Runtime/phát hành khác nhau: storefront Next.js, backend Medusa (server + worker + Admin); hai vòng phát hành độc lập, vẫn một monorepo và một bộ cổng CI.
- Chưa có bằng chứng tách cho từng miền trong backend (chưa đo tải, chưa chạy thật) → giữ trong một modular monolith.

## Hệ quả

- Ranh giới module giữ bằng cấu trúc thư mục + `packages/domain` thuần; adapter không tính giá/tồn (AGENTS §9).
- Hai bề mặt triển khai cần hợp đồng API ổn định (`pnpm check:openapi`).
- Mọi deployable thứ ba phải có ADR mới; ADR này chỉ sửa ở dòng Trạng thái/liên kết.

## Điều kiện đọc lại

- Một miền (ví dụ thanh toán hoặc đối soát) cần co giãn/phát hành độc lập, có số đo (p95, CPU, tần suất deploy) chứng minh nút cổ chai.
- Có đội thứ hai sở hữu một miền và hai đội vướng nhau ở cùng module ≥ 2 mốc liên tiếp.
- Spike RK-001 (Medusa không đáp ứng đơn chờ/giữ hàng) thất bại → thay lõi commerce bằng ADR mới.
- Có yêu cầu pháp lý/cách ly dữ liệu buộc tách lưu trữ PII khỏi phần còn lại.
