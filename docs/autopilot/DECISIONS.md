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

### D-008 · 2026-10-24T18:04:15+00:00 · Storefront: menu danh mục, URL biến thể, canonical lọc, import domain phía client

- Phương án: (1) Endpoint danh mục backend ngay; router.replace; canonical lọc về gốc; client import @x-shop/domain · (2) Menu cấu hình + lọc theo dữ liệu (endpoint /store/x/categories bổ sung ở T-040); replaceState cho biến thể; URL lọc canonical chính nó + noindex,follow, danh mục gốc index; client không import giá trị từ domain (bản phản chiếu có test đối chiếu + test quét bundle), domain sideEffects:false
- Chọn: Menu cấu hình + lọc theo dữ liệu (endpoint /store/x/categories bổ sung ở T-040); replaceState cho biến thể; URL lọc canonical chính nó + noindex,follow, danh mục gốc index; client không import giá trị từ domain (bản phản chiếu có test đối chiếu + test quét bundle), domain sideEffects:false
- Lý do (tiêu chí chất lượng cuối): Giữ ngân sách JS (import domain phía client +139 KiB); không tải lại RSC mỗi lần chọn size; noindex cho URL lọc theo hướng dẫn faceted navigation của Google; endpoint danh mục là bổ sung không chặn
- Đường lùi: Bật lại import trực tiếp khi domain có subpath export tree-shake được; đổi canonical bằng một chỗ trong metadata

### D-009 · 2026-10-24T18:07:38+00:00 · Checkout trên Medusa: chặn POST /store/carts/:id/complete native; kiểu cột tiền

- Phương án: (1) Bỏ chặn route complete; cột bigint + lớp ép kiểu · (2) Giữ chặn route complete (đường tạo đơn vòng qua checkout); cột integer có trần 2.147.483.647 đ, vượt → 422 LIMIT; tổng hợp tính ở ứng dụng
- Chọn: Giữ chặn route complete (đường tạo đơn vòng qua checkout); cột integer có trần 2.147.483.647 đ, vượt → 422 LIMIT; tổng hợp tính ở ứng dụng
- Lý do (tiêu chí chất lượng cuối): Chặn mọi đường tạo đơn không qua giữ hàng/idempotency (đúng hơn, an toàn hơn); đơn thời trang không chạm trần, trần là lỗi rõ chứ không sai tiền; tránh lỗi ép kiểu chuỗi int8 của MikroORM
- Đường lùi: Migration expand sang bigint + ép kiểu khi mở bán sỉ giá trị lớn

### D-010 · 2026-10-24T19:48:14+00:00 · Ghi tồn qua route admin native (inventory-items, reservations)

- Phương án: (1) Giữ quyền inventory.adjust, chấp nhận đường vòng INV03 · (2) Chỉ owner (settings.manage); kho dùng /admin/x/inventory/adjustments có lý do + idempotency + khóa + không dưới reserved
- Chọn: Chỉ owner (settings.manage); kho dùng /admin/x/inventory/adjustments có lý do + idempotency + khóa + không dưới reserved
- Lý do (tiêu chí chất lượng cuối): Mọi điều chỉnh tồn phải có lý do/người/khóa (INV03, đặc tả §6.2); mất tiện ích sửa tồn trên dashboard native cho vai trò kho là chấp nhận được
- Đường lùi: Đổi 2 dòng trong native-permissions.ts

### D-011 · 2026-10-24T20:13:24+00:00 · GHN_MODE ở production

- Phương án: (1) Cho mock ở production, chỉ cảnh báo · (2) Production bắt buộc sandbox|live, cấm mock, URL https
- Chọn: Production bắt buộc sandbox|live, cấm mock, URL https
- Lý do (tiêu chí chất lượng cuối): Production chạy mock sẽ tạo vận đơn giả — fail-closed như VNPAY
- Đường lùi: Nới schema env

### D-012 · 2026-10-24T20:13:25+00:00 · Khách hủy đơn đã thu tiền (POST02)

- Phương án: (1) Gọi cancelOrderWorkflow native ngay (ghi refund native giả) · (2) order_finance=cancelled + nhả reservation + mở refund_request; đơn native hủy cùng lúc hoàn tiền thật ở T-027; fulfillment chặn theo order_finance.state · (3) Không cho khách tự hủy đơn đã trả
- Chọn: order_finance=cancelled + nhả reservation + mở refund_request; đơn native hủy cùng lúc hoàn tiền thật ở T-027; fulfillment chặn theo order_finance.state
- Lý do (tiêu chí chất lượng cuối): Ledger không được báo đã hoàn khi tiền chưa hoàn; khách vẫn tự hủy được trước giao
- Đường lùi: Chặn tự hủy đơn đã trả ở route cancel

### D-013 · 2026-10-25T01:54:51+00:00 · PWA: service worker cache trang công khai có query string / trang render động (T-032)

- Phương án: (1) Cache theo URL đầy đủ kể cả query; đặt Cache-Control public cho /danh-muc, /san-pham · (2) Không cache URL có query; tôn trọng Cache-Control private/no-store của Next nên trang động chỉ online; chỉ / và trang chính sách + asset tĩnh offline
- Chọn: Không cache URL có query; tôn trọng Cache-Control private/no-store của Next nên trang động chỉ online; chỉ / và trang chính sách + asset tĩnh offline
- Lý do (tiêu chí chất lượng cuối): An toàn trước: không lưu tham số nhạy cảm, không cache nhầm nội dung riêng tư; AT22/AT24 vẫn đạt với fallback /offline
- Đường lùi: Đặt Cache-Control public cho 2 route kèm test header + bỏ chặn query trong XSPolicy (public/sw.js)

### D-014 · 2026-10-25T01:54:52+00:00 · Diễn tập restore (T-037): nguồn danh sách giao dịch provider sau mốc snapshot

- Phương án: (1) Mô phỏng bằng bản ghi DB nguồn trong cửa sổ mốc−300 s + diff nguồn/đích · (2) File mẫu theo định dạng xuất thật VNPAY/GHN
- Chọn: Mô phỏng bằng bản ghi DB nguồn trong cửa sổ mốc−300 s + diff nguồn/đích
- Lý do (tiêu chí chất lượng cuối): Định dạng xuất thật chưa xác minh (tài liệu chính thức không truy cập được); cách 1 kiểm độc lập được, đổi sang file thật chỉ cần một mã mỗi dòng
- Đường lùi: Thay đầu vào post-restore-reconcile.sh bằng file xuất provider khi có khoá merchant

### D-015 · 2026-10-25T02:09:22+00:00 · T-041: attempt trong VNPAY_RETURN_URL là id nào

- Phương án: (1) checkout attempt id (theo API-CONTRACT, route /thanh-toan/ket-qua sẵn có) · (2) payment attempt id (cần endpoint tra cứu mới)
- Chọn: checkout attempt id (theo API-CONTRACT, route /thanh-toan/ket-qua sẵn có)
- Lý do (tiêu chí chất lượng cuối): Không mở endpoint mới dễ thành chỗ dò tồn tại đơn; mỗi đơn hiện một payment attempt nên tương đương
- Đường lùi: Thêm tham số pa= khi một đơn có nhiều payment attempt

### D-016 · 2026-10-25T02:09:22+00:00 · T-041: purchase COD bắn lúc nào, dedupe ở đâu

- Phương án: (1) placed + sessionStorage · (2) confirmed/completed + localStorage theo order_id
- Chọn: confirmed/completed + localStorage theo order_id
- Lý do (tiêu chí chất lượng cuối): order_placed đã phủ thời điểm đặt; localStorage chống đếm trùng khi mở lại trang đơn ở phiên sau (AT29)
- Đường lùi: Đổi trạng thái kích hoạt/kho lưu trong purchase-event.ts

### D-017 · 2026-10-25T02:09:23+00:00 · T-041: bộ đếm gộp audit lần bị từ chối RBAC

- Phương án: (1) Redis SecurityStore · (2) Bảng rate_limit_counter Postgres, gộp theo lớp route trong cửa sổ 60 s, ghi ở lần 1/10/100; lỗi bộ đếm vẫn ghi audit
- Chọn: Bảng rate_limit_counter Postgres, gộp theo lớp route trong cửa sổ 60 s, ghi ở lần 1/10/100; lỗi bộ đếm vẫn ghi audit
- Lý do (tiêu chí chất lượng cuối): Gộp theo đường dẫn bị lách bằng đổi id; Postgres giữ cách ly test và fail-open về phía ghi audit (an toàn hơn)
- Đường lùi: Thay backend bộ đếm trong lib/audit/deny-throttle.ts

### D-018 · 2026-10-25T02:25:39+00:00 · T-027: duyệt hoàn tiền 2 người — ngưỡng và quyền

- Phương án: (1) Mọi khoản hoàn đều 2 người, ngưỡng qua env · (2) Hằng 1.000.000 đ trong RETURNS_CONFIG; cấm tự duyệt mọi trường hợp; MFA xác thực lại khi vượt ngưỡng hoặc hoàn toàn bộ; tạo yêu cầu dùng refund.request
- Chọn: Hằng 1.000.000 đ trong RETURNS_CONFIG; cấm tự duyệt mọi trường hợp; MFA xác thực lại khi vượt ngưỡng hoặc hoàn toàn bộ; tạo yêu cầu dùng refund.request
- Lý do (tiêu chí chất lượng cuối): Cấm tự duyệt ở mọi mức giữ tách nhiệm; ngưỡng hằng tránh đổi nhầm qua env; CSKH tạo được yêu cầu nhưng không thực hiện
- Đường lùi: Đổi RETURNS_CONFIG.twoPersonThreshold

### D-019 · 2026-10-25T02:25:40+00:00 · T-027: hàng trả chờ kiểm định, COD đã giao, đổi size, phí ship

- Phương án: (1) Chặn hoàn COD tới T-028; đổi size cho chênh giá; hoàn cả phí ship · (2) Hàng chờ ở Kho cách ly; COD hoàn ngoài hệ thống bắt buộc chứng từ; đổi size cùng sản phẩm cùng giá, đơn thay thế 0 đ xác nhận sau kiểm định đạt; trả hàng không hoàn ship, hủy đơn hoàn toàn bộ; cổng hoàn sandbox/live tắt (409) tới khi có ủy quyền
- Chọn: Hàng chờ ở Kho cách ly; COD hoàn ngoài hệ thống bắt buộc chứng từ; đổi size cùng sản phẩm cùng giá, đơn thay thế 0 đ xác nhận sau kiểm định đạt; trả hàng không hoàn ship, hủy đơn hoàn toàn bộ; cổng hoàn sandbox/live tắt (409) tới khi có ủy quyền
- Lý do (tiêu chí chất lượng cuối): Tồn bán không đổi tới khi kiểm định (AT17); không hoàn thật khi grant refund=false; tránh sai tiền khi chênh giá
- Đường lùi: Cấu hình returns workflow; bật refund-gateway HTTP khi có grant payments refund=true
