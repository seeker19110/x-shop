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

### D-041 · 2026-10-26T06:19:35+00:00 · T-058: cache listing/facet cho listing toàn bảng (~150 ms)

- Phương án: (1) Cache trong tiến trình 15–60 s (đánh đổi độ tươi §7.4) · (2) Bảng tổng hợp cấp sản phẩm (đụng schema) · (3) Chưa cache; chờ số đo thật trên staging/RUM; giữ pageSql/facetSql làm oracle trong test
- Chọn: Chưa cache; chờ số đo thật trên staging/RUM; giữ pageSql/facetSql làm oracle trong test
- Lý do (tiêu chí chất lượng cuối): Đã đạt ngưỡng ở 20+2/s; cache thêm rủi ro dữ liệu cũ, chưa có bằng chứng cần
- Đường lùi: Thêm cache khi RUM cho thấy listing là nghẽn

### D-042 · 2026-10-26T06:37:22+00:00 · T-059: mở ngoại lệ catalog_index_mismatch và phạm vi bỏ qua khi sync

- Phương án: (1) Dedupe vĩnh viễn theo khóa cố định; sync bỏ cả lô · (2) Chỉ mở khi chưa có ngoại lệ cùng kind đang open/in_progress (tái diễn sau khi xử lý thì mở lại); sync bỏ qua từng sản phẩm lệch, sản phẩm tốt vẫn ghi
- Chọn: Chỉ mở khi chưa có ngoại lệ cùng kind đang open/in_progress (tái diễn sau khi xử lý thì mở lại); sync bỏ qua từng sản phẩm lệch, sản phẩm tốt vẫn ghi
- Lý do (tiêu chí chất lượng cuối): Lỗi tái diễn không bị nuốt; không chặn cập nhật sản phẩm đúng
- Đường lùi: Đổi openOpsExceptionIfNoneActive về openOpsException

### D-043 · 2026-10-26T06:39:13+00:00 · T-060: tiếp tục tối ưu PDP/ghi giỏ ở 30+3/s trên máy dev hay chờ staging

- Phương án: (1) Tối ưu tiếp trên máy dev 4 CPU dùng chung · (2) Hoãn tới khi có staging nhiều instance; đo bằng k6 kịch bản §10.3 rồi tối ưu theo số đo thật
- Chọn: Hoãn tới khi có staging nhiều instance; đo bằng k6 kịch bản §10.3 rồi tối ưu theo số đo thật
- Lý do (tiêu chí chất lượng cuối): Listing/search đã đạt 20+2/s; số đo máy dev không đại diện production (một tiến trình Node, CPU dùng chung), tối ưu mù dễ thêm phức tạp vô ích
- Đường lùi: Bỏ defer T-060

### D-044 · 2026-10-26T08:50:05+00:00 · T-038: DPIA dẫn chiếu Luật BVDLCN 91/2025, NĐ 356/2025, NĐ 13/2023

- Phương án: (1) Phiên chính tra nguồn sống rồi điền ngày hiệu lực/điều khoản · (2) Giữ '(chưa xác minh)' tới khi pháp chế đối chiếu văn bản gốc; DPIA là việc chờ người ký
- Chọn: Giữ '(chưa xác minh)' tới khi pháp chế đối chiếu văn bản gốc; DPIA là việc chờ người ký
- Lý do (tiêu chí chất lượng cuối): Trích sai điều luật nguy hiểm hơn để trống có đánh dấu; DPIA cần pháp chế ký dù sao
- Đường lùi: Cập nhật DPIA §pháp lý khi có xác minh

### D-045 · 2026-10-26T09:03:40+00:00 · Duyệt PLAN-2 (đợt 2: 68 task đóng MUST blueprint; quyết định Q-01…Q-25)

- Phương án: (1) Chờ chủ dự án duyệt từng quyết định Q · (2) Phiên chính tự duyệt theo khuyến nghị bảng Q (tiêu chí AGENTS §5), thêm T-128 mở khoá commit xt.yaml và T-129 áp patch T-048; việc cần người tách riêng
- Chọn: Phiên chính tự duyệt theo khuyến nghị bảng Q (tiêu chí AGENTS §5), thêm T-128 mở khoá commit xt.yaml và T-129 áp patch T-048; việc cần người tách riêng
- Lý do (tiêu chí chất lượng cuối): Mọi khuyến nghị chọn phương án đúng/an toàn hơn và có đường lùi; việc thuộc quyền chủ dự án (giấy phép, ruleset, pháp chế, khoá thật, hạ tầng) không tự làm
- Đường lùi: Sửa task/quyết định trong docs/autopilot/PLAN-2.md trước khi task tương ứng chạy

### D-046 · 2026-10-26T09:51:06+00:00 · PM-REQ-019: giả định đổi trả/phí ship/thuế suất cho câu [chặn ra mắt] PROJECT.md §10

- Phương án: (1) Chờ chủ dự án chốt rồi mới ghi · (2) Mặc định tạm như PROJECT.md §10 (đổi trả theo D-019, ship theo GHN báo phí, thuế chưa áp) — chủ dự án chốt trước G7, nằm trong GO-NO-GO
- Chọn: Mặc định tạm như PROJECT.md §10 (đổi trả theo D-019, ship theo GHN báo phí, thuế chưa áp) — chủ dự án chốt trước G7, nằm trong GO-NO-GO
- Lý do (tiêu chí chất lượng cuối): Không chặn tiến độ build; con số có chủ sở hữu và hạn quyết rõ trong GO-NO-GO
- Đường lùi: Sửa PROJECT.md §10 khi chủ dự án chốt

### D-047 · 2026-10-26T09:51:06+00:00 · ARC-MOD-008: bố cục thư mục apps/backend/src do Medusa quy định vs miền nghiệp vụ

- Phương án: (1) Đổi bố cục thư mục theo miền · (2) ADR ngoại lệ chấp nhận bố cục Medusa + script so khớp modules/* với docs/architecture/domains.md
- Chọn: ADR ngoại lệ chấp nhận bố cục Medusa + script so khớp modules/* với docs/architecture/domains.md
- Lý do (tiêu chí chất lượng cuối): Đổi bố cục phá quy ước framework; script giữ ranh giới miền kiểm được bằng máy
- Đường lùi: Bỏ ADR + script

### D-048 · 2026-10-26T09:51:07+00:00 · SPEC-platform (F-001/F-012) đang Draft

- Phương án: (1) ADR coi ADR-0001 + docs/ops là spec · (2) Phiên chính duyệt SPEC-platform (approved_by D-048) và đổi trạng thái Approved
- Chọn: Phiên chính duyệt SPEC-platform (approved_by D-048) và đổi trạng thái Approved
- Lý do (tiêu chí chất lượng cuối): Giữ đúng một quy trình spec cho mọi tính năng
- Đường lùi: Đổi lại Draft

### D-049 · 2026-10-26T10:18:27+00:00 · payment_attempt.payment_url lưu vnp_IpAddr (IP thô khách)

- Phương án: (1) Giữ, áp lớp lưu payment-evidence · (2) Không lưu IP thô: lưu URL đã bỏ/che vnp_IpAddr (URL gửi VNPAY vẫn đủ), migration mới che dữ liệu cũ
- Chọn: Không lưu IP thô: lưu URL đã bỏ/che vnp_IpAddr (URL gửi VNPAY vẫn đủ), migration mới che dữ liệu cũ
- Lý do (tiêu chí chất lượng cuối): Tối thiểu hoá dữ liệu cá nhân; IP không cần cho đối soát (có txn_ref)
- Đường lùi: Lưu lại URL đầy đủ

### D-050 · 2026-10-26T10:18:28+00:00 · Phiên bản build cho smoke sau deploy (WF-REL-007)

- Phương án: (1) Thêm phiên bản vào /x/health công khai · (2) Route phiên bản riêng có xác thực (admin) hoặc header nội bộ sau LB
- Chọn: Route phiên bản riêng có xác thực (admin) hoặc header nội bộ sau LB
- Lý do (tiêu chí chất lượng cuối): Không lộ phiên bản cho kẻ tấn công dò lỗ hổng theo phiên bản
- Đường lùi: Đưa phiên bản vào /x/health

### D-051 · 2026-10-26T10:18:28+00:00 · Định danh nhân viên (actor_id, *_by) trong sổ dữ liệu

- Phương án: (1) Không coi là PII · (2) Coi là dữ liệu cá nhân (định danh giả danh của nhân viên), khai trong data-map
- Chọn: Coi là dữ liệu cá nhân (định danh giả danh của nhân viên), khai trong data-map
- Lý do (tiêu chí chất lượng cuối): Cách hiểu chặt hơn theo NĐ 13/2023 (chưa xác minh điều khoản); không tốn thêm chi phí
- Đường lùi: Đổi phân loại trong docs/privacy/data-map.yaml

### D-052 · 2026-10-26T10:54:18+00:00 · T-128: cổng commit chạm cấu hình cổng vượt timeout hook 600 s (song song 4 luồng = 711 s)

- Phương án: (1) Phiên agent tự nâng timeout PreToolUse trong .claude/settings.json · (2) Hạ cổng: commit chạm cấu hình chỉ chạy unit · (3) Commit script phân mảnh; dòng xt.yaml + mọi thay đổi xt.yaml/settings gom thành patch để chủ dự án áp (hoặc nâng timeout hook) — agent không sửa hàng rào của chính mình
- Chọn: Commit script phân mảnh; dòng xt.yaml + mọi thay đổi xt.yaml/settings gom thành patch để chủ dự án áp (hoặc nâng timeout hook) — agent không sửa hàng rào của chính mình
- Lý do (tiêu chí chất lượng cuối): Không hạ cổng, không tự nới hàng rào harness; settings.json cũng là cấu hình cổng nên agent không commit được; chủ dự án quyết
- Đường lùi: Áp patch khi chủ dự án đồng ý

### D-053 · 2026-10-26T11:03:18+00:00 · Xử lý 5 lỗ hổng high trong lockfile (graphql-tools, lodash, uuid, zod — gián tiếp, có bản vá) và ngưỡng VULN-SLA

- Phương án: (1) Ngoại lệ có hạn trong osv-scanner.toml · (2) Vá bằng nâng bản/pnpm.overrides theo bản vá, chạy đủ cổng (build + test + tích hợp + e2e) để chứng minh không vỡ; SLA mặc định Critical 7/High 14/Medium 60/Low 90 ngày, ngoại lệ tối đa 90 ngày có duyệt chủ dự án
- Chọn: Vá bằng nâng bản/pnpm.overrides theo bản vá, chạy đủ cổng (build + test + tích hợp + e2e) để chứng minh không vỡ; SLA mặc định Critical 7/High 14/Medium 60/Low 90 ngày, ngoại lệ tối đa 90 ngày có duyệt chủ dự án
- Lý do (tiêu chí chất lượng cuối): Vá thật an toàn hơn che lỗi; ngoại lệ chỉ khi bản vá phá Medusa (major graphql-tools/uuid) — khi đó ghi lý do và đề xuất chủ dự án duyệt
- Đường lùi: Bỏ overrides trong package.json

### D-054 · 2026-10-26T13:26:02+00:00 · 401 ẩn danh ở /admin/* do authenticate của Medusa trả {message} thường, không problem+json (BASE-ERR-003)

- Phương án: (1) Chấp nhận ngoại lệ: ghi vào ADR-0003/OpenAPI, giữ luồng xác thực native của Medusa · (2) Tắt AUTHENTICATE cho /admin/x, tự gọi authenticate(allowUnauthenticated) + guard trả 401 problem
- Chọn: Chấp nhận ngoại lệ: ghi vào ADR-0003/OpenAPI, giữ luồng xác thực native của Medusa
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: không tự viết lại luồng xác thực admin — đổi luồng auth là rủi ro lỗ hổng lớn hơn lợi ích định dạng; (3) đơn giản, theo chuẩn framework; 401 không lộ chi tiết nên không vi phạm bảo mật
- Đường lùi: Làm phương án 2 trong một task riêng có test rbac/security; BASE-ERR-003 giữ [ ] kèm ghi chú ngoại lệ

### D-055 · 2026-10-26T13:26:02+00:00 · SĐT mẫu trong fixture (0912345678…) thuộc dải thuê bao thật; VN chưa xác minh có dải số dành riêng cho test (QA-DATA-002)

- Phương án: (1) Giữ allowlist 6 số mẫu ở docs/compliance/test-data-policy.md, cấm mọi số khác trong fixture · (2) Tìm dải số reserved có nguồn rồi đổi toàn bộ fixture
- Chọn: Giữ allowlist 6 số mẫu ở docs/compliance/test-data-policy.md, cấm mọi số khác trong fixture
- Lý do (tiêu chí chất lượng cuối): (1) số mẫu phổ biến không gắn dữ liệu cá nhân thật, không gửi SMS trong dev/CI (adapter mock); script chặn số ngoài allowlist; (3) đổi hàng loạt test không tăng an toàn khi chưa có dải reserved xác minh
- Đường lùi: Khi có dải số reserved có nguồn: sửa allowlist trong test-data-policy.md, check-fixtures báo các chỗ phải đổi

### D-056 · 2026-10-26T14:26:34+00:00 · Nối kiểm EXPLAIN đường nóng vào CI (DB-PERF-001)? dựng dataset ~8 phút

- Phương án: (1) Job CI theo lịch/trước release: perf-dataset.mjs + explain-hot-paths.mjs · (2) Chỉ đưa explain-hot-paths.test.mjs (hàm thuần) vào gate; EXPLAIN chạy tay mỗi mốc PLAN · (3) Thêm vào perf của xt.yaml (cần người sửa xt.yaml)
- Chọn: Chỉ đưa explain-hot-paths.test.mjs (hàm thuần) vào gate; EXPLAIN chạy tay mỗi mốc PLAN
- Lý do (tiêu chí chất lượng cuối): (2) giữ đường lùi: không thêm job 8 phút chưa đo trên runner; (3) đơn giản, test được ngay; hồi quy index vẫn bị bắt ở mốc PLAN (pha harden audit mỗi mốc). DB-PERF-001 giữ [ ] vì yêu cầu test tự động trong CI
- Đường lùi: Thêm job schedule/release khi có staging (T-060) hoặc khi runner đo được thời gian

### D-057 · 2026-10-26T15:48:44+00:00 · pr-commits đỏ trên PR #20: 15 commit đã đẩy có subject > 72 ký tự (viết trước khi T-111 thêm check)

- Phương án: (1) Viết lại lịch sử + force-push nhánh · (2) Giữ lịch sử; commit mới tuân thủ ≤ 72; chủ dự án squash-merge PR (tiêu đề PR đạt chuẩn) hoặc tự quyết rewrite · (3) Nới check-commits (miễn commit cũ)
- Chọn: Giữ lịch sử; commit mới tuân thủ ≤ 72; chủ dự án squash-merge PR (tiêu đề PR đạt chuẩn) hoặc tự quyết rewrite
- Lý do (tiêu chí chất lượng cuối): (1) AGENTS.md §4 cấm force-push, guard chặn; (3) không nới cổng (LOOP-CI-001); phương án 2 giữ đường lùi và lịch sử nhánh trên master là squash một commit hợp lệ
- Đường lùi: Chủ dự án có thể rewrite tay rồi force-push nếu muốn giữ từng commit

### D-058 · 2026-10-26T16:36:07+00:00 · Timeout lệnh cho kết nối BullMQ (event bus/workflow engine) — BASE-ERR-004, ARC-RES-001, BE-REL-001

- Phương án: (1) commandTimeout ≥ 30 s lớn hơn hạn chặn worker · (2) Ghi ngoại lệ (BullMQ bắt buộc maxRetriesPerRequest:null) ở docs/db/connections.md, giữ 3 mục [ ] kèm Thiếu · (3) blockingTimeout của ioredis (chỉ bảo vệ lệnh chặn)
- Chọn: Ghi ngoại lệ (BullMQ bắt buộc maxRetriesPerRequest:null) ở docs/db/connections.md, giữ 3 mục [ ] kèm Thiếu
- Lý do (tiêu chí chất lượng cuối): (1) không cắt lệnh chặn hợp lệ của worker (phương án 1 có rủi ro mất job khi đổi cấu hình); (3) không tick khi chưa đủ — cách hiểu chặt
- Đường lùi: Làm phương án 1 kèm test worker dài khi có metric job thật

### D-059 · 2026-10-26T16:36:07+00:00 · Tạo lại session ID sau đăng nhập admin (BE-AUTH-004, session fixation)

- Phương án: (1) Ghi đè POST /auth/session gọi req.session.regenerate (task mới T-133, có test) · (2) Để Thiếu, dựa vào cookie __Host-
- Chọn: Ghi đè POST /auth/session gọi req.session.regenerate (task mới T-133, có test)
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: chống session fixation là yêu cầu bảo mật MUST, __Host- chỉ chặn cấy cookie từ subdomain; (3) test được bằng express-session thật như T-099
- Đường lùi: Bỏ route ghi đè khi Medusa tự regenerate

### D-060 · 2026-10-26T16:36:08+00:00 · Q-PROMO-1/2: giới hạn lượt/người và ngân sách khuyến mãi (mua không cần tài khoản)

- Phương án: (1) Khoá theo SĐT + ngân sách tiền cộng dồn · (2) Giữ quota tổng lượt + giới hạn tốc độ; không ngân sách tiền ở v1 · (3) Chỉ mã gắn tài khoản
- Chọn: Giữ quota tổng lượt + giới hạn tốc độ; không ngân sách tiền ở v1
- Lý do (tiêu chí chất lượng cuối): (1) đúng đặc tả gốc (mua không cần tài khoản, chỉ có quota S-008); khoá SĐT dễ né và lưu thêm PII; (3) đơn giản; ngân sách tiền là tính năng mới cần chủ sản phẩm
- Đường lùi: Thêm ngân sách tiền theo mã (cộng dồn, hoàn khi huỷ) khi chủ sản phẩm yêu cầu

### D-061 · 2026-10-26T16:36:08+00:00 · Q-PROMO-3/4: chồng nhiều mã cấp đơn; snapshot khuyến mãi trong đơn

- Phương án: (1) Một mã cấp đơn; snapshot lưu loại + giá trị + điều kiện tại lúc đặt · (2) Cho chồng mã có thứ tự + cờ stackable; snapshot chỉ mã + số giảm
- Chọn: Một mã cấp đơn; snapshot lưu loại + giá trị + điều kiện tại lúc đặt
- Lý do (tiêu chí chất lượng cuối): (1) đúng hành vi hiện có và đặc tả; snapshot đầy đủ giúp đối soát/đổi trả đúng khi mã đổi sau đó (cách chặt hơn); (3) không thêm tính năng chồng mã chưa yêu cầu
- Đường lùi: Thêm stackable khi chủ sản phẩm yêu cầu

### D-062 · 2026-10-26T18:00:47+00:00 · Unit test chạy hai lần trong CI (test + test:coverage)

- Phương án: (1) Giữ, tốn ~3 phút CI · (2) Đổi test trong xt.yaml sang test:coverage (chạm cấu hình cổng, cần người)
- Chọn: Giữ, tốn ~3 phút CI
- Lý do (tiêu chí chất lượng cuối): (2) không chạm xt.yaml (D-052: agent không tự sửa hàng rào); (3) đơn giản; 3 phút CI chấp nhận được
- Đường lùi: Chủ dự án đổi xt.yaml test → test:coverage rồi bỏ bước trùng

### D-063 · 2026-10-26T18:00:47+00:00 · Gate T-060 (tối ưu PDP p95 ≤ 300 ms) và gốc so sánh

- Phương án: (1) Gate mẫu PERF-LOG §2: build + bật backend cả hai cây, perf compare ≥10 mẫu; gốc = SHA lúc mở task · (2) Chỉ load:smoke 30+3/s
- Chọn: Gate mẫu PERF-LOG §2: build + bật backend cả hai cây, perf compare ≥10 mẫu; gốc = SHA lúc mở task
- Lý do (tiêu chí chất lượng cuối): (1) đúng LOOP-OPT-003 (so có thống kê, khoá bộ đo); gốc SHA cố định lúc mở task để so lặp lại được
- Đường lùi: Đổi gốc sang origin/master nếu task kéo dài qua nhiều merge

### D-064 · 2026-10-26T18:00:48+00:00 · Coverage test tích hợp backend (QA-COV-001)

- Phương án: (1) Thêm test:integration:coverage, đo thời gian trước khi nối CI (task mới T-135) · (2) Miễn kèm lý do
- Chọn: Thêm test:integration:coverage, đo thời gian trước khi nối CI (task mới T-135)
- Lý do (tiêu chí chất lượng cuối): (1) cách hiểu chặt: backend phần lớn logic chỉ được phủ bởi test tích hợp (unit lines 28,8%); (3) đo trước để không vượt timeout CI
- Đường lùi: Miễn có lý do nếu đo thấy CI vượt 20 phút

### D-065 · 2026-10-26T20:12:54+00:00 · Mẫu nhận diện PII có hai bản (backend redact.ts, storefront analytics/schema.ts)

- Phương án: (1) Gom vào packages/domain · (2) Giữ hai bản + test chung bộ mẫu (fixture dùng chung, test cả hai phải che giống nhau)
- Chọn: Giữ hai bản + test chung bộ mẫu (fixture dùng chung, test cả hai phải che giống nhau)
- Lý do (tiêu chí chất lượng cuối): (1) bundle client không được kéo domain (node:fs/crypto — đã gặp ở T-082); (3) test khoá chống lệch, đơn giản
- Đường lùi: Tách mẫu PII ra module domain không phụ thuộc node khi có subpath export riêng

### D-066 · 2026-10-26T20:12:55+00:00 · CMND 9 số trong văn bản tự do (trùng số tiền VND 9 chữ số)

- Phương án: (1) Giữ: chỉ che theo tên trường · (2) Che 9 số khi có từ khoá đi kèm (CMND/CMT/chứng minh)
- Chọn: Che 9 số khi có từ khoá đi kèm (CMND/CMT/chứng minh)
- Lý do (tiêu chí chất lượng cuối): (1) cách chặt hơn cho PII mà không che nhầm số tiền; test được bằng bảng ca
- Đường lùi: Tắt luật từ khoá nếu che nhầm trong log thật

### D-067 · 2026-10-26T20:35:49+00:00 · Gắn check-schema.mjs vào CI (DB-MODEL-004)

- Phương án: (1) Phiên chính thêm bước CI ngay khi merge T-101 (Postgres service đã có trong job gate) · (2) Để task riêng sau
- Chọn: Phiên chính thêm bước CI ngay khi merge T-101 (Postgres service đã có trong job gate)
- Lý do (tiêu chí chất lượng cuối): (1) yêu cầu MUST cần CI chặn; job gate đã có Postgres service; (3) một bước, đã có test script
- Đường lùi: Gỡ bước nếu CI vượt timeout

### D-068 · 2026-10-26T21:17:12+00:00 · Review bù T-099/T-100/T-092/T-088 tìm 1 🟠 (dò tài khoản qua register) + tick BE-FILE-005 sai + rủi ro statement_timeout chưa đo

- Phương án: (1) Hạ tick BE-AUTH-003, BE-FILE-005; thêm T-138…T-141 làm ngay theo thứ tự rủi ro · (2) Giữ tick, ghi nợ kỹ thuật
- Chọn: Hạ tick BE-AUTH-003, BE-FILE-005; thêm T-138…T-141 làm ngay theo thứ tự rủi ro
- Lý do (tiêu chí chất lượng cuối): (1) đúng và an toàn: tick phải phản ánh thật (P1 bằng chứng); dò tài khoản admin là rủi ro bảo mật MUST
- Đường lùi: Tick lại khi T-138/T-141 xanh

### D-069 · 2026-10-26T21:32:26+00:00 · Nguồn khoá HMAC cho băm ngắn literal SQL trong log

- Phương án: (1) Dẫn xuất từ COOKIE_SECRET với nhãn riêng · (2) Biến riêng LOG_HASH_KEY
- Chọn: Dẫn xuất từ COOKIE_SECRET với nhãn riêng
- Lý do (tiêu chí chất lượng cuối): (3) không thêm bí mật phải quản lý; COOKIE_SECRET đã bắt buộc ≥32 ký tự ở production; dẫn xuất có nhãn tách mục đích; reviewer xác nhận
- Đường lùi: Thêm LOG_HASH_KEY nếu cần xoay cookie secret mà vẫn đối chiếu log cũ

### D-070 · 2026-10-26T21:46:26+00:00 · BE-CACHE-007: vô hiệu hoá cache catalog theo sự kiện hay giữ SWR 60 s

- Phương án: (1) Webhook backend → storefront revalidateTag khi sửa sản phẩm/giá (task T-142, có xác thực HMAC + test cập nhật rồi đọc ngay) · (2) Giữ SWR, bỏ vế không nhận bản cũ quá ngưỡng
- Chọn: Webhook backend → storefront revalidateTag khi sửa sản phẩm/giá (task T-142, có xác thực HMAC + test cập nhật rồi đọc ngay)
- Lý do (tiêu chí chất lượng cuối): (1) giá hiển thị cũ hàng giờ ở trang ít người xem là sai trải nghiệm/khiếu nại giá; không nới yêu cầu MUST; (3) revalidateTag là cơ chế chuẩn của Next
- Đường lùi: Tắt webhook, quay về SWR TTL

### D-071 · 2026-10-26T21:46:44+00:00 · CHECK payment_ledger.state: chỉ 'succeeded' hay toàn bộ REFUND_STATES

- Phương án: (1) Chỉ 'succeeded' (mọi đường ghi hiện tại) · (2) Toàn bộ REFUND_STATES theo kiểu TS
- Chọn: Chỉ 'succeeded' (mọi đường ghi hiện tại)
- Lý do (tiêu chí chất lượng cuối): (1) chặt hơn: ledger là sổ tiền đã xảy ra; reviewer xác nhận chỉ 2 đường ghi đều 'succeeded'; (2) nới sau bằng migration mới dễ hơn siết
- Đường lùi: Migration mới nới CHECK khi có đường ghi trạng thái khác

### D-072 · 2026-10-26T21:46:44+00:00 · Danh sách con theo một đơn (refunds?order_id, orders/{ref}/returns) và exports/products.csv chưa có trần

- Phương án: (1) Giữ: bị chặn bởi đơn cha / export theo thiết kế, ghi lý do trong bảng phân loại list-bounds · (2) Thêm trần cứng + cờ truncated
- Chọn: Giữ: bị chặn bởi đơn cha / export theo thiết kế, ghi lý do trong bảng phân loại list-bounds
- Lý do (tiêu chí chất lượng cuối): (1) phần tính tiền không được cắt dòng — trần có thể làm sai số hoàn/đổi trả; số con theo một đơn tự nhiên nhỏ; (3) đơn giản
- Đường lùi: Thêm trần + truncated cho phần hiển thị nếu đo thấy đơn có quá nhiều dòng con

### D-073 · 2026-10-26T22:37:42+00:00 · Đăng ký admin không kèm invite_token (dashboard Medusa gốc gọi register không token)

- Phương án: (1) Giữ: cho qua khi có lời mời chưa nhận còn hạn đúng email (dashboard gốc chạy); chấp nhận rủi ro làm hỏng lời mời (không chiếm được tài khoản vì accept cần token) · (2) Bắt buộc invite_token, làm trang mời riêng trong src/admin
- Chọn: Giữ: cho qua khi có lời mời chưa nhận còn hạn đúng email (dashboard gốc chạy); chấp nhận rủi ro làm hỏng lời mời (không chiếm được tài khoản vì accept cần token)
- Lý do (tiêu chí chất lượng cuối): (2) giữ đường lùi và UI admin gốc; (1) rủi ro còn lại chỉ là phá lời mời (DoS lời mời), có rate limit, không leo thang quyền — reviewer-alt kiểm lại điểm này
- Đường lùi: Bắt buộc token + trang mời riêng nếu review/quan sát thấy lạm dụng

### D-074 · 2026-10-26T22:37:43+00:00 · Tài khoản khách (P1, POST04) khi identity emailpass dùng chung actor

- Phương án: (1) Đóng đăng ký khách tới khi làm P1 · (2) Mở kèm xác minh email · (3) Provider riêng cho khách
- Chọn: Đóng đăng ký khách tới khi làm P1
- Lý do (tiêu chí chất lượng cuối): (1) đặc tả: mua không cần tài khoản, tài khoản khách là P1; đóng là cách an toàn nhất; (2) quyết thiết kế cùng task P1
- Đường lùi: Mở khi làm P1 với provider riêng hoặc xác minh email

### D-075 · 2026-10-26T23:25:33+00:00 · Thay D-073: đăng ký admin không kèm invite_token (review T-138: người lạ chiếm trước identity email đang được mời, gắn TOTP của họ; rủi ro chiếm tài khoản qua reset sau này)

- Phương án: (1) Chỉ nhánh token; dashboard: lấy invite_token từ Referer cùng origin /app/invite?token=… khi thân không có, thiếu thì từ chối; dọn identity chưa gắn actor khi xoá/gửi lại lời mời · (2) Chỉ nhánh token, onboarding bằng CLI/trang mời riêng · (3) Giữ D-073 (chấp nhận rủi ro)
- Chọn: Chỉ nhánh token; dashboard: lấy invite_token từ Referer cùng origin /app/invite?token=… khi thân không có, thiếu thì từ chối; dọn identity chưa gắn actor khi xoá/gửi lại lời mời
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: không có đường tạo identity admin khi không chứng minh có token mời — đúng tiêu chí T-138; (2)(4) dashboard gốc vẫn dùng được vì nó chạy cùng origin với token trên URL; thiếu Referer → từ chối (đóng an toàn)
- Đường lùi: Phương án 2 (trang mời riêng) nếu Referer không tin cậy trong môi trường thật

### D-076 · 2026-10-27T02:28:12+00:00 · Rebuild catalog toàn phần giữ khoá 108–113 s ở 50k SKU (T-137 Q2) — thay đổi trong lúc đó trễ quá 60 s §7.4

- Phương án: (1) Dựng dòng ngoài khoá, chỉ giữ khoá lúc replaceAll, rồi xả lại dấu có từ sau mốc bắt đầu rebuild (gộp vào T-140) · (2) Chấp nhận, ghi ngoại lệ RPO/§7.4
- Chọn: Dựng dòng ngoài khoá, chỉ giữ khoá lúc replaceAll, rồi xả lại dấu có từ sau mốc bắt đầu rebuild (gộp vào T-140)
- Lý do (tiêu chí chất lượng cuối): (1) đúng mục tiêu độ trễ §7.4 ở quy mô production; không nới yêu cầu
- Đường lùi: Ghi ngoại lệ nếu đo thấy replaceAll ngoài khoá gây sai lệch

### D-077 · 2026-10-27T02:28:13+00:00 · Cô lập Redis cho test tích hợp chạy đồng thời (T-137 Q1)

- Phương án: (1) globalSetup giành độc quyền Redis DB bằng SET NX EX (T-146) · (2) Redis riêng mỗi worktree · (3) Namespace qua medusa-config
- Chọn: globalSetup giành độc quyền Redis DB bằng SET NX EX (T-146)
- Lý do (tiêu chí chất lượng cuối): (1) chặt nhất, chỉ đụng hạ tầng test; namespace không phủ locking-redis/workflows-cleaner
- Đường lùi: Redis riêng mỗi worktree

### D-078 · 2026-10-27T02:41:06+00:00 · Log khoá VNPAY trước chỉ ở IPN; return/querydr chưa có (interpretQueryResponseWithRotation không trả secretUsed)

- Phương án: (1) Giữ: IPN là đường chính xác nhận tiền; RUNBOOK ghi rõ · (2) Mở rộng sang return/querydr
- Chọn: Giữ: IPN là đường chính xác nhận tiền; RUNBOOK ghi rõ
- Lý do (tiêu chí chất lượng cuối): (3) đơn giản: IPN là nơi VNPAY ký bằng khoá cấu hình ở cổng, đủ để biết khi nào bỏ khoá trước; querydr do server chủ động gọi
- Đường lùi: Cho interpretQueryResponseWithRotation trả secretUsed nếu vận hành cần

### D-079 · 2026-10-27T03:11:59+00:00 · T-145: request-target có '#' hoặc '\' (trái RFC 9112)

- Phương án: (1) Chặn ở tầng server (400) · (2) Giữ, lớp chiều sâu đã khớp Express
- Chọn: Chặn ở tầng server (400)
- Lý do (tiêu chí chất lượng cuối): (1) chặt hơn, trình duyệt không bao giờ gửi; giảm bề mặt khác biệt parser
- Đường lùi: Bỏ luật nếu client hợp lệ bị chặn

### D-080 · 2026-10-27T03:11:59+00:00 · T-145: mặc định GET native admin không khai báo quyền (any_role)

- Phương án: (1) Giữ any_role, mở task liệt kê route dashboard rồi đóng sau · (2) Đóng ngay
- Chọn: Giữ any_role, mở task liệt kê route dashboard rồi đóng sau
- Lý do (tiêu chí chất lượng cuối): (2) giữ đường lùi: đóng ngay vỡ dashboard khi chưa liệt kê đủ route; lỗ hổng URL tuyệt đối đã chặn ở 2 lớp
- Đường lùi: Đóng mặc định khi native-permissions liệt kê đủ (task sau)

### D-081 · 2026-10-27T03:11:59+00:00 · Thay một phần D-035: drain gặp khoá bận thì chờ (T-137) — nhưng không chờ trong job worker và dừng khi đang tắt

- Phương án: (1) Job phút không chờ (waitMs 0), bận thì giao scheduleCatalogDrain chờ nền ≤300 s; mọi vòng chờ kiểm isDraining() · (2) Nâng concurrency jobWorker
- Chọn: Job phút không chờ (waitMs 0), bận thì giao scheduleCatalogDrain chờ nền ≤300 s; mọi vòng chờ kiểm isDraining()
- Lý do (tiêu chí chất lượng cuối): (1) không chặn khe job dùng chung (outbox, expire-holds) và không vượt trần tắt êm T-094; (3) không đổi cấu hình mọi job
- Đường lùi: Quay về bỏ lượt khi bận (D-035)

### D-082 · 2026-10-27T04:01:31+00:00 · Review T-145 INCONCLUSIVE (dò đường vòng đối nghịch bị bộ phân loại chặn); code đang đẩy có lỗ hổng RBAC đã tái hiện

- Phương án: (1) Merge hotfix ngay + gia cố 🟢1 (từ chối byte ≤0x20/0x7F/≥0x80) + ghi việc rà bảo mật đối nghịch cho người · (2) Giữ hotfix chờ review CLEAN
- Chọn: Merge hotfix ngay + gia cố 🟢1 (từ chối byte ≤0x20/0x7F/≥0x80) + ghi việc rà bảo mật đối nghịch cho người
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: giữ lại nghĩa là để lỗ hổng đã chứng minh trên PR; hotfix chỉ thu hẹp đầu vào, phần đã rà sạch (unit/tích hợp/đối chiếu parseurl); (2) đường lùi: revert từng commit
- Đường lùi: Revert 2 commit T-145 nếu rà bảo mật thấy hồi quy

### D-083 · 2026-10-27T04:54:45+00:00 · Vùng Redis DB cho test tích hợp (T-146)

- Phương án: (1) 1–12 trừ 7 (an toàn với E2E DB7, tải/perf/diễn tập 13–15) · (2) 1–15 trừ 7
- Chọn: 1–12 trừ 7 (an toàn với E2E DB7, tải/perf/diễn tập 13–15)
- Lý do (tiêu chí chất lượng cuối): (1) FLUSHDB không xoá dữ liệu của e2e/tải/perf chạy cùng lúc; 11 DB đủ cho số tiến trình song song thực tế
- Đường lùi: Đổi hằng TEST_REDIS_DBS

### D-084 · 2026-10-27T06:01:35+00:00 · T-143 reset-password: vượt ngưỡng trả 429 hay vẫn 201; ngưỡng 3/5/20 trong 15 phút, sàn thời gian 250 ms

- Phương án: (1) Giữ 429 + Retry-After (bộ đếm như nhau cho mọi email nên không lộ tồn tại); duyệt ngưỡng 3/5/20/15 phút và sàn 250 ms · (2) Vượt ngưỡng vẫn 201, không chạy workflow
- Chọn: Giữ 429 + Retry-After (bộ đếm như nhau cho mọi email nên không lộ tồn tại); duyệt ngưỡng 3/5/20/15 phút và sàn 250 ms
- Lý do (tiêu chí chất lượng cuối): (1) không lộ tài khoản (đếm theo email nhập, không theo tồn tại); (4) người dùng thật biết phải chờ thay vì mất email âm thầm; thống nhất với login/register
- Đường lùi: Đổi sang 201 im lặng trong resetPasswordGuard nếu đo thấy kênh phụ

### D-085 · 2026-10-27T06:28:35+00:00 · T-143 🟠-2: bộ đếm rate limit tăng cả lượt đã bị 429 → một IP khoá hộ reset/đăng nhập của email bất kỳ và kéo dài quá cửa sổ

- Phương án: (1) Kẹp bộ đếm ở limit+1 cho mọi scope (không kéo dài khoá); reset: ngưỡng theo identity chỉ áp trong việc nền cho identity có thật, vượt thì bỏ âm thầm; giữ 429 theo IP và email+IP · (2) Giữ như hiện tại
- Chọn: Kẹp bộ đếm ở limit+1 cho mọi scope (không kéo dài khoá); reset: ngưỡng theo identity chỉ áp trong việc nền cho identity có thật, vượt thì bỏ âm thầm; giữ 429 theo IP và email+IP
- Lý do (tiêu chí chất lượng cuối): (1) giảm DoS khoá tài khoản do kẻ tấn công điều khiển mà vẫn chặn dò/brute force; (4) admin thật không bị khoá kéo dài
- Đường lùi: Bỏ kẹp nếu đo thấy brute force lọt

### D-086 · 2026-10-27T06:28:36+00:00 · T-143 🟠-1: dò email qua độ trễ request đồng thời do workflow reset chạy cùng tiến trình

- Phương án: (1) Giới hạn/bỏ metadata, khởi chạy workflow sau độ trễ ngẫu nhiên đều (0–5 s) ngoài thời điểm request; ghi rủi ro còn lại (đo loopback, ≤5 lượt/email/15 phút) · (2) Hàng đợi job ở tiến trình worker riêng
- Chọn: Giới hạn/bỏ metadata, khởi chạy workflow sau độ trễ ngẫu nhiên đều (0–5 s) ngoài thời điểm request; ghi rủi ro còn lại (đo loopback, ≤5 lượt/email/15 phút)
- Lý do (tiêu chí chất lượng cuối): (1) phá tương quan thời gian với request đối chứng; (3) không thêm hạ tầng job mới; dự án chưa gửi thư reset (chưa có subscriber) nên rủi ro thực hiện tại thấp
- Đường lùi: Chuyển sang job worker khi bật gửi thư reset

### D-087 · 2026-10-27T06:51:08+00:00 · T-143 vòng 2: Retry-After so với cửa sổ; rủi ro R-07; sàn 250 ms và độ trễ nền 0–5 s

- Phương án: (1) Giữ: kiểm Retry-After ≤ khoá tối thiểu của xấp xỉ cửa sổ trượt; R-07 accept; duyệt 250 ms/5 s · (2) Đổi sliding-window sang log thời điểm thật (đụng limiter store/order-lookup); chuyển việc nền sang worker
- Chọn: Giữ: kiểm Retry-After ≤ khoá tối thiểu của xấp xỉ cửa sổ trượt; R-07 accept; duyệt 250 ms/5 s
- Lý do (tiêu chí chất lượng cuối): (1) đã đóng lỗi khoá hộ (không kéo dài quá khoá tối thiểu, có test đối chứng); (3) không mở rộng sang limiter dùng chung; email reset chậm ≤5 s chấp nhận được (4)
- Đường lùi: Đổi sliding-window.ts sang log thời điểm; chuyển việc nền sang job worker khi bật gửi thư reset

### D-088 · 2026-10-27T06:51:08+00:00 · T-093: OUTBOX_POLICY.maxAttempts (blueprint BE-JOB-003 nói mặc định 3–5)

- Phương án: (1) Giữ 8 lần (cửa sổ ~21 phút), BE-JOB-003 để mở kèm lý do · (2) 5 lần base 80 s (lần đầu chậm 40–80 s, ảnh hưởng payment.native_sync) · (3) 5 lần base 10 s (cửa sổ ~2,5 phút, sự cố SMTP ngắn đã vào dead)
- Chọn: Giữ 8 lần (cửa sổ ~21 phút), BE-JOB-003 để mở kèm lý do
- Lý do (tiêu chí chất lượng cuối): (1) đúng/an toàn: không đẩy sự kiện thanh toán/thông báo vào dead vì sự cố tạm ngắn, không làm chậm đồng bộ thanh toán; lỗi vĩnh viễn đã dead ngay nên số lần chỉ áp cho lỗi tạm
- Đường lùi: Đổi OUTBOX_POLICY (test lặp theo maxAttempts) hoặc tách chính sách theo loại job

### D-089 · 2026-10-27T06:51:08+00:00 · Liên kết tra cứu đơn qua outbox hỏng (producer ghi token, handler cần link) và token thô nằm trong payload (BE-JOB-007)

- Phương án: (1) Không lưu token thô: producer ghi order_id, handler phát hành token lúc gửi (task mới T-149) · (2) Handler dựng URL từ token + env, khai ngoại lệ token trong payload · (3) Producer ghi sẵn link (token vẫn trong payload)
- Chọn: Không lưu token thô: producer ghi order_id, handler phát hành token lúc gửi (task mới T-149)
- Lý do (tiêu chí chất lượng cuối): (1) an toàn: không có bí mật trong bảng outbox/log; sửa lỗi thật chức năng tra cứu; (3) test được qua order-lookup.spec
- Đường lùi: Revert T-149; quay về producer ghi link

### D-090 · 2026-10-27T07:02:23+00:00 · T-119: giây trong RFC3339 bắt buộc cả cho CSV đối soát?

- Phương án: (1) Bắt buộc giây ở mọi đầu vào (một helper, đúng RFC 3339 §5.6) · (2) Giây tuỳ chọn riêng cho CSV (đường parse thứ hai)
- Chọn: Bắt buộc giây ở mọi đầu vào (một helper, đúng RFC 3339 §5.6)
- Lý do (tiêu chí chất lượng cuối): (1) cách hiểu chặt hơn, một nguồn sự thật; chưa có dữ liệu/tài liệu nào dùng dạng thiếu giây; lỗi 422 nêu trường + ví dụ nên người nhập biết sửa
- Đường lùi: Nới regex giây tuỳ chọn trong parseRfc3339 cho CSV

### D-091 · 2026-10-27T08:25:49+00:00 · T-149 câu hỏi mở: ký giả trong runOrderLookup; redrive muộn phát token mới; token trùng nếu 2 thư cùng giây

- Phương án: (1) Giữ: không ký giả (hai nhánh không khớp vẫn chạy cùng bước); redrive phát token mới hạn 15 phút từ lúc gửi; chấp nhận token trùng cùng giây (một link đổi được); STOREFRONT_URL bắt buộc ở production vào danh sách G7 · (2) Thêm ký giả; dead sự kiện lookup cũ hơn N phút; thêm nonce vào token (đổi packages/domain)
- Chọn: Giữ: không ký giả (hai nhánh không khớp vẫn chạy cùng bước); redrive phát token mới hạn 15 phút từ lúc gửi; chấp nhận token trùng cùng giây (một link đổi được); STOREFRONT_URL bắt buộc ở production vào danh sách G7
- Lý do (tiêu chí chất lượng cuối): (1) không lộ tồn tại đơn qua thời gian (nhánh khớp đã chậm hơn vì ghi DB, chênh lệch thật nằm ở outbox bất đồng bộ); token chỉ mở đúng đơn, một lần, gửi về chủ đơn nên phát mới khi redrive không mở rộng quyền; (3) không đổi domain cho ca hiếm
- Đường lùi: Thêm nonce vào issueOrderToken; lọc sự kiện order.lookup_link quá hạn trong dispatcher

### D-092 · 2026-10-27T09:10:26+00:00 · T-095: bộ đếm webhook khi DB lỗi; topology E2E hai bản sao

- Phương án: (1) Fail-open + log warn (như rate limit Store; callback vẫn phải qua xác thực chữ ký); E2E: A mặc định (HTTP + job), B chỉ HTTP · (2) Fail-closed 503 khi bộ đếm lỗi; E2E cả hai bản chạy job
- Chọn: Fail-open + log warn (như rate limit Store; callback vẫn phải qua xác thực chữ ký); E2E: A mặc định (HTTP + job), B chỉ HTTP
- Lý do (tiêu chí chất lượng cuối): (1) giới hạn tần suất là lớp phụ sau xác thực callback, chặn callback thật khi DB chập chờn làm mất cập nhật vận đơn (tệ hơn); (3) topology E2E khớp triển khai dự kiến (một worker, nhiều server)
- Đường lùi: Đổi nhánh lỗi của hitRateCounter sang 503; thêm MEDUSA_WORKER_MODE cho B

### D-093 · 2026-10-27T09:41:38+00:00 · T-095 review: ARC-RES-005 chưa đạt (cache phí ship, upload đĩa cục bộ, IPN VNPAY limiter trong tiến trình)

- Phương án: (1) Đóng một phần: merge T-095 (limiter GHN Postgres + E2E hai bản sao), không tick ARC-RES-005, ghi Thiếu → T-152/T-153/T-154 · (2) Mở rộng T-095 làm luôn cả ba việc trước khi merge
- Chọn: Đóng một phần: merge T-095 (limiter GHN Postgres + E2E hai bản sao), không tick ARC-RES-005, ghi Thiếu → T-152/T-153/T-154
- Lý do (tiêu chí chất lượng cuối): (2)(3) lát nhỏ, mỗi việc có Gate riêng; phần đã làm đúng và có test; tick blueprint chỉ khi đủ bằng chứng nên không tick sai MUST
- Đường lùi: Gộp T-152..T-154 vào một lát nếu muốn đóng ARC-RES-005 một lần

### D-094 · 2026-10-27T10:26:32+00:00 · T-152: chặn sớm trong bộ nhớ không UPSERT nên cửa sổ trước nhẹ hơn sau đợt dội (cửa sổ kế cho qua sớm hơn vài lượt)

- Phương án: (1) Chấp nhận: cùng cửa sổ quyết định y hệt; tổng lượt qua trong cửa sổ trượt vẫn ≤ hạn mức; Retry-After không dài hơn bộ đếm chung · (2) Gom lượt bị chặn sớm, ghi bù UPSERT +n bằng bộ flush nền
- Chọn: Chấp nhận: cùng cửa sổ quyết định y hệt; tổng lượt qua trong cửa sổ trượt vẫn ≤ hạn mức; Retry-After không dài hơn bộ đếm chung
- Lý do (tiêu chí chất lượng cuối): (1) hạn mức công bố vẫn giữ; (3) không thêm bộ flush nền và tham số tăng; mục tiêu giảm ghi DB khi bị dội đạt
- Đường lùi: Thêm tham số tăng cho hitRateCounter và flush định kỳ số lượt bị chặn sớm

### D-095 · 2026-10-27T10:40:26+00:00 · T-155: lỗi bù trừ catalog có mở exception vận hành không (OPS_EXCEPTION_KINDS chưa có kind phù hợp)

- Phương án: (1) Giữ log error trong T-155; tách T-156 thêm kind catalog_compensation_failed (migration + labels + owner) như catalog_index_mismatch (D-040) · (2) Dùng lại kind sẵn có (catalog_index_mismatch/outbox_dead) · (3) Chỉ log, không bao giờ mở exception
- Chọn: Giữ log error trong T-155; tách T-156 thêm kind catalog_compensation_failed (migration + labels + owner) như catalog_index_mismatch (D-040)
- Lý do (tiêu chí chất lượng cuối): (1) đúng nghĩa, hiện trên dashboard vận hành; (2) migration tách lát riêng có đường lùi; không làm bẩn kind cũ
- Đường lùi: Bỏ T-156; giữ chỉ log

### D-096 · 2026-10-27T10:51:02+00:00 · T-153: bỏ cache phí trong tiến trình làm mỗi lần quote đều hỏi GHN; phương thức thanh toán có là đầu vào định phí

- Phương án: (1) Giữ: không cache ở route quote (đo giới hạn tần suất GHN thật trước khi thêm); phương thức thanh toán là đầu vào định phí (cách hiểu chặt) · (2) Thêm cache Redis cho route quote; bỏ điều kiện phương thức thanh toán
- Chọn: Giữ: không cache ở route quote (đo giới hạn tần suất GHN thật trước khi thêm); phương thức thanh toán là đầu vào định phí (cách hiểu chặt)
- Lý do (tiêu chí chất lượng cuối): (1) phí báo khách luôn mới; chặt hơn khi phí sau này phụ thuộc COD; (3) đơn giản, không thêm lớp cache; rate limit store đã chặn quote dồn dập
- Đường lùi: Thêm cache Redis TTL ngắn cho quoteShippingFee; bỏ payment_method khỏi reusableShippingFee

### D-097 · 2026-10-27T11:01:31+00:00 · Phản hồi 400 của Medusa chép giá trị admin vừa gửi (unique: '<Bảng> with k: v, already exists.') ra message/detail

- Phương án: (1) Tách task T-157: error-handler trả thông điệp chung cho dạng dbErrorMapper unique/FK ở 4xx, giữ mã lỗi + tên trường (không giá trị); test admin vẫn hiểu lỗi · (2) Giữ nguyên
- Chọn: Tách task T-157: error-handler trả thông điệp chung cho dạng dbErrorMapper unique/FK ở 4xx, giữ mã lỗi + tên trường (không giá trị); test admin vẫn hiểu lỗi
- Lý do (tiêu chí chất lượng cuối): (1) 4xx không lộ chi tiết nội bộ/giá trị, kể cả với admin (log/proxy/APM có thể ghi body); (4) giữ tên trường để admin sửa được
- Đường lùi: Bỏ mẫu khỏi INTERNAL_LEAK (bổ sung sau T-157: bản cài nằm ở `dbValueMessage` trong error-handler — đường lùi là bỏ lời gọi `dbValueMessage`)

### D-098 · 2026-10-27T11:17:46+00:00 · T-152: lượt đang bay (chờ DB) có tính vào chặn sớm không — lệch chữ D-092 khi DB treo

- Phương án: (1) Tính: giữ trần ghi DB khi bị dội; khi DB treo và > hạn mức lượt đang bay của một IP thì lượt sau 429, tự hết sau ≤ 2 cửa sổ · (2) Không tính lượt đang bay (mất trần ghi DB khi dội song song)
- Chọn: Tính: giữ trần ghi DB khi bị dội; khi DB treo và > hạn mức lượt đang bay của một IP thì lượt sau 429, tự hết sau ≤ 2 cửa sổ
- Lý do (tiêu chí chất lượng cuối): (1) không mở vector dội ghi DB; tác động chỉ khi DB treo — lúc đó handler cũng không xử lý được; giống limiter trong tiến trình cũ (300/10 s)
- Đường lùi: Bỏ đếm ticket chưa có kết quả khỏi effective() trong LocalHitGuard

### D-099 · 2026-10-27T12:26:37+00:00 · openOpsExceptionIfNoneActive không tự tuần tự hoá — race tạo trùng exception khi người gọi không giữ khoá

- Phương án: (1) T-156 giữ khoá ở người gọi; tách T-158: tuần tự hoá trong helper bằng pg_advisory_xact_lock(hashtext(kind)) cho mọi người gọi · (2) Partial unique index (kind) where state active · (3) Giữ mỗi người gọi tự khoá
- Chọn: T-156 giữ khoá ở người gọi; tách T-158: tuần tự hoá trong helper bằng pg_advisory_xact_lock(hashtext(kind)) cho mọi người gọi
- Lý do (tiêu chí chất lượng cuối): (1) sửa gốc cho mọi người gọi ở một chỗ; (2) không cần migration làm lỗi khi dữ liệu đã trùng; lát riêng có test race
- Đường lùi: Bỏ advisory lock trong helper, quay về khoá ở người gọi

### D-100 · 2026-10-27T12:26:37+00:00 · T-141: phân quyền tải file private; 403 vs 404 cho người khác; PRIVATE_UPLOAD_DIR khi có S3

- Phương án: (1) Theo vai trò settings.manage + MFA (chỉ owner xem thông báo xuất); giữ 403 đồng nhất (không lộ tồn tại); quyết PRIVATE_UPLOAD_DIR ở T-154 · (2) Bảng x_private_file gắn người xuất (migration, ảnh hưởng T-154); 404 cho người khác
- Chọn: Theo vai trò settings.manage + MFA (chỉ owner xem thông báo xuất); giữ 403 đồng nhất (không lộ tồn tại); quyết PRIVATE_UPLOAD_DIR ở T-154
- Lý do (tiêu chí chất lượng cuối): (1) chặt: chỉ owner có MFA tải file PII, phản hồi đồng nhất không lộ tồn tại; (3) không thêm bảng sở hữu khi File Module chưa có; catalog_manager không tải được xuất sản phẩm là thiếu UX chấp nhận được
- Đường lùi: Thêm quyền theo loại file (catalog.read cho xuất sản phẩm) hoặc bảng x_private_file

### D-101 · 2026-10-27T12:56:33+00:00 · T-156: dedupe exception catalog_compensation_failed theo kind làm mất dấu sản phẩm thứ hai (lỗi bù trừ không tự phát hiện lại)

- Phương án: (1) Dedupe theo kind + detail->>'product_id' trong các dòng đang mở; dashboard lấy reference từ product_id · (2) Một dòng, nối product_ids vào detail · (3) Chỉ lấy reference dashboard
- Chọn: Dedupe theo kind + detail->>'product_id' trong các dòng đang mở; dashboard lấy reference từ product_id
- Lý do (tiêu chí chất lượng cuối): (1) mỗi sản phẩm lệch có một mục xử lý riêng, đóng một mục không làm mất dấu mục khác; (3) không migration
- Đường lùi: Về dedupe theo kind

### D-102 · 2026-10-27T12:56:34+00:00 · T-141: tải file private qua route có phiên thay vì URL ký hết hạn ngắn (lệch chữ PLAN/BE-FILE-005)

- Phương án: (1) Route có phiên + MFA + quyền, không URL ký (link trong thông báo nền sẽ hết hạn trước khi mở; không bí mật trong URL; thu quyền có hiệu lực ngay) · (2) URL ký HMAC hạn ngắn
- Chọn: Route có phiên + MFA + quyền, không URL ký (link trong thông báo nền sẽ hết hạn trước khi mở; không bí mật trong URL; thu quyền có hiệu lực ngay)
- Lý do (tiêu chí chất lượng cuối): (1) chặt hơn: mọi lần tải kiểm phiên+quyền+MFA, không token trong URL/log; mục Kiểm 'URL hết hạn → 403' thay bằng 'không phiên/không quyền → 401/403'
- Đường lùi: Thêm endpoint cấp URL ký hạn ngắn từ route này (T-154 presigned)

### D-103 · 2026-10-27T13:12:56+00:00 · T-159: phạm vi che thông điệp Medusa nội suy giá trị (22 dạng PII/nhạy cảm đã làm; còn nhóm giá trị admin gõ độ nhạy thấp và echo req.params.id ở 404)

- Phương án: (1) Đóng T-159 với 22 dạng; không che id echo (id/handle hệ thống, cần cho debug admin); nhóm còn lại ghi backlog (không task) vì là giá trị cấu hình catalog do chính admin gõ, không PII · (2) Che toàn bộ 514 dạng và id echo
- Chọn: Đóng T-159 với 22 dạng; không che id echo (id/handle hệ thống, cần cho debug admin); nhóm còn lại ghi backlog (không task) vì là giá trị cấu hình catalog do chính admin gõ, không PII
- Lý do (tiêu chí chất lượng cuối): (1) PII/bí mật (email, SĐT, idempotency key, mã khuyến mãi, tên biến thể) đã che; (3)(4) che id làm mất thông tin debug, bảng che quá rộng tăng rủi ro báo nhầm
- Đường lùi: Thêm dòng vào ECHO_FORMS cho dạng cần che

### D-104 · 2026-10-27T13:23:24+00:00 · T-141: tạo/kiểm thư mục private ngay lúc khởi động provider (fail-fast) hay trì hoãn tới lần đọc/ghi đầu

- Phương án: (1) Giữ fail-fast lúc khởi động; ghi rõ mọi tiến trình backend (server, worker, migrate) phải mount volume PRIVATE_UPLOAD_DIR (GO-NO-GO) · (2) Trì hoãn tới lần đọc/ghi đầu
- Chọn: Giữ fail-fast lúc khởi động; ghi rõ mọi tiến trình backend (server, worker, migrate) phải mount volume PRIVATE_UPLOAD_DIR (GO-NO-GO)
- Lý do (tiêu chí chất lượng cuối): (1) mặc định an toàn: cấu hình sai lộ ra ngay khi deploy thay vì lúc khách xuất file; (3) đơn giản
- Đường lùi: Chuyển preparePrivateDir sang lazy trong provider

### D-105 · 2026-10-27T14:08:50+00:00 · T-158: helper ops exception hết lock_timeout (55P03) thì làm gì

- Phương án: (1) Ghi thêm một lần không khoá trong giao dịch mới (có thể trùng, không mất dấu) · (2) Ném lỗi, người gọi chỉ log (mất dấu khi DB nghẽn)
- Chọn: Ghi thêm một lần không khoá trong giao dịch mới (có thể trùng, không mất dấu)
- Lý do (tiêu chí chất lượng cuối): (1) mất dấu ngoại lệ vận hành tệ hơn trùng (nguyên tắc T-156/D-101); ca hiếm khi DB nghẽn
- Đường lùi: Bỏ nhánh ghi dự phòng khi 55P03

### D-106 · 2026-10-27T14:40:02+00:00 · T-098: backend start mặc định bind 127.0.0.1 (trước: mọi giao diện); in cấu hình hiệu lực; proxy.ts ném lỗi khi thiếu NEXT_PUBLIC_* ở production

- Phương án: (1) Giữ bind 127.0.0.1 cho cả dev và start, triển khai đặt HOST=0.0.0.0 (ENV.md + RUNBOOK + GO-NO-GO); thêm script print-config dùng formatEffectiveConfig; chấp nhận proxy ném lỗi khi thiếu biến public ở production · (2) Chỉ dev bind 127.0.0.1, start giữ mọi giao diện
- Chọn: Giữ bind 127.0.0.1 cho cả dev và start, triển khai đặt HOST=0.0.0.0 (ENV.md + RUNBOOK + GO-NO-GO); thêm script print-config dùng formatEffectiveConfig; chấp nhận proxy ném lỗi khi thiếu biến public ở production
- Lý do (tiêu chí chất lượng cuối): (1) mặc định an toàn BASE-SEC-010; cấu hình thiếu lộ ra ngay lúc khởi động; (3) một script nhỏ đóng BASE-CFG-007
- Đường lùi: Bỏ -H khỏi script start

### D-107 · 2026-10-27T15:00:40+00:00 · T-158: dạng khoá advisory và hàng rào scope (lệch chữ PLAN hashtext(kind))

- Phương án: (1) 2×int4 (hashtext namespace, hashtext(key)) theo kind hoặc kind+giá trị scope; hàng rào OPS_EXCEPTION_ACTIVE_SCOPES một dạng scope mỗi kind · (2) pg_advisory_xact_lock(hashtext(kind)) như chữ PLAN
- Chọn: 2×int4 (hashtext namespace, hashtext(key)) theo kind hoặc kind+giá trị scope; hàng rào OPS_EXCEPTION_ACTIVE_SCOPES một dạng scope mỗi kind
- Lý do (tiêu chí chất lượng cuối): (1) không va khoá bigint objsubid=1 của returns/trigger x_refund; hai sản phẩm không chờ nhau; hàng rào ngăn trộn dạng scope gây dedupe sai
- Đường lùi: Về khoá bigint theo kind, bỏ hàng rào

### D-108 · 2026-10-27T15:00:40+00:00 · T-147: quyền đọc native sau khi đóng mặc định any_role (catalog cho order/kế toán/CSKH; khách theo order.read; giá theo price.write; route mới trong nhóm đã khai)

- Phương án: (1) Giữ chặt: catalog chỉ owner/catalog_manager/kho; khách theo order.read (T-023); bảng giá theo price.write; thêm test chốt số route GET native (133) để mỗi lần nâng cấp Medusa phải rà · (2) Mở any_role cho catalog; thêm price.read; quyền khách riêng
- Chọn: Giữ chặt: catalog chỉ owner/catalog_manager/kho; khách theo order.read (T-023); bảng giá theo price.write; thêm test chốt số route GET native (133) để mỗi lần nâng cấp Medusa phải rà
- Lý do (tiêu chí chất lượng cuối): (1) đóng mặc định, quyền tối thiểu; nới khi có nhu cầu thật có bằng chứng; (3) không đổi ma trận domain trong lát này
- Đường lùi: Thêm quy tắc 'một trong các quyền' cho catalog read hoặc price.read vào domain

### D-109 · 2026-10-27T15:00:41+00:00 · T-134: mã hết hạn giữa quote/submit trả 422 DISCOUNT_NOT_APPLICABLE hay 409 DISCOUNT_CHANGED; diffQuotes có so cả ảnh chụp điều khoản

- Phương án: (1) Giữ 422 (storefront đã xử lý); diffQuotes giữ so mã + số giảm (khách xác nhận số tiền, không phải điều khoản) · (2) 409 + quote mới; so cả ảnh chụp
- Chọn: Giữ 422 (storefront đã xử lý); diffQuotes giữ so mã + số giảm (khách xác nhận số tiền, không phải điều khoản)
- Lý do (tiêu chí chất lượng cuối): (3) không đổi API-CONTRACT/storefront; (4) khách chỉ phải xác nhận lại khi số tiền đổi; (1) ảnh chụp lưu điều khoản tại lúc submit nên đối soát đúng
- Đường lùi: Đổi lỗi hết hạn sang 409 DISCOUNT_CHANGED, diffQuotes so thêm snapshot
