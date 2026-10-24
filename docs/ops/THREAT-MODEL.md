# THREAT-MODEL — x-shop · phiên bản 0.1 (nháp) · 2026-10-24

> Chủ: phiên chính · Duyệt: chưa (hoàn tất ở T-038) · Phạm vi: storefront Next.js, Medusa server/worker + Admin,
> Postgres, Redis, VNPAY, GHN, email/SMS · Ngoài phạm vi: hạ tầng cloud cụ thể (chưa chọn — chủ dự án), CDN của bên thứ ba.
> Cột "Bằng chứng" trỏ test/cấu hình sẽ có; "kế hoạch" = chưa có, task sở hữu ghi kèm.

## 1. Tài sản
| ID | Tài sản | Phân loại | Ảnh hưởng nếu lộ / sửa / mất |
|---|---|---|---|
| A-01 | PII khách: họ tên, SĐT, email, địa chỉ | cá nhân cơ bản (Luật 91/2025/QH15) | pháp lý, uy tín, lừa đảo giao hàng |
| A-02 | Tiền: ledger thu/hoàn, trạng thái thanh toán | toàn vẹn | mất tiền, giao hàng chưa thu |
| A-03 | Tồn kho, reservation | toàn vẹn/sẵn sàng | bán vượt, kẹt hàng |
| A-04 | Bí mật: hash secret VNPAY, token GHN, JWT/cookie secret, khóa MFA | bí mật | giả IPN, chiếm admin |
| A-05 | Tài khoản admin và quyền | toàn vẹn | toàn quyền shop |
| A-06 | Giá, khuyến mãi, hạn mức coupon | toàn vẹn | bán lỗ |
| A-07 | Audit log | toàn vẹn | mất truy vết |

## 2. Thành phần, ranh giới, luồng
```text
[Trình duyệt/PWA] --(1) HTTPS--> [Next.js storefront] --(2)--> [Medusa server] --(3)--> [Postgres]
        |                                                         |--(4)--> [Redis: lock, event, workflow]
        |--(5) redirect--> [VNPAY] --(6) IPN GET--> [Medusa /x/webhooks/vnpay/ipn]
[Admin (host riêng)] --(7) HTTPS + MFA--> [Medusa /admin]       |--(8)--> [GHN API] <--(9) callback-- [GHN]
                                                                  |--(10)--> [Email/SMS provider]
TB1 Internet↔storefront/API · TB2 API↔DB/Redis · TB3 API↔VNPAY/GHN/email · TB4 Admin↔API
```

## 3. Kẻ tấn công giả định
| Ai | Năng lực | Mục tiêu |
|---|---|---|
| Khách gian lận | trình duyệt, sửa request, nhiều tab/script | giảm giá trái phép, đặt hàng không trả, xem đơn người khác |
| Bot | tốc độ cao, nhiều IP | vét tồn/coupon, dò mã đơn, nhồi đăng nhập admin |
| Kẻ giả IPN/callback | biết endpoint | đánh dấu đã trả/đã giao giả |
| Nhân viên vượt quyền | tài khoản admin vai trò thấp | hoàn tiền, xuất PII |
| Kẻ đánh cắp phiên | XSS/CSRF, cache dùng chung | chiếm giỏ/đơn/admin |

## 4. STRIDE theo luồng
| ID | Luồng | Loại | Mối đe doạ | Mức | Biện pháp | Bằng chứng | Trạng thái |
|---|---|---|---|---|---|---|---|
| T-01 | 6 | Spoofing | IPN giả đánh dấu đã trả | Cao | HMAC-SHA512 + so tmn/ref/amount; inbox audit | `packages/domain/.../vnpay.test.ts` (AT07); `payment-ipn` (T-011) | một phần |
| T-02 | 6 | Repudiation/Tampering | IPN lặp ghi thu nhiều lần | Cao | UNIQUE(provider, txn_id, kind), inbox dedupe | `payment-ipn` AT06 (T-011) | kế hoạch |
| T-03 | 5 | Tampering | Redirect "thành công" giả qua URL | Cao | return URL không đổi trạng thái tiền | AT08 (T-011, T-021) | kế hoạch |
| T-04 | 1–2 | Tampering | Client gửi tổng tiền/giá tùy ý | Cao | submit không nhận total; server `computeQuote` + `diffQuotes` | `quote.test.ts` AT03; `checkout-submit` (T-010) | một phần |
| T-05 | 1–2 | DoS/Tampering | Vét tồn/coupon bằng submit song song | Cao | khóa Locking Module + UNIQUE + quota dưới khóa | AT04, AT33 (T-010) | kế hoạch |
| T-06 | 1–2 | Info disclosure | IDOR: xem đơn/giỏ/đổi trả người khác | Cao | sở hữu kiểm ở server; mã đơn+SĐT không đủ; 404 không phân biệt; rate limit | AT20 (T-021, T-034) | kế hoạch |
| T-07 | 1, PWA | Info disclosure | CDN/SW cache trang riêng tư | Cao | `private, no-store`; SW chỉ cache công khai | AT22 (T-032) | kế hoạch |
| T-08 | 7 | Spoofing/EoP | Chiếm admin bằng mật khẩu | Cao | MFA TOTP native bắt buộc, rate limit, phiên ngắn | `mfa` (T-024) | kế hoạch |
| T-09 | 7 | EoP | Kho gọi API hoàn tiền | Cao | RBAC ở mọi `/admin/x/*`, test sinh ma trận | AT21 `rbac` (T-023) | kế hoạch |
| T-10 | 9 | Spoofing | Callback GHN giả "đã giao"/COD | Trung | không tin callback: tra lại API có token trước khi áp | S-305 (T-026) | kế hoạch |
| T-11 | 1 | Tampering/XSS | Nội dung rich text/CMS chèn script | Trung | sanitize, CSP, React escape | T-034 | kế hoạch |
| T-12 | 1 | Info disclosure | PII trong log/analytics/URL | Trung | che PII, sự kiện không PII, token rời URL | AT29 (T-033), log redaction (T-025) | kế hoạch |
| T-13 | 3–4 | Info disclosure | Lộ secret qua bundle/log/commit | Cao | env tách server/client, gitleaks CI, schema env che bí mật | `secret-scan.yml`; env tests (T-002, T-003) | một phần |
| T-14 | upload | Tampering/SSRF | Ảnh/CSV độc, URL ảnh trỏ nội bộ | Trung | kiểm MIME/kích thước, allowlist host ảnh, CSV chống công thức | T-015, T-034 | kế hoạch |
| T-15 | 4 | DoS | Mất Redis → bán bằng tồn cache/khóa giả | Cao | mất khóa → dừng checkout cần giữ tồn, vẫn cho xem catalog | runbook + restore drill (T-037) | kế hoạch |
| T-16 | 2 | Repudiation | Thao tác nhạy cảm không truy vết | Trung | audit log append-only actor/lý do | T-025 | kế hoạch |
