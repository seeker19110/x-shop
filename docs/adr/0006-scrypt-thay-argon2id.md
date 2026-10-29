# ADR-0006 — Băm mật khẩu admin bằng scrypt (tham số OWASP) thay cho Argon2id (BE-AUTH-001)

## Trạng thái

Accepted (2026-10-29), theo Q-01 của `docs/autopilot/PLAN-2.md` (duyệt ở D-045), D-136 (N = 2^17 mọi môi trường, không biến hạ tham số cho test), D-137 (băm lại khi đăng nhập); task T-181.

## Ngày

2026-10-29

## Bối cảnh

BE-AUTH-001 đòi băm mật khẩu bằng Argon2id với tham số ≥ OWASP; scrypt chỉ được dùng khi nền tảng không có Argon2id. Mật khẩu admin của x-shop do Auth Module của Medusa 2.22.1 (ADR-0004) xử lý qua provider `@medusajs/auth-emailpass` 2.22.1, được dự án bọc lại để cân thời gian phản hồi (`apps/backend/src/lib/admin-security/emailpass/`, BE-AUTH-003). Provider này băm bằng thư viện `scrypt-kdf` 2.0.1 (gọi `crypto.scrypt` của Node/OpenSSL), lưu chuỗi base64 96 byte định dạng scrypt-kdf (header "scrypt" · phiên bản · logN · r · p · salt 32 byte · checksum · HMAC) trong `provider_identity.provider_metadata.password`; không có lựa chọn Argon2id. Tham số duy nhất cấu hình được là `hashConfig` (`logN`, `r`, `p`), mặc định `{ logN: 15, r: 8, p: 1 }` (N = 2^15, 32 MiB).

OWASP Password Storage Cheat Sheet (tra `cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html` ngày 2026-10-29): Argon2id tối thiểu m = 19 MiB, t = 2, p = 1; khi không có Argon2id thì scrypt tối thiểu N = 2^17 (128 MiB), r = 8 (1024 byte), p = 1 — hoặc các tổ hợp tương đương N = 2^16/p = 2, N = 2^15/p = 3, N = 2^14/p = 5, N = 2^13/p = 10. Mặc định của Medusa thấp hơn mức này. Dự án không tự viết mật mã (`custom_crypto=false`).

## Phương án đã cân nhắc

1. Giữ mặc định Medusa (logN 15, r 8, p 1) — loại: thấp hơn mức tối thiểu OWASP cho scrypt.
2. Giữ scrypt của `auth-emailpass`, nâng `hashConfig` lên mức tối thiểu OWASP N = 2^17, r = 8, p = 1, cấu hình trong `apps/backend/medusa-config.ts` — chọn.
3. Giữ scrypt, dùng tổ hợp tương đương ít bộ nhớ hơn (N = 2^16, r = 8, p = 2: 64 MiB, cùng khối lượng tính vì OpenSSL chạy p tuần tự) — không chọn ở bước này: đúng nguyên văn mức đầu bảng OWASP đơn giản hơn để kiểm; là đường chỉnh nếu áp lực bộ nhớ ở production thành vấn đề (xem Điều kiện đọc lại).
4. Viết auth provider Argon2id tuỳ biến (thư viện băm mới, chuỗi PHC `$argon2id$`) — loại lúc này: thêm phụ thuộc mật mã gốc (native) và mã tự viết quanh luồng đăng nhập admin, rủi ro khoá đăng nhập admin, phải tự lo di trú hash cũ; Medusa chưa hỗ trợ sẵn.

## Quyết định

Giữ scrypt của `@medusajs/auth-emailpass` làm ngoại lệ so với khuyến nghị Argon2id (nền tảng không cung cấp Argon2id). Truyền `hashConfig = { logN: 17, r: 8, p: 1 }` cho provider `emailpass` ở MỌI môi trường; hằng số đặt một chỗ ở `apps/backend/src/lib/admin-security/password-hash.ts` (`EMAILPASS_HASH_CONFIG`, `OWASP_SCRYPT_MIN`, `meetsOwaspScryptMinimum`). Không có biến môi trường hạ tham số, kể cả trong test (D-136).

Băm lại khi đăng nhập (D-137): bản bọc `TimingSafeEmailPassAuthService` đọc tham số từ header của chuỗi băm đang lưu (`scryptParamsFromHash`, chỉ phân tích định dạng); sau khi provider gốc kiểm mật khẩu ĐÚNG, nếu tham số dưới mức tối thiểu OWASP và cấu hình hiện hành đạt mức đó (`needsRehash`) thì băm lại bằng chính `hashPassword` của provider và ghi qua `AuthIdentityProviderService.update` theo kiểu so-và-ghi — đọc lại identity, chỉ ghi khi hash trong DB vẫn là hash vừa kiểm (đổi/đặt lại mật khẩu xảy ra trước đó không bị ghi đè bằng mật khẩu cũ). Lỗi khi băm lại chỉ ghi log cảnh báo (không email, không thông điệp lỗi), đăng nhập vẫn thành công. Hash đã đạt chuẩn không bị băm lại.

Kiểm bằng máy: `apps/backend/integration-tests/http/password-hash.spec.ts` đọc chuỗi băm thật trong DB sau đăng ký và sau đổi mật khẩu qua token đặt lại, giải header scrypt-kdf và khẳng định logN 17 / r 8 / p 1; khẳng định hash tạo bằng tham số cũ (logN 15) vẫn đăng nhập được, đăng nhập sai không đổi hash, đăng nhập đúng nâng hash lên logN 17, hai đăng nhập song song đều thành công với hash cuối hợp lệ; khẳng định server đang chạy truyền đúng `hashConfig`. Test đơn vị `apps/backend/src/lib/admin-security/__tests__/password-rehash.unit.spec.ts` phủ lỗi khi ghi và ca mật khẩu bị đổi giữa lúc kiểm và lúc ghi.

## Hệ quả

- Tương thích ngược không cần migration: `scrypt-kdf.verify` đọc tham số từ header của từng chuỗi băm, nên hash cũ (logN 15) vẫn kiểm được. Hash cũ được nâng lên logN 17 ở lần đăng nhập đúng đầu tiên (D-137) hoặc khi đổi/đặt lại mật khẩu. Tới lúc đó, đăng nhập SAI vào tài khoản còn hash cũ nhanh hơn ca email không tồn tại (identity mồi băm bằng logN 17) — chênh lệch thời gian lộ "tài khoản có hash cũ tồn tại"; trước G7 chưa có tài khoản admin production nên rủi ro này hiện chỉ là lý thuyết. Lần đăng nhập đúng có băm lại tốn thêm một lần băm (~0,5 s).
- So-và-ghi khi băm lại không nguyên tử ở mức DB (đọc lại rồi ghi qua dịch vụ identity của Auth Module, không khoá hàng): còn một cửa sổ cỡ một vòng truy vấn trong đó đặt lại mật khẩu chen vào giữa lần đọc lại và lần ghi có thể bị ghi đè bằng hash của mật khẩu cũ. Cửa sổ trước khi đọc lại (gồm ~0,5 s băm) đã được chặn.
- Chi phí mỗi lần băm/kiểm tăng khoảng 4 lần (đo trên máy dev 4 nhân: ~120 ms → ~470–560 ms một lần băm; đăng nhập HTTP ~0,6 s) và 128 MiB bộ nhớ ngoài heap V8 cho mỗi lần băm đang chạy.
- Định cỡ bộ nhớ: `crypto.scrypt` chạy trên thread pool của libuv, nên số lần băm đồng thời mỗi tiến trình ≤ `UV_THREADPOOL_SIZE` (mặc định 4). Bộ nhớ đỉnh cho băm ≈ 128 MiB × `UV_THREADPOOL_SIZE` (mặc định ≈ 512 MiB) mỗi tiến trình server/worker, cộng heap V8. Giới hạn bộ nhớ container phải chừa phần này; tăng `UV_THREADPOOL_SIZE` thì tăng tương ứng. Rate limit đăng nhập/đăng ký/đặt lại (`apps/backend/src/lib/admin-security/config.ts`, BE-AUTH-003) là lớp chặn lạm dụng tốn tài nguyên.
- Test tích hợp tạo nhiều admin chậm hơn (đo trên máy dev: 6 suite nặng xác thực nhất — audit-security-events, security, security-register, private-file-security, mfa, default-credentials — từ ~450 s lên ~727 s); không hạ tham số trong test để test chạy đúng cấu hình production.
- Không đạt nguyên văn Kiểm của BE-AUTH-001 (tiền tố `$argon2id$`, chuỗi PHC): đây là ngoại lệ có chủ đích; định dạng scrypt-kdf vẫn lưu tham số trong chuỗi băm nên nâng cấp dần được.
- Đường lùi: bỏ `options.hashConfig` khỏi `medusa-config.ts` (về mặc định Medusa); hash đã tạo ở logN 17 vẫn kiểm được vì tham số nằm trong chuỗi.

## Điều kiện đọc lại

- Medusa (hoặc provider chính thức) hỗ trợ Argon2id → chuyển sang Argon2id theo phương án 4 kèm di trú dần.
- OWASP nâng mức tối thiểu cho scrypt.
- Bộ nhớ/độ trễ đăng nhập ở production thành vấn đề (cân nhắc phương án 3) hoặc có tài khoản admin còn hash cũ lâu không đăng nhập (cân nhắc buộc đặt lại mật khẩu).
- Có bằng chứng cửa sổ so-và-ghi khi băm lại bị khai thác, hoặc Auth Module cung cấp cập nhật có điều kiện/khoá → làm so-và-ghi nguyên tử.
