---
title: DPIA x-shop
kind: dpia
version: "1.0"
updated: 2026-10-26
status: hoàn tất phần kỹ thuật; chờ chủ dự án/pháp chế duyệt và nộp (§9)
---

# DPIA — Đánh giá tác động xử lý dữ liệu cá nhân · x-shop · phiên bản 1.0 · 2026-10-26

> **Tài liệu kỹ thuật, không thay ý kiến pháp lý.** Mô tả dữ liệu cá nhân theo bảng/cột THẬT trong mã tại ngày ghi.
> Căn cứ pháp lý, và mức xác minh:
>
> | Văn bản | Dùng để | Mức xác minh |
> |---|---|---|
> | Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân | khung nguyên tắc, quyền chủ thể, đánh giá tác động | nêu theo hiểu biết chung; **chưa đối chiếu văn bản gốc** trong phiên này; theo nguồn thứ cấp của khung (`.xtemplates/framework/16-compliance-privacy/vietnam-data-law.md`) NĐ này bị thay bởi NĐ 356/2025/NĐ-CP — (chưa xác minh) |
> | Luật Bảo vệ dữ liệu cá nhân 91/2025/QH15 | nguồn luật hiện hành nếu đã có hiệu lực | nguồn thứ cấp ghi ban hành 26/06/2025, hiệu lực 01/01/2026 (`docs/research/2026-10-24-stack.md` mục 9, độ tin cậy "T") — (chưa xác minh từ văn bản gốc); **không trích số điều** |
> | Nghị định 356/2025/NĐ-CP | hướng dẫn thi hành Luật 91/2025 (hồ sơ đánh giá tác động, thông báo vi phạm) | (chưa xác minh) ngày và số điều |
>
> Mọi nghĩa vụ cụ thể (thời hạn nộp hồ sơ, mẫu, cơ quan tiếp nhận, thời hạn thông báo vi phạm) do chủ dự án/pháp chế
> đối chiếu văn bản gốc trước ra mắt (§9). Tài liệu này không khẳng định các thời hạn đó.

| Trường | Giá trị |
|---|---|
| Vai trò của tổ chức | Bên Kiểm soát dữ liệu khách mua hàng; VNPAY, GHN, nhà cung cấp email/SMS là bên nhận/xử lý (hợp đồng/DPA chưa có — §9) |
| Pháp nhân, liên hệ, người phụ trách bảo vệ dữ liệu | **chờ chủ dự án điền** (chưa có thông tin trong repo) |
| Trạng thái nộp hồ sơ | chưa nộp; nghĩa vụ nộp/thời hạn (chưa xác minh) |
| Phạm vi hệ thống | storefront mua không cần tài khoản (khách vãng lai), Admin cho nhân viên, Postgres, Redis, VNPAY, GHN, email/SMS |

## 1. Danh mục dữ liệu cá nhân (theo bảng/cột trong mã)
Phân loại: **cơ bản** (không có dữ liệu nhạy cảm: không thu ngày sinh, giới tính, giấy tờ định danh, sức khoẻ, vị trí chính xác).
Khách vãng lai không có tài khoản/mật khẩu; khách chỉ được xem đơn qua token (§5).

| Nhóm | Dữ liệu | Bảng/cột (module) | Ghi chú |
|---|---|---|---|
| Liên hệ | họ tên, SĐT, email (tùy chọn) | `order_finance.contact` (JSON `{name, phone, email?}`) — `apps/backend/src/modules/checkout/models/checkout-models.ts` | nguồn chính; copy sang vận đơn GHN lúc tạo |
| Bản sao ở đơn Medusa native | họ tên, SĐT, địa chỉ chi tiết, email | `order_address` (`first_name`, `phone`, `address_1`, `city`, `province`) và `order.metadata.x_contact_email` — `apps/backend/src/workflows/checkout/submit-checkout.ts` | bản sao của `order_finance.contact/address` trong bảng của Medusa (không có migration trong repo); ẩn danh phải xử lý cả hai nơi; liệt kê ở `external_tables` của `docs/privacy/data-map.yaml` |
| Địa chỉ giao | mã tỉnh/phường, số nhà-tên đường (tự do ≤ 500 ký tự) | `order_finance.address` (JSON), `checkout_quote.address` (JSON), `checkout_quote.shipping` (JSON — chỉ mã tỉnh/phường, kèm khối lượng/giá trị khai của báo phí, T-153) | quote hết hạn sau 10 phút nhưng bản ghi còn (không có job dọn — §3) |
| Hiển thị đơn | SĐT che dạng `0912***678`, không trả email/id nội bộ | không lưu thêm; tính khi trả `GET /store/x/orders/:display_ref` | `apps/backend/src/lib/orders/view.ts` |
| Thông báo | người nhận ĐÃ CHE (`recipient_masked`), không lưu nội dung thư/SMS | `outbound_message` — `apps/backend/src/modules/notify/models/outbound-message.ts` | `last_error` chỉ chứa lỗi kỹ thuật |
| Hàng đợi sự kiện | payload sự kiện (mã đơn, liên kết tra cứu có token một lần) | `outbox_event.payload` (JSON) | chứa token liên kết 15 phút; hết hạn nhưng bản ghi còn |
| Thanh toán | mã đơn, mã giao dịch, số tiền, tham số IPN VNPAY | `payment_attempt`, `payment_ledger`, `webhook_inbox.payload` | không lưu PAN/thẻ (thanh toán trên trang VNPAY); `vnp_IpAddr` gửi VNPAY lúc tạo giao dịch |
| Vận chuyển | sự kiện callback GHN đã lọc PII | `shipping` module: bảng sự kiện (`raw` JSON, lọc PII trước khi lưu) — `apps/backend/src/modules/shipping/models/shipping-models.ts` | không lưu địa chỉ/SĐT đầy đủ trong `raw` |
| Đổi trả/hoàn tiền | lý do, ghi chú tự do (≤ 500 ký tự), ghi chú kiểm định | module `returns` (`note`, `decision_note`, `inspection_note`, `reject_reason`, `cancel_reason`) | khách có thể gõ PII vào ghi chú; trả ra qua `maskFreeText` (§6). **Chưa lưu ảnh đổi trả** (bản nháp 0.1 từng ghi object storage — chưa có tính năng này) |
| IP | IP khách | (a) khoá `rate_limit_counter.bucket` chỉ lưu **băm** (`sec.<tên>:<digest>`); (b) `audit_log.ip_hash` (băm); (c) gửi VNPAY làm `vnp_IpAddr`; (d) **`payment_attempt.payment_url` lưu nguyên URL thanh toán đã ký, trong đó có `vnp_IpAddr` = IP khách ở dạng thô** (`packages/domain/src/providers/vnpay/vnpay.ts`, `UPDATE payment_attempt SET payment_url` trong `apps/backend/src/modules/checkout/service.ts`); (e) log máy chủ có thể chứa IP — chưa kiểm nhật ký thật | IP thô còn nằm ở (c) và (d); (d) theo thời hạn `payment-evidence` trong data-map — giảm thiểu là việc mở (cân nhắc cắt `vnp_IpAddr` khỏi URL lưu hoặc ẩn danh sau khi giao dịch chốt) |
| Tra cứu đơn | băm token đã đổi | `order_access_redemption.token_hash` (SHA-256) | token thô không lưu |
| Vận hành/an ninh | audit admin: actor, hành động, lý do, thay đổi đã che | `audit_log` (append-only) | `changes` qua `sanitizeChanges` — `apps/backend/src/lib/audit/sanitize.ts` |
| Nhân viên | tài khoản admin (email), vai trò, yếu tố MFA | bảng user/auth của Medusa, `rbac` | dữ liệu của nhân viên, không phải khách |
| Đo lường | sự kiện không PII (item id, giá trị); không có kho analytics | `apps/storefront/src/app/api/analytics/route.ts` chỉ nhận/chuyển tiếp, không lưu | đồng ý analytics chỉ ở client |
| Marketing | **không thu ở P0** | không có bảng đồng ý (`consents`) | nếu bật sau: cần bảng đồng ý, mặc định không tick sẵn |

## 2. Mục đích, cơ sở xử lý, bên nhận
Cơ sở dưới đây là **đề xuất kỹ thuật** theo loại mục đích; chủ dự án/pháp chế xác nhận cơ sở pháp lý chính thức (§9).

| Mục đích | Dữ liệu | Cơ sở đề xuất | Bên nhận | Dữ liệu gửi đi |
|---|---|---|---|---|
| Giao kết và thực hiện đơn hàng | họ tên, SĐT, email?, địa chỉ | thực hiện hợp đồng mua bán | GHN (bên vận chuyển) | tên, SĐT, địa chỉ, COD (adapter `packages/domain/src/providers/ghn/`) |
| Thanh toán online | mã đơn, số tiền, IP | thực hiện hợp đồng | VNPAY | mã giao dịch, số tiền, `vnp_IpAddr`, thông tin đơn; không gửi tên/SĐT/địa chỉ (adapter `packages/domain/src/providers/vnpay/`) |
| Thông báo giao dịch (xác nhận đơn, liên kết tra cứu) | SĐT/email | thực hiện hợp đồng | nhà cung cấp email/SMS (**chưa chọn**; adapter `log` ở dev) | người nhận + nội dung giao dịch |
| Tra cứu đơn của khách vãng lai | mã đơn + SĐT | thực hiện hợp đồng / quyền của chủ thể truy cập đơn của mình | — | — |
| Đổi trả, CSKH, hoàn tiền | ghi chú, lý do, số tiền | thực hiện hợp đồng | VNPAY (hoàn tiền qua cổng) | mã giao dịch, số tiền |
| Đối soát, kế toán | mã đơn, số tiền, mã vận đơn | nghĩa vụ kế toán/chứng từ (chủ dự án xác nhận) | — | — |
| Chống gian lận/an ninh | IP băm, audit | lợi ích hợp pháp/nghĩa vụ an ninh (đề xuất) | — | — |
| Đo lường sản phẩm | sự kiện không PII | đồng ý theo cấu hình (cookie banner) | — | — |

Chuyển dữ liệu ra nước ngoài: **chưa xác định** — phụ thuộc nơi đặt hạ tầng và nhà cung cấp email/SMS (chưa chọn); nếu
chọn dịch vụ ngoài Việt Nam cần hồ sơ riêng (chưa xác minh yêu cầu cụ thể).

## 3. Thời hạn lưu và cơ chế xoá — đối chiếu job thật
Cột "Thực thi" ghi đúng hiện trạng mã. **Chỉ một job dọn dữ liệu tồn tại.** Các thời hạn dưới đây là đề xuất; chỉ khi chủ
dự án chốt thời hạn mới viết job tương ứng.

| Dữ liệu | Thời hạn đề xuất | Thực thi hiện tại | Bằng chứng |
|---|---|---|---|
| `rate_limit_counter` (bộ đếm giới hạn tần suất, khoá băm) | > 2 ngày thì xoá | **Đã thực thi**: mỗi giờ (`17 * * * *`) | `apps/backend/src/jobs/order-access-cleanup.ts`; `purgeOrderAccessRecords` trong `apps/backend/src/modules/checkout/service.ts` |
| `order_access_redemption` (băm token đổi liên kết) | > 1 ngày sau hết hạn thì xoá | **Đã thực thi**: cùng job | như trên |
| Giữ hàng hết hạn (`expire-holds`), huỷ COD quá hạn xác nhận | theo cấu hình giữ hàng | **Đã thực thi** nhưng chuyển trạng thái, không xoá PII | `apps/backend/src/jobs/expire-holds.ts`; `apps/backend/src/jobs/cod-confirm-timeout.ts` |
| Đơn hàng, ledger, chứng từ đối soát (gồm liên hệ/địa chỉ trong `order_finance`) | theo nghĩa vụ lưu chứng từ — **chủ dự án/kế toán xác nhận số năm** | **Chưa có job**; ledger/đối soát là append-only có chủ đích | `apps/backend/src/modules/settlement/migrations/Migration20261025120000.ts` |
| `checkout_quote` (chứa địa chỉ giao). `checkout_attempt` chỉ có bảng giá/mã lỗi, không có địa chỉ (đối chiếu migration) | ngắn (đề xuất ≤ 90 ngày sau đóng) | **Chưa có job** | `docs/privacy/data-map.yaml` |
| `outbox_event`, `outbound_message` | đề xuất 90 ngày bản ghi đã gửi | **Chưa có job** (bản nháp 0.1 ghi 90 ngày — chưa thực thi) | — |
| `webhook_inbox`, sự kiện callback GHN | đề xuất theo thời hạn chứng từ thanh toán/vận chuyển | **Chưa có job** | — |
| Ghi chú đổi trả/hoàn tiền | cùng vòng đời đơn | **Chưa có job** | — |
| `audit_log` | theo chính sách (đề xuất ≥ 1 năm, tối đa theo chủ dự án) | **Chưa có job**; append-only bằng trigger DB nên xoá cần quy trình riêng | `apps/backend/src/modules/audit/migrations/Migration20261024210100.ts` |
| Log ứng dụng (ghi ra stdout/hạ tầng) | đề xuất 90 ngày | phụ thuộc hạ tầng log — chưa có | — |

Khoảng trống blueprint tương ứng: STD-PRIV-005, XC-GREEN-007 (retention có job tự động và test seed bản ghi quá hạn) —
còn mở; nên làm sau khi chủ dự án chốt số năm.

## 4. Quyền chủ thể và quy trình
Khách mua không cần tài khoản nên quyền được thực hiện qua mã đơn + SĐT/email đã dùng. Hiện trạng kỹ thuật:

| Quyền | Quy trình đề xuất | Hỗ trợ kỹ thuật hiện có | Khoảng trống |
|---|---|---|---|
| Biết/truy cập dữ liệu | khách gửi yêu cầu tới kênh liên hệ (§9); CSKH xác minh bằng mã đơn + SĐT, xuất dữ liệu đơn | tra cứu đơn tự phục vụ (`POST /store/x/orders/lookup` → liên kết 15 phút → xem đơn che SĐT); Admin xem dữ liệu qua RBAC | chưa có export dữ liệu theo người (test `rights-access` chưa có) |
| Chỉnh sửa | CSKH sửa liên hệ/địa chỉ khi đơn chưa giao | chưa có route sửa liên hệ | cần quyết định nghiệp vụ |
| Xoá/ẩn danh | ẩn danh hoá `order_finance.contact`/`address` và ghi chú sau khi hết nghĩa vụ chứng từ; giữ ledger/hoá đơn | chưa có | chưa có luồng/job ẩn danh (`rights-delete`) — mở |
| Rút đồng ý / phản đối marketing | không thu marketing ở P0 | không có bảng đồng ý | cần bảng đồng ý append-only nếu bật marketing |
| Hạn chế xử lý, khiếu nại | CSKH xử lý theo quy trình | — | thời hạn phản hồi do chủ dự án đặt (chưa xác minh luật định) |

Thời hạn đáp ứng yêu cầu chủ thể, mẫu đơn và thủ tục xác minh danh tính: chủ dự án/pháp chế đặt theo văn bản gốc (§9).
Thông báo xử lý (chính sách quyền riêng tư công khai `/bao-mat`) do chủ shop duyệt nội dung.

## 5. Nguyên tắc kỹ thuật (có test)
- Thu tối thiểu: email tùy chọn khi có SĐT (D-002); không thu ngày sinh/giới tính (schema `submitBodySchema` trong `apps/backend/src/lib/checkout/http.ts`).
- Không tạo tài khoản hay gộp lịch sử vì email trùng; không tiết lộ email đã có tài khoản.
- Tra cứu đơn: mã đơn + SĐT KHÔNG trả dữ liệu đơn; chỉ gửi liên kết một lần 15 phút tới SĐT/email đã dùng; luôn 202 cùng thông điệp. Hai loại token, vị trí khác nhau: (1) **token liên kết** (một lần, 15 phút) nằm trên URL `/tra-cuu-don/xac-thuc?token=…` trong thư/SMS; trang đó không tự đổi token khi GET, `Referrer-Policy: no-referrer` (`apps/storefront/next.config.ts` `NO_REFERRER_SOURCES`), khách bấm nút → Server Action gọi `POST /store/x/orders/session` với token trong thân JSON; (2) **token phiên đơn** nằm ở cookie HttpOnly phía storefront và storefront chuyển cho backend qua header `x-order-access`, không bao giờ trên URL (`apps/storefront/src/lib/orders/service.ts`) — `apps/backend/integration-tests/http/order-lookup.spec.ts`.
- Phản hồi riêng tư `Cache-Control: private, no-store`; service worker không cache trang riêng tư — `apps/storefront/src/lib/pwa/cache-policy.test.ts`.
- PII không vào audit/log: `sanitizeChanges` che theo tên khoá và theo giá trị — `apps/backend/src/lib/audit/__tests__/sanitize.unit.spec.ts`; IP trong audit/bộ đếm chỉ ở dạng băm.
- Ghi chú tự do khi trả ra route Admin/Store đi qua `maskFreeText` (D-036; heuristic, có thể sót địa chỉ không có cụm báo hiệu) — `apps/backend/src/lib/audit/sanitize.ts`.
- Admin: vai trò CSKH xem dữ liệu đã che; kho không thấy liên hệ/địa chỉ khách ở chi tiết đổi trả — `apps/backend/integration-tests/http/returns-privacy.spec.ts`, `apps/backend/integration-tests/http/rbac.spec.ts`.
- Xuất dữ liệu hàng loạt cần quyền riêng + audit (xuất catalog `GET /admin/x/exports/products.csv` không chứa PII khách).

## 6. Biện pháp bảo vệ
| Biện pháp | Mô tả | Bằng chứng |
|---|---|---|
| Mã hoá khi truyền | HSTS ở production; TLS do hạ tầng (chưa có) | `apps/backend/src/lib/security/headers.ts`; chờ hạ tầng (THREAT-MODEL O-03) |
| Mã hoá khi lưu | chưa mã hoá cột PII ở tầng ứng dụng; dựa vào mã hoá đĩa/managed DB | chưa chứng minh — chờ hạ tầng |
| Kiểm soát truy cập | RBAC map tập trung fail-closed; MFA cho quyền nhạy cảm; hoàn tiền hai người | `apps/backend/src/api/admin/x/permissions.ts`; `apps/backend/integration-tests/http/rbac.spec.ts`; `apps/backend/integration-tests/http/mfa.spec.ts` |
| Log kiểm toán | audit append-only, ghi từ chối quyền (gộp bộ đếm) | `apps/backend/integration-tests/http/audit.spec.ts` |
| Chống dò dữ liệu | rate limit cửa sổ trượt; 404 đồng nhất; so sánh băm hằng thời gian | `apps/backend/src/lib/security/sliding-window.ts`; `apps/backend/integration-tests/http/order-lookup.spec.ts` |
| Backup, khôi phục | diễn tập restore cục bộ; PITR/backup thật chờ hạ tầng | `docs/ops/RUNBOOK.md` mục 4 |
| Sự cố và thông báo vi phạm | RUNBOOK có mục liên lạc; **quy trình thông báo vi phạm dữ liệu cá nhân (thời hạn, mẫu, cơ quan) chưa có** — theo văn bản gốc (chưa xác minh) | `docs/ops/RUNBOOK.md` mục 0 |

## 7. Đánh giá rủi ro cho chủ thể dữ liệu
| ID | Rủi ro | Khả năng | Mức | Biện pháp | Rủi ro còn lại | Trạng thái |
|---|---|---|---|---|---|---|
| DP-01 | Lộ đơn của khách khác (IDOR/dò mã đơn) | Thấp | Cao | token đơn + 404 đồng nhất + rate limit (THREAT-MODEL T-06) | thấp | giảm thiểu |
| DP-02 | PII qua cache dùng chung | Thấp | Cao | `no-store`, SW không cache (T-07) | thấp | giảm thiểu |
| DP-03 | Nhân viên xem/xuất PII quá mức | Trung | Trung | RBAC, che dữ liệu, audit (T-09, T-16) | trung bình: nhân viên đơn thấy dữ liệu giao hàng cần thiết | giảm thiểu |
| DP-04 | Gửi cho bên thứ ba vượt cần | Thấp | Trung | adapter chỉ gửi trường cần (VNPAY không nhận tên/SĐT/địa chỉ) | cần DPA với GHN/VNPAY/email-SMS | chờ chủ dự án |
| DP-05 | Lưu quá lâu (nhiều bảng chưa có job xoá — §3) | Cao | Trung | chỉ giảm bằng job + ẩn danh | **còn mở** | cần quyết định thời hạn rồi viết job |
| DP-06 | PII trong ghi chú tự do không bị che hết | Trung | Thấp | `maskFreeText` heuristic khi trả ra; audit che lúc ghi | địa chỉ không có cụm báo hiệu có thể sót | chấp nhận có điều kiện |
| DP-07 | Chưa có luồng xoá/truy cập/xuất theo yêu cầu chủ thể | Trung | Trung | quy trình thủ công qua CSKH (§4) | thiếu tự động hoá, chưa có test `rights-*` | còn mở |
| DP-08 | Lộ dữ liệu do sự cố hạ tầng (DB/backup/log) | Thấp | Cao | hạ tầng thật chưa có; dựa vào kiểm soát truy cập, mã hoá đĩa | chưa chứng minh | chờ hạ tầng |
| DP-09 | Lộ liên kết tra cứu (đường email/SMS) | Thấp | Trung | một lần, 15 phút, token băm khi lưu | người có quyền đọc hộp thư/SMS | chấp nhận |

## 8. Tự đánh giá tuân thủ (kỹ thuật)
| Yêu cầu | Đạt / Chưa / N/A | Bằng chứng |
|---|---|---|
| Danh mục dữ liệu cá nhân theo bảng/cột | Đạt — `docs/privacy/data-map.yaml` + `docs/compliance/data-inventory.csv`, đối chiếu máy với migration (`node scripts/check-data-map.mjs`) | §1 |
| Thông báo xử lý cho chủ thể trước khi xử lý | Chưa — trang `/bao-mat` do chủ shop duyệt | §4 |
| Đồng ý cho từng mục đích (marketing/cookie) | N/A cho marketing (không thu); analytics đồng ý ở client | §1 |
| Thời hạn lưu có job thực thi | Chưa — mới có job cho bộ đếm/dấu đổi liên kết | §3 |
| Hợp đồng với bên xử lý có điều khoản bảo vệ dữ liệu | Chưa | §9 |
| Hồ sơ nộp đúng hạn, cập nhật đúng nhịp | Chưa nộp; nghĩa vụ (chưa xác minh) | §9 |
| Chuyển dữ liệu ra nước ngoài có hồ sơ riêng | Chưa xác định | §2 |

## 9. Việc chờ chủ dự án / pháp chế
1. Đối chiếu văn bản gốc: Luật 91/2025/QH15 (hiệu lực, điều khoản), NĐ 356/2025/NĐ-CP và NĐ 13/2023/NĐ-CP (còn hiệu lực hay không), nghĩa vụ lập/nộp hồ sơ đánh giá tác động, thời hạn, mẫu, cơ quan tiếp nhận; thời hạn và quy trình thông báo vi phạm.
2. Chốt thời hạn lưu theo từng loại dữ liệu (đặc biệt chứng từ kế toán/đơn hàng) → phiên chính viết job xoá/ẩn danh + test seed quá hạn (STD-PRIV-005).
3. Điền pháp nhân, liên hệ, người phụ trách bảo vệ dữ liệu; kênh nhận yêu cầu chủ thể và thời hạn phản hồi.
4. Ký DPA với VNPAY, GHN, nhà cung cấp email/SMS (chưa chọn); xác định nơi lưu trữ dữ liệu và chuyển ra nước ngoài (nếu có).
5. Duyệt chính sách quyền riêng tư công khai (`/bao-mat`) và nội dung đồng ý (không tick sẵn, nếu thu marketing).
6. Chọn hạ tầng: mã hoá at-rest, TLS Postgres, backup/PITR, log tập trung và thời hạn log (THREAT-MODEL O-03).

## 10. Ký
| Vai trò | Tên | Ngày |
|---|---|---|
| Người lập (kỹ thuật) | phiên chính — hồ sơ kỹ thuật | 2026-10-26 |
| Đại diện pháp nhân | chưa ký | |
| Luật sư/pháp chế rà | chưa ký | |
