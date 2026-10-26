# Tài khoản và dịch vụ — x-shop

> Cập nhật 2026-10-26. **Không chứa bí mật**: chỉ tên dịch vụ, vai trò, tên biến/khoá, nơi giữ. "chưa có" = chưa tồn tại hoặc chưa chọn — không điền suy đoán.
> Nguồn: `docs/ops/ENV.md`, `docs/compliance/vendors.yaml`, `docs/privacy/processors.md`, `.github/workflows/`, `docs/ops/RUNBOOK.md`.

## 1. Quy tắc chuyển giao

1. Chuyển **quyền sở hữu** bằng cơ chế nền tảng: chuyển ownership tổ chức/kho, mời thành viên với vai trò tối thiểu, dùng kho bí mật dùng chung của nền tảng triển khai.
   **Không** gửi giá trị bí mật qua chat, email, ticket hay commit.
2. Ngay sau khi chuyển: chủ mới **xoay** mọi bí mật thuộc dịch vụ (thủ tục từng khoá: [`../ops/RUNBOOK.md`](../ops/RUNBOOK.md) §9; nghi lộ: §10) rồi ghi ngày xoay vào bảng.
3. Chủ cũ chỉ bị gỡ quyền sau khi chủ mới đăng nhập được và đã xoay; thu hồi theo [`offboarding-TEMPLATE.md`](offboarding-TEMPLATE.md) trong ngày rời.
4. Kiểm sau bàn giao: quét bí mật sạch (workflow `secret-scan`, gitleaks, chạy trong CI); danh sách thành viên tổ chức không còn người đã rời.
5. Mọi dòng "Ngày chuyển"/"Ngày xoay" để trống (`—`) nghĩa là chưa làm.

## 2. Dịch vụ và tài khoản

| Dịch vụ | Dùng để | Chủ hiện tại | Chủ mới | Cơ chế chuyển | Ngày chuyển | Ngày xoay |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub — kho `seeker19110/x-shop` | mã nguồn, CI (`ci`, `secret-scan`, `vuln-scan`, `pr-steward`), ruleset nhánh | tài khoản `seeker19110` | [chủ dự án điền] | Transfer repository sang tổ chức/chủ mới; mời thành viên với vai trò tối thiểu | — | — |
| GitHub Actions secrets | `GITLEAKS_LICENSE` (giấy phép quét, tuỳ chọn), `XT_STEWARD_TOKEN` (tuỳ chọn; vắng thì dùng `github.token`) | chủ kho | [chủ dự án điền] | Nhập lại ở Settings → Secrets của kho mới (không chuyển được giá trị) | — | — |
| Kho bí mật production | giữ biến môi trường của server + worker backend và storefront | chưa có (chưa chọn nền tảng — RUNBOOK §8.1) | — | Theo nền tảng được chọn | — | — |
| Hạ tầng triển khai (`hosting`) | chạy backend, storefront, Postgres, Redis, backup, log | chưa có (chưa chọn) | — | Chuyển ownership tổ chức/dự án của nền tảng | — | — |
| Tên miền và DNS | địa chỉ storefront, Admin, backend; `VNPAY_RETURN_URL` | chưa có | — | Chuyển domain qua nhà đăng ký (mã chuyển/transfer, không gửi qua chat) | — | — |
| Chứng chỉ TLS | HTTPS cho storefront/backend | chưa có (phụ thuộc hạ tầng) | — | Cấp tự động bởi nền tảng/CA — không có khoá để chuyển | — | — |
| VNPAY merchant | thanh toán online; cấp `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`; cấu hình URL IPN | chưa có hợp đồng (RK-006; `vendors.yaml`) | — | Đổi người đại diện/đầu mối trong hợp đồng merchant; VNPAY cấp lại khoá | — | — |
| GHN | vận chuyển; cấp `GHN_TOKEN`, `GHN_SHOP_ID`; cấu hình callback `/x/webhooks/shipping/ghn` | chưa có hợp đồng | — | Chuyển chủ tài khoản shop trên GHN hoặc tạo token mới dưới tài khoản chủ mới | — | — |
| Nhà cung cấp email/SMS (`notify-provider`) | thông báo đơn, liên kết tra cứu | chưa chọn (hiện chỉ adapter `log`) | — | Theo nhà cung cấp được chọn | — | — |
| Kho ảnh / CDN (S3-compatible) | ảnh sản phẩm (production nên dùng file module S3 + CDN — RUNBOOK §6) | chưa có | — | Chuyển ownership bucket/tài khoản | — | — |
| Tài khoản Admin Medusa (người dùng cuối) | quản trị shop; RBAC + MFA TOTP (`apps/backend/src/modules/rbac`) | tạo bằng seed/lệnh tạo user; chưa có tài khoản production | [chủ dự án điền] | Mời người dùng mới, gán vai trò; thu hồi người cũ | — | — |
| Giám sát/cảnh báo, status page | phát hiện sự cố | chưa có (INCIDENT-RESPONSE §8) | — | Theo công cụ được chọn | — | — |

## 3. Bí mật ứng dụng (chỉ tên và nơi giữ)

Giá trị nằm ở kho bí mật production (chưa chọn) và `.env` cục bộ đã gitignore của từng máy dev. Nguồn chuẩn danh sách: `docs/ops/ENV.md`, `apps/backend/src/lib/env.ts`.

| Biến | Thuộc dịch vụ | Xoay (RUNBOOK) | Ngày xoay gần nhất |
| --- | --- | --- | --- |
| `JWT_SECRET`, `COOKIE_SECRET` | backend (phiên admin) | §9 — khác nhau, ≥ 32 ký tự | — |
| `AUTH_MFA_ENCRYPTION_KEY` | backend (TOTP) | §9 — đổi thì mọi admin đăng ký lại TOTP | — |
| `ORDER_LOOKUP_SECRET` | backend (liên kết tra cứu đơn) | §9 — đổi thì liên kết cũ mất hiệu lực | — |
| `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET` | VNPAY | §9, §10 — đổi ở cổng merchant và env trong cùng cửa sổ ngắn | — |
| `GHN_TOKEN`, `GHN_SHOP_ID` | GHN | §9, §10 | — |
| `DATABASE_URL`, `REDIS_URL` (mật khẩu) | Postgres, Redis | §9 | — |
| Khoá email/SMS provider | nhà cung cấp (chưa chọn) | §9 | — |
| `GITLEAKS_LICENSE`, `XT_STEWARD_TOKEN` | GitHub Actions | tạo lại ở nguồn rồi nhập lại vào Settings | — |

Hiện chưa có bí mật production nào được tạo (chưa có hạ tầng, hợp đồng VNPAY/GHN), nên chưa có ngày xoay để ghi.
