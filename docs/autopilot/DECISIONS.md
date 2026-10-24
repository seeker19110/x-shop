# Nhật ký quyết định tự duyệt

> Ghi bởi `xt.py loop decide`. Phiên chính tự duyệt điểm quyết định theo tiêu chí chất lượng cuối (`LOOP-STOP-018`, ADR-0008 của khung). Người xem lại bất cứ lúc nào; đổi ý → quyết định mới ghi "thay D-NNN", không sửa mục cũ.

### D-001 · 2026-10-24T16:49:09+00:00 · Duyệt G0–G3: PROJECT.md + SPEC-*.md lấy đặc tả gốc làm nguồn chuẩn

- Phương án: (1) Viết lại toàn bộ đặc tả thành SPEC mới · (2) Giữ DAC-TA-GOC.md làm nguồn, SPEC chỉ bổ sung G/W/T + ca biên + quyết định lấp chỗ hở
- Chọn: Giữ DAC-TA-GOC.md làm nguồn, SPEC chỉ bổ sung G/W/T + ca biên + quyết định lấp chỗ hở
- Lý do (tiêu chí chất lượng cuối): Một nguồn sự thật, không lệch; SPEC kiểm được trỏ về mã yêu cầu gốc
- Đường lùi: Tách thêm SPEC chi tiết khi một lát cần

### D-002 · 2026-10-24T16:49:09+00:00 · Lấp chỗ hở đặc tả §16.3

- Phương án: (1) Chờ chủ dự án quyết từng mục · (2) Mặc định cấu hình được: token thương hiệu thay được; email tùy chọn khi có SĐT + outbox log; TTL online 15 phút, COD xác nhận 24 giờ; idempotency key 24 giờ; khóa Locking Module theo inventory_item sắp xếp + UNIQUE(cart_id,cart_version); phân bổ largest remainder
- Chọn: Mặc định cấu hình được: token thương hiệu thay được; email tùy chọn khi có SĐT + outbox log; TTL online 15 phút, COD xác nhận 24 giờ; idempotency key 24 giờ; khóa Locking Module theo inventory_item sắp xếp + UNIQUE(cart_id,cart_version); phân bổ largest remainder
- Lý do (tiêu chí chất lượng cuối): Không chặn build; mọi giá trị là cấu hình có version, an toàn theo cách hiểu chặt hơn
- Đường lùi: Đổi cấu hình, không đổi mã

### D-003 · 2026-10-24T16:49:09+00:00 · Trạng thái tài chính đơn điệu

- Phương án: (1) Áp trạng thái theo callback mới nhất · (2) Chỉ chuyển trạng thái hợp lệ theo máy trạng thái; không lùi captured→pending
- Chọn: Chỉ chuyển trạng thái hợp lệ theo máy trạng thái; không lùi captured→pending
- Lý do (tiêu chí chất lượng cuối): Callback trễ/sai thứ tự không làm mất tiền (đặc tả §6.1)
- Đường lùi: Không cần — bất biến của đặc tả

### D-004 · 2026-10-24T16:49:10+00:00 · Tìm/lọc cùng SKU P0

- Phương án: (1) API list native Medusa · (2) Read model Postgres catalog_variant_index (1 dòng/SKU, pg_trgm, unaccent tự chuẩn hóa) · (3) Meilisearch ngay
- Chọn: Read model Postgres catalog_variant_index (1 dòng/SKU, pg_trgm, unaccent tự chuẩn hóa)
- Lý do (tiêu chí chất lượng cuối): Native không lọc cùng SKU + giá SKU khớp; Postgres đủ ở P0, ít hạ tầng; engine riêng chỉ khi benchmark yêu cầu
- Đường lùi: Thay adapter search bằng Meilisearch qua ADR

### D-005 · 2026-10-24T16:49:10+00:00 · Stack + xử lý phát hiện nghiên cứu (RBAC Enterprise, webhook tự hoàn tất giỏ)

- Phương án: (1) Bật RBAC Enterprise + dùng webhook native · (2) pnpm monorepo, Medusa 2.22 + Next 16, RBAC tự xây, MFA TOTP native, IPN VNPAY route riêng, Locking Redis
- Chọn: pnpm monorepo, Medusa 2.22 + Next 16, RBAC tự xây, MFA TOTP native, IPN VNPAY route riêng, Locking Redis
- Lý do (tiêu chí chất lượng cuối): Không vi phạm giấy phép Enterprise; tránh AT35 (tạo đơn/reservation lần hai); theo starter chính thức
- Đường lùi: ADR-0001 §Phương án: thay lõi commerce bằng service tự viết, giữ packages/domain
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Production: Postgres/Redis managed có backup PITR; object storage S3 + CDN

### D-006 · 2026-10-24T16:49:10+00:00 · Duyệt PLAN đợt 1 (38 task, 7 lát)

- Phương án: (1) Làm UI 6 màn trước rồi giao dịch · (2) Nền tảng → lõi domain → spike giao dịch Medusa (cổng dừng RK-001) → catalog → UI → vận hành → hoàn thiện
- Chọn: Nền tảng → lõi domain → spike giao dịch Medusa (cổng dừng RK-001) → catalog → UI → vận hành → hoàn thiện
- Lý do (tiêu chí chất lượng cuối): Rủi ro cao nhất (tiền/tồn trên Medusa) chứng minh trước khi đầu tư UI giao dịch; lõi thuần rẻ và test nhanh
- Đường lùi: Đổi thứ tự lát trong PLAN

### D-007 · 2026-10-24T17:15:27+00:00 · Env backend dev/test và build

- Phương án: (1) Bắt buộc mọi biến ở mọi môi trường, thêm biến giả vào CI · (2) Production bắt buộc đủ bí mật/CORS/Redis/MFA key; dev/test chỉ bắt buộc DATABASE_URL; build image truyền DATABASE_URL giả; danh sách biến ở docs/ops/ENV.md vì .env.example bị chặn ghi
- Chọn: Production bắt buộc đủ bí mật/CORS/Redis/MFA key; dev/test chỉ bắt buộc DATABASE_URL; build image truyền DATABASE_URL giả; danh sách biến ở docs/ops/ENV.md vì .env.example bị chặn ghi
- Lý do (tiêu chí chất lượng cuối): Production vẫn fail-closed; CI/dev không cần bí mật giả rải rác; ENV.md + schema zod là nguồn chuẩn
- Đường lùi: Siết schema env cho mọi môi trường
