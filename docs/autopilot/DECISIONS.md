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

### D-020 · 2026-10-25T09:05:21+00:00 · T-042: phân loại lỗi khóa và thời gian chờ khi mất Redis

- Phương án: (1) Chỉ khớp thông điệp lỗi ioredis; chờ theo ioredis ~10 s; Retry-After 30 s · (2) Mọi lỗi acquire không phải 'đang bận' → 503 LOCK_UNAVAILABLE; chặn mỗi lệnh khóa 3 s; Retry-After 60 s; không khóa in-memory
- Chọn: Mọi lỗi acquire không phải 'đang bận' → 503 LOCK_UNAVAILABLE; chặn mỗi lệnh khóa 3 s; Retry-After 60 s; không khóa in-memory
- Lý do (tiêu chí chất lượng cuối): Fail-closed: lỗi hạ tầng khóa lạ nào cũng dừng bán thay vì bán bằng tồn không khóa; 3 s giữ request không treo
- Đường lùi: Hằng số trong apps/backend/src/lib/checkout/locks.ts

### D-021 · 2026-10-25T09:24:38+00:00 · T-034: CSP storefront

- Phương án: (1) 'unsafe-inline' cho script để giữ trang tĩnh/ISR · (2) Nonce + strict-dynamic mọi trang (trang HTML render động, mất cache HTML CDN; giữ cache fetch 60 s); style-src 'unsafe-inline' vì next/image
- Chọn: Nonce + strict-dynamic mọi trang (trang HTML render động, mất cache HTML CDN; giữ cache fetch 60 s); style-src 'unsafe-inline' vì next/image
- Lý do (tiêu chí chất lượng cuối): Chặn XSS là tiêu chí an toàn đứng trên hiệu năng; ảnh hưởng hiệu năng đo lại ở T-035/T-036
- Đường lùi: Bỏ nonce trong src/proxy.ts cho trang công khai

### D-022 · 2026-10-25T09:24:39+00:00 · T-034: xác định IP khách sau proxy

- Phương án: (1) Dùng req.ip (Express trust proxy=1 cứng của Medusa) · (2) Chỉ tin X-Forwarded-For khi socket thuộc XS_TRUSTED_PROXIES (bắt buộc ở production, giá trị none được phép); storefront chỉ chuyển IP khi XS_TRUST_PROXY_HEADERS=true
- Chọn: Chỉ tin X-Forwarded-For khi socket thuộc XS_TRUSTED_PROXIES (bắt buộc ở production, giá trị none được phép); storefront chỉ chuyển IP khi XS_TRUST_PROXY_HEADERS=true
- Lý do (tiêu chí chất lượng cuối): req.ip giả được bằng header → rate limit/audit vô hiệu
- Đường lùi: Đặt XS_TRUSTED_PROXIES theo hạ tầng

### D-023 · 2026-10-25T09:24:39+00:00 · T-043: tạo fulfillment native khi có vận đơn GHN

- Phương án: (1) Workflow Medusa đầy đủ qua shipping option (cần seed shipping option/profile cho mọi sản phẩm) · (2) Ghép bước tương đương: fulfillment ở kho đã giữ, nhả reservation, trừ tồn dưới khóa có khóa chống trùng; trừ lúc tạo vận đơn
- Chọn: Ghép bước tương đương: fulfillment ở kho đã giữ, nhả reservation, trừ tồn dưới khóa có khóa chống trùng; trừ lúc tạo vận đơn
- Lý do (tiêu chí chất lượng cuối): Không đụng catalog/seed; lệch về phía thiếu tồn khi sự cố, không bán âm
- Đường lùi: Chuyển sang workflow native khi catalog có shipping profile

### D-024 · 2026-10-25T10:53:02+00:00 · T-046: X-Content-Type-Options nosniff cho /static (Medusa đăng ký express.static trước middleware dự án)

- Phương án: (1) Header ở reverse proxy/CDN trước backend, ghi vào checklist triển khai · (2) Loader Express chạy trước static (đổi kiến trúc, chưa chắc Medusa hỗ trợ) · (3) Tắt /static ở production, ảnh qua file module S3/CDN
- Chọn: Header ở reverse proxy/CDN trước backend, ghi vào checklist triển khai
- Lý do (tiêu chí chất lượng cuối): Không vá framework, dễ lùi; ảnh production sẽ qua CDN nên header đặt ở biên là chuẩn
- Đường lùi: Chuyển sang file module S3 khi chọn hạ tầng ảnh
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Ảnh qua S3-compatible + CDN đặt nosniff; tắt /static

### D-025 · 2026-10-25T17:03:28+00:00 · T-022: nối E2E Playwright vào CI

- Phương án: (1) Thêm services postgres/redis cho job e2e trong ci.yml; xt.yaml e2e: pnpm e2e, e2e_setup cài Chromium · (2) docker compose Postgres/Redis trong e2e_setup · (3) Chỉ chạy e2e cục bộ, CI bỏ qua
- Chọn: Thêm services postgres/redis cho job e2e trong ci.yml; xt.yaml e2e: pnpm e2e, e2e_setup cài Chromium
- Lý do (tiêu chí chất lượng cuối): Đặc tả §13.3 đòi E2E luồng trọng yếu trong CI; services giống job gate, không phụ thuộc docker trên runner, pnpm e2e tự reset DB
- Đường lùi: Đặt lại e2e: "" trong xt.yaml (CI bỏ qua job e2e)

### D-026 · 2026-10-25T17:44:48+00:00 · T-028: nghĩa 'giá trị đơn' trong báo cáo đối soát

- Phương án: (1) Mọi đơn trừ đơn hủy, kể cả đang chờ thanh toán · (2) Chỉ đơn placed/confirmed/completed; đơn chờ thanh toán tách trường awaiting_payment_value
- Chọn: Chỉ đơn placed/confirmed/completed; đơn chờ thanh toán tách trường awaiting_payment_value
- Lý do (tiêu chí chất lượng cuối): Không thổi phồng giá trị đơn bằng đơn chưa chắc thành; kế toán vẫn thấy phần chờ
- Đường lùi: Gộp lại hai trường trong báo cáo summary

### D-027 · 2026-10-25T17:44:48+00:00 · T-028: định dạng file đối soát và quyền đóng chênh lệch

- Phương án: (1) Chờ định dạng xuất thật VNPAY/GHN · (2) CSV nội bộ 4 cột (mã tham chiếu, số tiền VND nguyên, thời điểm, loại) ghi rõ là giả định; đóng chênh lệch cần exception.resolve + settlement.read; hãng chuyển dư → vận đơn disputed, ưu tiên normal
- Chọn: CSV nội bộ 4 cột (mã tham chiếu, số tiền VND nguyên, thời điểm, loại) ghi rõ là giả định; đóng chênh lệch cần exception.resolve + settlement.read; hãng chuyển dư → vận đơn disputed, ưu tiên normal
- Lý do (tiêu chí chất lượng cuối): Không chặn tiến độ vì tài liệu chính thức chưa truy cập được; parser chặt, đổi định dạng chỉ ở một chỗ (constants/csv)
- Đường lùi: Thêm adapter định dạng thật khi có khoá merchant
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): Dùng file xuất thật VNPAY/GHN khi có hợp đồng merchant

### D-028 · 2026-10-25T18:11:37+00:00 · T-030: Admin UI khi server đòi MFA/xác thực lại

- Phương án: (1) Dựng form TOTP trong UI gọi auth API native · (2) UI chỉ hướng dẫn đăng nhập lại kèm TOTP (dùng luồng MFA native sẵn có của T-024)
- Chọn: UI chỉ hướng dẫn đăng nhập lại kèm TOTP (dùng luồng MFA native sẵn có của T-024)
- Lý do (tiêu chí chất lượng cuối): Không tạo đường xác thực thứ hai chưa được rà; luồng MFA native đã có test
- Đường lùi: Thêm form TOTP vào components admin khi cần UX nhanh hơn

### D-029 · 2026-10-25T18:35:20+00:00 · T-044: route native ghi tiền (/admin/payments/*, payment-collections, credit-lines, order cancel native)

- Phương án: (1) Chỉ owner qua settings.manage · (2) Chặn hẳn với mọi vai trò; mọi hoàn/hủy đi qua /admin/x/refunds và /admin/x/orders/:id/cancel
- Chọn: Chặn hẳn với mọi vai trò; mọi hoàn/hủy đi qua /admin/x/refunds và /admin/x/orders/:id/cancel
- Lý do (tiêu chí chất lượng cuối): Không còn đường lách duyệt 2 người và ledger kể cả với owner; owner vẫn hoàn được qua route có kiểm
- Đường lùi: Đổi NATIVE_MONEY_ROUTE trong lib/admin-security/native-permissions.ts

### D-030 · 2026-10-25T18:35:20+00:00 · T-044: mở lại hoàn tiền theo yêu cầu trả sau khi refund failed bị hủy

- Phương án: (1) reason=other (yêu cầu trả không bao giờ đóng) · (2) Cấm hủy refund gắn yêu cầu trả (tiền giữ mãi) · (3) reason=return + return_id, số tiền server tính theo kiểm định, chỉ khi bản cũ đã cancelled, unique chặn trùng
- Chọn: reason=return + return_id, số tiền server tính theo kiểm định, chỉ khi bản cũ đã cancelled, unique chặn trùng
- Lý do (tiêu chí chất lượng cuối): Tiền đúng, yêu cầu trả đóng được, không tạo trùng
- Đường lùi: Bỏ nhánh reason=return trong RefundCreateBody

### D-031 · 2026-10-25T19:06:29+00:00 · T-045: trạng thái vận đơn và tồn khi GHN cancel / hoàn về

- Phương án: (1) Thêm trạng thái cancelled vào domain + migration; cộng tồn lại ngay vào kho bán · (2) Vận đơn về unfulfilled qua cạnh lùi hợp lệ; hàng đã trừ tồn vào Kho cách ly chờ kiểm định; hủy đơn + mở refund_request lúc returned; đánh dấu yêu cầu hàng hoàn bằng khóa carrier:; khách thấy SHOP_CANCELLED, lý do chi tiết trong audit; đơn native giữ làm lịch sử
- Chọn: Vận đơn về unfulfilled qua cạnh lùi hợp lệ; hàng đã trừ tồn vào Kho cách ly chờ kiểm định; hủy đơn + mở refund_request lúc returned; đánh dấu yêu cầu hàng hoàn bằng khóa carrier:; khách thấy SHOP_CANCELLED, lý do chi tiết trong audit; đơn native giữ làm lịch sử
- Lý do (tiêu chí chất lượng cuối): Không bán âm, không đổi đặc tả §6.1, không cần migration; tiền theo D-012
- Đường lùi: Thêm trạng thái cancelled + cột source khi cần báo cáo chi tiết

### D-032 · 2026-10-25T20:20:00+00:00 · T-051: hàng rào phía DB cho bất biến hoàn tiền

- Phương án: (1) Trigger BEFORE INSERT x_refund từ chối nếu phiên không giữ pg_advisory_xact_lock của đúng đơn (tra pg_locks) · (2) Trigger tự khóa và cộng Σ so với đã thu (chép logic tiền sang SQL) · (3) Không thêm, giữ khóa tầng ứng dụng + test tất định
- Chọn: Trigger BEFORE INSERT x_refund từ chối nếu phiên không giữ pg_advisory_xact_lock của đúng đơn (tra pg_locks)
- Lý do (tiêu chí chất lượng cuối): Bắt mọi đường ghi quên khóa (lỗi đã thấy chữ ký khi bỏ khóa), không đưa logic tiền ra khỏi domain; migration mới có down
- Đường lùi: Migration down xoá trigger

### D-033 · 2026-10-25T22:21:20+00:00 · T-049: quyền đọc hàng trả và hàng đợi hoàn tiền

- Phương án: (1) Thêm quyền return.read cho kho + CSKH (đổi ma trận vai trò domain) · (2) Dùng return.receive (kho, owner); hàng hãng hoàn hiện kèm source; hàng đợi refund không order_id thì state bắt buộc, cũ nhất trước; tham số thừa/limit ngoài 1–100 → 422
- Chọn: Dùng return.receive (kho, owner); hàng hãng hoàn hiện kèm source; hàng đợi refund không order_id thì state bắt buộc, cũ nhất trước; tham số thừa/limit ngoài 1–100 → 422
- Lý do (tiêu chí chất lượng cuối): Không mở thêm quyền đọc dữ liệu đơn cho vai trò mới khi chưa có nhu cầu; 422 rõ ràng thay vì kẹp ngầm
- Đường lùi: Thêm return.read vào ma trận khi CSKH cần duyệt yêu cầu trả

### D-034 · 2026-10-25T23:56:41+00:00 · Rate limit cửa sổ cố định cho phép gấp đôi hạn mức qua ranh giới (T-050)

- Phương án: (1) Giữ cửa sổ cố định, chấp nhận 2x ở ranh giới · (2) Kiểm hai cửa sổ liền kề có trọng số (xấp xỉ cửa sổ trượt) trong hitRateCounter/peekRateCounter cho mọi chính sách
- Chọn: Kiểm hai cửa sổ liền kề có trọng số (xấp xỉ cửa sổ trượt) trong hitRateCounter/peekRateCounter cho mọi chính sách
- Lý do (tiêu chí chất lượng cuối): Chống dò mã tra cứu/đoán mã đúng ngưỡng công bố (an toàn trước); không cần hạ tầng mới
- Đường lùi: Trả về một cửa sổ trong modules/checkout/service.ts

### D-035 · 2026-10-26T00:35:48+00:00 · T-053: cách giành khóa có hạn cho sync/rebuild/seed catalog

- Phương án: (1) Giữ locking.execute + Promise.race hạn giành khóa (không phân biệt khóa bận với Redis câm) · (2) acquireOrdered/withOwnedLock dùng chung locks.ts: khóa bận chờ tới 300 s, mỗi lời gọi Redis hạn 3 s → LOCK_UNAVAILABLE; drain bỏ lượt khi bận/câm
- Chọn: acquireOrdered/withOwnedLock dùng chung locks.ts: khóa bận chờ tới 300 s, mỗi lời gọi Redis hạn 3 s → LOCK_UNAVAILABLE; drain bỏ lượt khi bận/câm
- Lý do (tiêu chí chất lượng cuối): Tách được khóa bận (chờ hợp lệ) khỏi Redis câm (fail nhanh); một cơ chế cho cả hệ thống
- Đường lùi: Trở lại locking.execute trong indexer.ts/seed-catalog.ts

### D-036 · 2026-10-26T00:58:38+00:00 · T-054: che PII trong ghi chú tự do

- Phương án: (1) Che lúc ghi vào bảng nghiệp vụ (mất dữ liệu gốc, cần migration dữ liệu) · (2) Che lúc trả ra ở route Admin/Store bằng maskFreeText dùng chung; audit che lúc ghi; địa chỉ nhận theo cụm báo hiệu (heuristic)
- Chọn: Che lúc trả ra ở route Admin/Store bằng maskFreeText dùng chung; audit che lúc ghi; địa chỉ nhận theo cụm báo hiệu (heuristic)
- Lý do (tiêu chí chất lượng cuối): Không phá dữ liệu gốc (có thể cần cho tranh chấp), mọi đường trả ra và audit đều che; heuristic có thể sót địa chỉ không có cụm — ghi nhận
- Đường lùi: Bỏ gọi maskFreeText ở các hàm present*

### D-037 · 2026-10-26T01:36:55+00:00 · T-055: phạm vi và chi tiết rate limit cửa sổ trượt

- Phương án: (1) Chỉ bộ đếm Postgres; login/MFA giữ cửa sổ TTL cũ; Retry-After trần 1 cửa sổ · (2) Áp cả bộ đếm Redis login/MFA (khóa theo chỉ số cửa sổ, MULTI); Retry-After tính đúng (có thể tới 2 cửa sổ); deniedIp chặn khi hiệu dụng+1 > N; gộp audit deny giữ đếm thô
- Chọn: Áp cả bộ đếm Redis login/MFA (khóa theo chỉ số cửa sổ, MULTI); Retry-After tính đúng (có thể tới 2 cửa sổ); deniedIp chặn khi hiệu dụng+1 > N; gộp audit deny giữ đếm thô
- Lý do (tiêu chí chất lượng cuối): Không để sót đường 2× ở đăng nhập/MFA (đích dò mật khẩu); Retry-After đúng tránh khách thử lại bị đếm thêm
- Đường lùi: Trả hàm quyết định về cửa sổ cố định trong lib/security/sliding-window.ts

### D-038 · 2026-10-26T02:16:54+00:00 · T-056: lỗi nhả khóa sau vùng găng, mất lease, recheck khi Redis hỏng

- Phương án: (1) Nhả lỗi → ném 503; mất lease → bỏ qua; recheck Redis hỏng → 429 · (2) Nhả lỗi → cảnh báo, khóa tự hết theo TTL; mất lease ở import/seed/bảng size → LOCK_UNAVAILABLE như native; recheck Redis hỏng → 503 (bận vẫn 429)
- Chọn: Nhả lỗi → cảnh báo, khóa tự hết theo TTL; mất lease ở import/seed/bảng size → LOCK_UNAVAILABLE như native; recheck Redis hỏng → 503 (bận vẫn 429)
- Lý do (tiêu chí chất lượng cuối): Không báo lỗi sai cho việc đã ghi và không che lỗi gốc; mất lease là tín hiệu không an toàn nên dừng; 503 đúng ngữ nghĩa hạ tầng
- Đường lùi: Đổi releaseOwnedOrWarn/failOnLeaseLoss trong lib/checkout/locks.ts

### D-039 · 2026-10-26T03:07:43+00:00 · T-035: chế độ điều tiết Lighthouse cho cổng lab

- Phương án: (1) simulate (mặc định Lighthouse; trên localhost HTTP/1.1 dao động quanh ngưỡng, đỏ ~3/6 lần) · (2) devtools (điều tiết áp thật theo hồ sơ §10.1; ổn định 4/4) — ghi rõ là mốc lạc quan, đo lại bằng RUM sau ra mắt
- Chọn: devtools (điều tiết áp thật theo hồ sơ §10.1; ổn định 4/4) — ghi rõ là mốc lạc quan, đo lại bằng RUM sau ra mắt
- Lý do (tiêu chí chất lượng cuối): Cổng phải tất định, không hạ ngưỡng; giới hạn mô hình mạng được ghi nhận trong docs/ops/perf/README.md
- Đường lùi: Đổi throttlingMethod trong scripts/perf/lighthouse.mjs
- Khi chạy thật (đề xuất, chủ dự án quyết ở G7): RUM web-vitals trên hạ tầng thật sau ra mắt

### D-040 · 2026-10-26T05:16:47+00:00 · T-057: khi kiểm cuối rebuild index thấy lệch (SKU có giá niêm yết mà không ra giá bán)

- Phương án: (1) Vẫn ghi bảng mới + log error · (2) Huỷ ghi, giữ bảng cũ (cũ nhưng đủ), log error + ops_exception catalog_index_mismatch (migration thêm kind)
- Chọn: Huỷ ghi, giữ bảng cũ (cũ nhưng đủ), log error + ops_exception catalog_index_mismatch (migration thêm kind)
- Lý do (tiêu chí chất lượng cuối): Lệch hàng loạt là dấu hiệu lỗi hệ thống (như lỗi chia lô vừa sửa); bảng cũ đầy đủ an toàn hơn bảng mới thiếu sản phẩm
- Đường lùi: Đổi nhánh abort trong rebuildUnlocked về ghi + log
