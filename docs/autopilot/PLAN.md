# docs/autopilot/PLAN.md — x-shop · P0 (đợt 1)

> Duyệt: D-006 (phiên chính tự duyệt 2026-10-24) · Spec gốc: `docs/specs/DAC-TA-GOC.md` + `docs/specs/SPEC-*.md` (F-001…F-012) · Blueprint: BLUEPRINT.md · ADR-0001 (stack)

## Tóm tắt duyệt (≤ 30 dòng)
- **Mục tiêu đợt 1:** P0 chạy được cục bộ/CI với provider mock theo protocol: 6 màn hình cốt lõi + đơn chờ thanh toán có giữ
  hàng chứng minh bằng test cạnh tranh, COD + VNPAY (mock/sandbox), GHN (mock/sandbox), đổi trả/hoàn/đối soát, RBAC + MFA.
- **Stack (ADR-0001, xác minh 2026-10-24):** Node 22 LTS · pnpm workspace · Medusa v2.22.x · Next.js 16.x App Router + React 19 ·
  PostgreSQL 16 · Redis 7 · Vitest + fast-check · Playwright + axe. Lõi tiền/tồn/trạng thái thuần TS ở `packages/domain`.
- **Thứ tự theo rủi ro:** nền tảng → lõi domain thuần (rẻ, test nhanh) → **spike đơn chờ + giữ hàng trên Medusa (RK-001)**
  → catalog/search read model (RK-002) → storefront 6 màn → vận hành (RBAC/MFA RK-003, GHN, đổi trả, đối soát) → hoàn thiện.
- **Quyết định đổi so với đặc tả (góp ý đã nêu):** (1) Lát 3 là spike có cổng dừng — nếu Medusa không giữ được AT04/AT05/AT35
  thì ADR đổi hướng trước khi làm UI giao dịch; (2) read model lọc cùng SKU là bắt buộc P0, không "nếu cần"; (3) MFA/RBAC
  làm như module riêng ở Lát 6, không đợi hoàn thiện; (4) RBAC native của Medusa là Enterprise → tự xây; MFA dùng TOTP native; webhook payment native tự hoàn tất giỏ → IPN route riêng; (5) VND 0 chữ số thập phân + phân bổ largest-remainder có test thuộc tính;
  (6) đối soát P0 = nhập batch COD/sao kê + đối chiếu có lịch sử (tự động hóa sâu ở P1).
- **Blueprint MUST:** 490 mục (web-app + ecommerce, M) — tick dần theo task; mục không áp dụng ghi `[~]` có điều kiện.
- **Ngoài phiên (việc chờ người):** khoá VNPAY/GHN sandbox+live, hợp đồng, chính sách đổi trả/thuế, ảnh/dữ liệu thật,
  hạ tầng production, UAT với người mua thật, rà soát pháp lý — `loop defer`.

## Ngân sách (4 con số)
- Số vòng tối đa: mặc định `--single-session` (max(40, 8 × task chưa làm))
- Ngân sách: trong ngân sách token của phiên
- Timeout mỗi lệnh Gate: 1800 giây (`XT_RECORD_TIMEOUT`) — test tích hợp Medusa + Playwright
- Ngày hết hạn: không đặt (`--hours` bỏ trống)

## Hạn
| Loại | Ngày | Hậu quả nếu trễ | Cách xử lý khi trễ |
|---|---|---|---|
| Hạn mong muốn | 8–12 tuần cho P0 (ước lượng đặc tả §14.2) | nội bộ | cắt P0 → minh bạch với chủ dự án, không hạ cổng |

## Ủy quyền production
- grant: payments | mode=sandbox | max_per_txn=0 | refund=false
- grant: data_delete | hard_delete=false | max_rows=100
- grant: data_export | pii=false | max_rows=10000
- grant: outbound_messages | live=false | max_per_hour=0
- grant: auth_crypto | custom_crypto=false
- grant: secrets | read_values=false

## Điểm dừng bắt buộc về hành động
- Tiền thật, khoá merchant VNPAY/GHN thật, gửi email/SMS thật, deploy production, dữ liệu khách thật → `loop defer`.
- Merge PR ngoại lệ cứng (tiền, auth, mật mã, PII) khi `merge_hard_exceptions: human`.
- TOTP dùng thư viện chuẩn (RFC 6238), không tự viết mật mã (`custom_crypto=false`).

## Task

### Lát 1 — Nền tảng (F-001)
- [x] `T-001` Monorepo pnpm + TypeScript strict + ESLint/Prettier + Vitest + `packages/domain` khung; điền lệnh thật `xt.yaml`; CI có Postgres/Redis; `.env.example` + `.nvmrc` (files: package.json, pnpm-workspace.yaml, packages/domain/, xt.yaml, .github/workflows/ci.yml, tsconfig.base.json, eslint.config.mjs) — Gate: `.xtemplates/scripts/dev-task.sh gate`
- [x] `T-002` Medusa v2 backend `apps/backend` (config Postgres/Redis qua env đã validate, VND store/region seed, health) + test tích hợp chạy được với DB thật (sau: T-001; files: apps/backend/, scripts/dev-services.sh; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration`
- [x] `T-003` Next.js storefront `apps/storefront` + `DESIGN.md` + token CSS (đặc tả §3.1) + font Be Vietnam Pro tự host; cổng tương phản token (sau: T-001; files: apps/storefront/, DESIGN.md) — Gate: `python3 .xtemplates/scripts/xt.py contrast apps/storefront/src/styles/tokens.css --pairs apps/storefront/contrast-pairs.txt && pnpm --filter @x-shop/storefront build`

- [x] `T-039` Bộ component UI storefront theo DESIGN.md (Button, IconButton, Price, SizeSelector, ColorSwatch, Chip, Drawer/Dialog có khóa focus, Toast aria-live, Skeleton, InlineError, EmptyState, ProductCard 4:5, Breadcrumb) + test hành vi/tiếp cận (sau: T-003; files: apps/storefront/src/components/ui/, apps/storefront/src/components/product-card/) — Gate: `pnpm --filter @x-shop/storefront test -- ui`

### Lát 2 — Lõi domain thuần (RK-004)
- [x] `T-004` Tiền VND số nguyên, phân bổ giảm giá largest-remainder, tính quote (subtotal/giảm/ship/tổng), kẹp giảm ≤ subtotal; test thuộc tính (sau: T-001; files: packages/domain/src/money/, packages/domain/src/pricing/) — Gate: `pnpm --filter @x-shop/domain test -- money pricing`
- [x] `T-005` Chuẩn hóa tiếng Việt (NFC, bỏ dấu, đ→d) + so khớp lọc cùng SKU + giá SKU khớp (AT01, AT31) + chuẩn hóa query URL lọc (sau: T-001; files: packages/domain/src/catalog/) — Gate: `pnpm --filter @x-shop/domain test -- catalog`
- [x] `T-006` Máy trạng thái đơn/thanh toán/giao/đổi trả/hoàn/đối soát, đơn điệu (không lùi captured→pending), bất biến refund ≤ captured, COD amount (AT13) (sau: T-001; files: packages/domain/src/state/, packages/domain/src/ledger/) — Gate: `pnpm --filter @x-shop/domain test -- state ledger`
- [x] `T-007` Protocol VNPAY PAY: tạo URL ký HMAC-SHA512, xác minh IPN/return, mã phản hồi RspCode, querydr/refund payload, giờ GMT+7; mock server (AT07) (sau: T-001; files: packages/domain/src/providers/vnpay/) — Gate: `pnpm --filter @x-shop/domain test -- vnpay`
- [x] `T-008` Protocol GHN (báo phí, tạo đơn hai cấp, client_order_code, ánh xạ trạng thái, COD) + danh mục địa chỉ 2 cấp có nguồn/giấy phép (sau: T-001; files: packages/domain/src/providers/ghn/, packages/domain/data/) — Gate: `pnpm --filter @x-shop/domain test -- ghn address`

### Lát 3 — Spike giao dịch trên Medusa (RK-001 — cổng dừng)
- [x] `T-009` Module `checkout` (checkout_attempt, payment_attempt, payment_ledger, webhook_inbox, outbox, idempotency_record) + migration + ràng buộc UNIQUE/CHECK (sau: T-002, T-006; files: apps/backend/src/modules/checkout/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- checkout-module`
- [x] `T-010` Quote + submit workflow: đơn chờ/COD + reservation gắn line_item dưới khóa, idempotency, cart version (AT03, AT04, AT05, AT33) (sau: T-009, T-004; files: apps/backend/src/workflows/checkout/, apps/backend/src/api/store/x/checkout/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- checkout-submit`
- [x] `T-011` IPN VNPAY + return + status: xác nhận chính đơn đã có, không tự hoàn tất giỏ lần hai (AT06, AT07, AT08, AT35, AT36) (sau: T-010, T-007; files: apps/backend/src/api/x/webhooks/, apps/backend/src/workflows/payment/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- payment-ipn`
- [x] `T-012` Job hết hạn + đối chiếu + bù trừ worker chết + tiền đến sau hủy (AT09, AT10, AT11, AT12) (sau: T-011; files: apps/backend/src/jobs/, apps/backend/src/workflows/expiry/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- checkout-expiry`

### Lát 4 — Catalog & tìm kiếm (RK-002)
- [x] `T-013` Mô hình sản phẩm màu × size, ảnh theo màu, module `size_chart`, thuộc tính (chất liệu/form/bảo quản), kiểm trước xuất bản (ADM01, ADM03) + seed dữ liệu demo (sau: T-002; files: apps/backend/src/modules/fashion/, apps/backend/src/scripts/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- catalog-model`
- [x] `T-014` Read model `catalog_variant_index` + đồng bộ theo sự kiện + API list/search/facets (AT01, AT31, CAT01–04) (sau: T-013, T-005; files: apps/backend/src/modules/catalog-index/, apps/backend/src/api/store/x/products/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- catalog-search`
- [x] `T-015` Import CSV preview/commit idempotent + export chống công thức (ADM02) (sau: T-013; files: apps/backend/src/modules/catalog-import/, apps/backend/src/api/admin/x/imports/) — Gate: `pnpm --filter @x-shop/backend test:integration -- catalog-import`

### Lát 5 — Storefront 6 màn hình (F-002)
- [x] `T-016` Lớp dữ liệu server (client Medusa/x-API, no-store cho riêng tư), layout, header/menu từ cấu hình, footer, trang chủ khối nội dung (WEB01) (sau: T-003, T-014; files: apps/storefront/src/app/, apps/storefront/src/lib/, apps/storefront/src/components/layout/) — Gate: `pnpm --filter @x-shop/storefront test -- home layout`
- [x] `T-017` Danh mục + tìm kiếm: lưới, card, drawer lọc nháp, chip, URL state, phân trang crawl được (CAT03, AT32) (sau: T-016; files: apps/storefront/src/app/(shop)/danh-muc/, apps/storefront/src/app/(shop)/tim-kiem/, apps/storefront/src/components/catalog/) — Gate: `pnpm --filter @x-shop/storefront test -- catalog`
- [x] `T-018` PDP: gallery theo màu, nút size, AT02, sticky CTA, bảng size, JSON-LD ProductGroup (PDP01–05, AT26) (sau: T-016; files: apps/storefront/src/app/(shop)/san-pham/, apps/storefront/src/components/product/) — Gate: `pnpm --filter @x-shop/storefront test -- product`
- [x] `T-019` Giỏ hàng: sửa số lượng/biến thể, lỗi từng dòng, tổng từ server (CHK01) (sau: T-016, T-010; files: apps/storefront/src/app/(shop)/gio-hang/, apps/storefront/src/components/cart/) — Gate: `pnpm --filter @x-shop/storefront test -- cart`
- [x] `T-020` Checkout một trang: liên hệ, địa chỉ 2 cấp, phương thức, xác nhận tổng mới, retry giữ dữ liệu (CHK02–06) (sau: T-019, T-008; files: apps/storefront/src/app/(shop)/thanh-toan/, apps/storefront/src/components/checkout/) — Gate: `pnpm --filter @x-shop/storefront test -- checkout`
- [x] `T-021` Trang đơn hàng/kết quả thanh toán "Đang xác nhận", tra cứu bảo mật (POST01, CHK06) (sau: T-020, T-011; files: apps/storefront/src/app/(shop)/don-hang/) — Gate: `pnpm --filter @x-shop/storefront test -- order`
- [x] `T-022` E2E Playwright luồng R-001 (COD) + R-002 (VNPAY mock) + axe 6 màn + reflow 320 px (AT25) (sau: T-021; files: e2e/, playwright.config.ts) — Gate: `pnpm e2e`

- [x] `T-040` Bổ sung P0 storefront: gợi ý truy vấn (debounce, giới hạn độ dài — CAT01), khôi phục vị trí danh sách khi Back từ PDP (CAT03), endpoint `/store/x/categories` + menu từ backend, nối `XS_DATA_SOURCE=backend` với API thật của T-014 (sau: T-014, T-018; files: apps/storefront/src/lib/catalog/, apps/storefront/src/components/catalog/, apps/backend/src/api/store/x/categories/) — Gate: `pnpm --filter @x-shop/storefront test -- catalog search-suggest scroll`

### Lát 6 — Vận hành (F-008, F-009, F-010)
- [x] `T-023` RBAC: ma trận vai trò dữ liệu + middleware mọi `/admin/x/*` + test sinh tự động phủ route × vai trò (AT21) (sau: T-002; files: apps/backend/src/modules/rbac/, apps/backend/src/api/middlewares.ts; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- rbac`
- [x] `T-024` MFA admin bằng TOTP native của Auth Module (`requireMfa` cho route nhạy cảm) + chính sách phiên + xác thực lại thao tác nhạy cảm (SEC02) (sau: T-023; files: apps/backend/src/modules/mfa/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- mfa`
- [x] `T-025` Audit log append-only + che PII; điều chỉnh tồn có lý do/idempotency, không dưới reserved (INV03) (sau: T-023; files: apps/backend/src/modules/audit/, apps/backend/src/api/admin/x/inventory/) — Gate: `pnpm --filter @x-shop/backend test:integration -- audit inventory-adjust`
- [x] `T-026` Giao vận GHN: báo phí trong quote, tạo vận đơn idempotent, callback xác minh bằng query, COD amount, xác nhận COD (AT11, AT13, AT14, AT23, AT34) (sau: T-012, T-008; files: apps/backend/src/modules/shipping-ghn/, apps/backend/src/api/x/webhooks/shipping/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- shipping`
- [x] `T-027` Hủy đơn, đổi trả theo dòng, kiểm định trước restock, hoàn tiền một phần theo giá thực trả, đổi size bằng đơn thay thế, snapshot size_chart version vào dòng đơn (POST02–03, AT15, AT16, AT17) (sau: T-026, T-025; files: apps/backend/src/modules/returns/, apps/backend/src/workflows/returns/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- returns refunds`
- [x] `T-028` Đối soát: nhập batch COD/sao kê, đối chiếu, chênh lệch; dashboard ngoại lệ + báo cáo tách giá trị đơn/tiền thu (§5.5, AT14) (sau: T-027; files: apps/backend/src/modules/settlement/, apps/backend/src/api/admin/x/reports/) — Gate: `pnpm --filter @x-shop/backend test:integration -- settlement reports`
- [x] `T-029` Outbox thông báo email/SMS có message key + retry, adapter log (AT18) (sau: T-012; files: apps/backend/src/modules/notify/) — Gate: `pnpm --filter @x-shop/backend test:integration -- notify`
- [ ] `T-030` Admin UI mở rộng: trang ngoại lệ, duyệt hoàn tiền 2 người, kiểm định hàng trả, nhập CSV (sau: T-028, T-015; files: apps/backend/src/admin/) — Gate: `pnpm --filter @x-shop/backend build`

- [x] `T-041` Vá sau T-021/T-033: tra cứu đơn thời gian đồng đều (luôn cùng công việc dù khớp hay không — chống dò tồn tại), bắn `purchase` ở trang đơn khi thanh toán/đặt COD đã xác nhận (dedupe order_id), `VNPAY_RETURN_URL` kèm `attempt`, audit cho import CSV, giới hạn tần suất ghi audit lần bị từ chối (sau: T-021, T-033, T-025; files: apps/backend/src/lib/orders/, apps/storefront/src/components/orders/, apps/backend/src/api/admin/x/imports/) — Gate: `pnpm --filter @x-shop/backend test:integration -- order-lookup catalog-import audit && pnpm --filter @x-shop/storefront test -- order analytics`
- [x] `T-042` Mất Redis/Locking Module khi submit checkout → 503 `LOCK_UNAVAILABLE` có hướng dẫn (không bán bằng tồn cache, catalog vẫn đọc được), test tích hợp giả lập lỗi kết nối khóa; cập nhật RUNBOOK §3 bỏ ghi chú "chưa xác minh" (phát hiện ở T-037) (sau: T-010, T-037; files: apps/backend/src/workflows/checkout/, apps/backend/src/api/store/x/checkout/, docs/ops/RUNBOOK.md; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- checkout-lock-outage`
- [x] `T-043` Fulfillment native khi tạo vận đơn GHN: nhả reservation + trừ tồn khi giao, `shipment_state`/`can_cancel` ở `lib/orders/view.ts` đúng với đơn đã gửi GHN (phát hiện ở T-027) (sau: T-026, T-027; files: apps/backend/src/modules/shipping-ghn/, apps/backend/src/lib/orders/view.ts; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- shipping-fulfillment`
- [ ] `T-044` Đóng route native POST `/admin/payments/:id/refund` (lách duyệt 2 người S-403), refund `failed` có đường hủy/thử lại không giữ tiền mãi, route hủy đơn cho nhân viên quyền `order.cancel` (phát hiện ở T-027) (sau: T-027; files: apps/backend/src/api/admin/x/permissions.ts, apps/backend/src/workflows/returns/, packages/domain/src/state/, apps/backend/src/api/admin/x/orders/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- refund-guard staff-cancel`
- [ ] `T-045` Hàng hoàn từ hãng: ánh xạ trạng thái GHN `cancel`/hoàn về, nhận hàng hoàn vào Kho cách ly chờ kiểm định (không tự cộng tồn); `restockLocationOf` đọc kho từ fulfillment thay vì reservation đã nhả (phát hiện ở T-043) (sau: T-043, T-027; files: apps/backend/src/lib/shipping/, apps/backend/src/workflows/returns/; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- shipping-return-to-sender`
- [x] `T-046` Vá sau T-034/T-042: rate limit `/store/x/products?q=`, `nosniff` cho `/static`, storefront hiển thị `LOCK_UNAVAILABLE` (503, thử lại sau) ở checkout giữ dữ liệu form (phát hiện ở T-034, T-042) (sau: T-034, T-042; files: apps/backend/src/api/middlewares.ts, apps/backend/src/lib/security/, apps/storefront/src/components/checkout/) — Gate: `pnpm --filter @x-shop/backend test:integration -- security && pnpm --filter @x-shop/storefront test -- checkout`
- [ ] `T-047` Chẩn đoán treo hook 300 s của `medusaIntegrationTestRunner` ở suite `checkout-lock-outage` (gặp 2 lần trong 12+ lần chạy: một lần trong `gate-par`, một lần trong `loop verify`, lúc có jest khác chạy song song; chạy riêng 9/9 xanh, ép chung Redis DB vẫn xanh): bắt `--detectOpenHandles`/log trạng thái client Redis lúc teardown, làm `restoreRedis` đợi `ready` và fail nhanh thay vì treo; chọn Redis DB index bằng khóa thư mục nguyên tử thay `pid % 12` nếu xác định là va chạm (phát hiện ở lượt kiểm PR #19) (sau: T-042; files: apps/backend/integration-tests/http/checkout-lock-outage.spec.ts, apps/backend/jest.config.js) — Gate: `pnpm --filter @x-shop/backend test:integration -- checkout-lock-outage`
- [ ] `T-048` Nối E2E vào CI (D-025): áp `docs/ops/patches/T-048-ci-e2e.patch` (job `e2e` thêm service Postgres/Redis như job `gate`; `xt.yaml` `e2e: "pnpm e2e"`, `e2e_setup` cài Chromium) — CẦN NGƯỜI commit: diff chạm cấu hình cổng nên hook commit chạy `test` đầy đủ (~15 phút) vượt timeout 600 s của PreToolUse (đã gửi phản hồi khung) (sau: T-022; files: .github/workflows/ci.yml, xt.yaml) — Gate: `bash .xtemplates/scripts/dev-task.sh e2e-mode`

### Lát 7 — Hoàn thiện (F-011, F-012)
- [x] `T-031` SEO: metadata, canonical, sitemap, robots, noindex lọc tùy ý, 404/410 (AT26) (sau: T-018, T-017; files: apps/storefront/src/app/sitemap.ts, apps/storefront/src/app/robots.ts) — Gate: `pnpm --filter @x-shop/storefront test -- seo`
- [x] `T-032` PWA: manifest, icon, service worker chỉ cache công khai, `/offline`, header no-store riêng tư (AT22, AT24) (sau: T-021; files: apps/storefront/public/, apps/storefront/src/app/offline/) — Gate: `pnpm --filter @x-shop/storefront test -- pwa cache`
- [x] `T-033` Telemetry sự kiện §13.1 không PII, purchase dedupe (AT29) (sau: T-021; files: apps/storefront/src/lib/analytics/) — Gate: `pnpm --filter @x-shop/storefront test -- analytics`
- [x] `T-034` Bảo mật: security headers/CSP, rate limit (search, coupon, checkout, lookup), CORS allowlist, CSRF, upload kiểm MIME (SEC01–05, AT20) (sau: T-021, T-023; files: apps/storefront/src/middleware.ts, apps/backend/src/api/middlewares.ts; exec: deep) — Gate: `pnpm --filter @x-shop/backend test:integration -- security && pnpm --filter @x-shop/storefront test -- security`
- [ ] `T-035` Ngân sách hiệu năng: script đo JS/CSS/font gzip trên build + Lighthouse lab hồ sơ §10.1 (sau: T-022; files: scripts/perf/) — Gate: `pnpm perf:budget`
- [ ] `T-036` Bộ dữ liệu 10.000 sản phẩm/50.000 SKU + kịch bản tải k6 (read/write mix §10.3) + báo cáo (AT27) (sau: T-014, T-012; files: scripts/load/, docs/ops/perf/) — Gate: `pnpm load:smoke`
- [x] `T-037` Backup/restore Postgres + diễn tập mất Redis + đối chiếu giao dịch dở + RUNBOOK (AT28) (sau: T-012; files: scripts/ops/, docs/ops/RUNBOOK.md) — Gate: `bash scripts/ops/restore-drill.sh`
- [ ] `T-038` THREAT-MODEL, DPIA, API-CONTRACT (OpenAPI), tick blueprint; `release-check` + GO-NO-GO (sau: T-034, T-037; files: docs/ops/, GO-NO-GO.md, BLUEPRINT.md) — Gate: `python3 .xtemplates/scripts/xt.py blueprint-status BLUEPRINT.md`

## Phụ thuộc ngoài
| Việc | Bên ngoài | Kế hoạch B |
|---|---|---|
| Khoá sandbox VNPAY (TMN code, hash secret) | Chủ dự án đăng ký merchant | Mock server theo protocol (T-007) |
| Token sandbox GHN, shop_id | Chủ dự án | Mock theo protocol (T-008) |
| Ảnh sản phẩm, danh mục, chính sách thật | Chủ shop | Dữ liệu demo tổng hợp, đánh dấu rõ |
| Hạ tầng staging/production, tên miền | Chủ dự án | docker-compose cục bộ |

## Ước lượng
Tổng P50 ≈ 38 ngày-kỹ-sư · P85 ≈ 60 (khớp 8–12 tuần với 2–3 người của đặc tả). Không cộng P50 làm ngày hứa.
