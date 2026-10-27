# Kết nối Postgres/Redis và timeout (T-092)

Nguồn sự thật của giá trị: `apps/backend/src/lib/infra/timeouts.ts` (đọc bởi `apps/backend/medusa-config.ts`), biến môi
trường kiểm bằng zod ở `apps/backend/src/lib/env/index.ts`. Kiểm: `pnpm --filter @x-shop/backend test -- timeouts tx-network`.

## 1. Pool Postgres — mỗi tiến trình một pool

Medusa 2.22.1 tạo **một** pool knex cho mỗi tiến trình (`@medusajs/framework` pg-connection-loader); module Medusa và
module tự viết (`__pg_connection__`) dùng chung pool đó. Trần pool = `DB_POOL_MAX` (mặc định 10, khoảng 1–100).

| Thông số | Giá trị | Ở đâu |
|---|---|---|
| `pool.max` | `DB_POOL_MAX` (10) | `databaseDriverOptions.pool.max` |
| `pool.min` | 2 (mặc định Medusa, ≤ `pool.max`) | `databaseDriverOptions.pool.min` |
| Đóng kết nối rảnh | 30 s | `databaseDriverOptions.pool.idleTimeoutMillis` |
| Chờ LẤY kết nối khi pool cạn | 60 s | mặc định knex 3.2.10 (`acquireConnectionTimeout`). Medusa 2.22.1 chỉ chuyển `pool.min/max/idleTimeoutMillis/reapIntervalMillis/createRetryIntervalMillis` → **không cấu hình được**; test khẳng định giá trị thật |
| Mở kết nối (TCP + startup) | 5 s | `databaseDriverOptions.connectionTimeoutMillis` |
| `statement_timeout` | `DB_STATEMENT_TIMEOUT_MS` (30 s) | tham số trên `DATABASE_URL` (Medusa không chuyển khoá này từ driverOptions; pg gửi trong gói startup). URL đã khai thì giữ của URL |
| `idle_in_transaction_session_timeout` | 60 s | `databaseDriverOptions.idle_in_transaction_session_timeout` |

Lưu ý vận hành:

- Postgres không trả lời: mỗi lần mở kết nối bỏ cuộc sau 5 s, nhưng Medusa đặt `propagateCreateError: false` nên request chờ
  lấy kết nối tới **60 s** (timeout lấy kết nối) rồi mới lỗi. `/x/readyz` có hạn riêng 1 s nên bộ cân bằng tải ngắt instance
  sớm hơn.
- `statement_timeout` áp cho cả `medusa db:migrate`/`medusa exec` (cùng `medusa-config.ts`) và tính **từng câu**, kể cả thời
  gian câu đó chờ khoá. Migration có câu dài (tạo index trên bảng lớn) → chạy với giá trị nâng tạm:
  `DB_STATEMENT_TIMEOUT_MS=600000 npx medusa db:migrate`. `catalog:reindex` KHÔNG cần nâng: đo ở §5, câu dài nhất ~70 ms.
- Test tích hợp (`@medusajs/test-utils`) ghi đè `databaseUrl`/`databaseDriverOptions` → cấu hình DB ở trên chỉ kiểm được bằng
  test đơn vị (`timeouts.unit.spec.ts`: server Postgres treo + đọc gói startup) và đo trên Postgres thật (§4).

## 2. Tổng kết nối ≤ `max_connections`

Điều kiện: `Σ (DB_POOL_MAX × số tiến trình) + dự phòng ≤ max_connections − superuser_reserved_connections`.

Postgres dev (`scripts/dev-services.sh`, Postgres 16.15) đo ngày 2026-10-26: `max_connections = 100`,
`superuser_reserved_connections = 3` (`SHOW …`). Postgres managed thường đặt khác theo gói — **đọc lại `SHOW max_connections`
trên môi trường thật trước khi tăng tiến trình hoặc `DB_POOL_MAX`**.

| Tiến trình | Số lượng (mặc định triển khai) | `DB_POOL_MAX` | Kết nối tối đa |
|---|---|---|---|
| Server (`MEDUSA_WORKER_MODE=server`) | 2 | 10 | 20 |
| Worker (`MEDUSA_WORKER_MODE=worker`) | 1 | 10 | 10 |
| Lệnh tạm (`medusa db:migrate`, `medusa exec` — deploy, reindex, drill) | 1 | 10 | 10 |
| Dự phòng thao tác tay (psql, backup `pg_dump`, giám sát) | — | — | 5 |
| **Tổng** | | | **45** |
| Giới hạn dùng được (100 − 3 superuser) | | | **97** |

Còn trống 52 → tăng server lên 4 instance (+20) vẫn trong giới hạn (65). Công thức khi đổi: thêm một instance = thêm
`DB_POOL_MAX` kết nối; nếu vượt → giảm `DB_POOL_MAX` hoặc đặt PgBouncer (transaction pooling) trước Postgres.

Giám sát (ngưỡng 80% giới hạn dùng được, theo DB-PERF-004):

```sql
SELECT sum(numbackends) AS dang_dung,
       current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int AS gioi_han,
       round(100.0 * sum(numbackends) /
         (current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int), 1) AS phan_tram
FROM pg_stat_database;
```

Cảnh báo tự động khi `phan_tram > 80`: **chưa có** — dự án chưa chọn hệ thống giám sát (xem `docs/ops/SLO.md`); khi có, gắn
truy vấn trên vào cảnh báo.

## 3. Redis và HTTP ra ngoài

| Client | Timeout | Ghi chú |
|---|---|---|
| ioredis — cache, caching, locking, kho phiên (express-session), kho bảo mật admin | `connectTimeout` 5 s, `commandTimeout` 5 s | khoá checkout còn hạn riêng `LOCK_CALL_TIMEOUT_MS` 3 s (`lib/checkout/locks.ts`) |
| ioredis — event bus, workflow engine (BullMQ) | `connectTimeout` 5 s | KHÔNG `commandTimeout`: BullMQ dùng lệnh chặn (BZPOPMIN…) và ioredis áp `commandTimeout` cho cả lệnh chặn; Medusa đặt `maxRetriesPerRequest: null` theo yêu cầu BullMQ → khi Redis mất, lệnh xếp hàng tới khi kết nối lại (ngoại lệ có chủ đích, RUNBOOK §3) |
| VNPAY querydr | 10 s (`CHECKOUT_CONFIG.queryTimeoutMs`) | `AbortSignal.timeout` phủ cả đọc thân; quá hạn → `unknown`, không suy ra "chưa trả" |
| GHN | 10 s (`SHIPPING_CONFIG.requestTimeoutMs`) | quá hạn → `GhnError("timeout")`, tra lại theo `client_order_code` |
| Admin UI → backend (`src/admin/lib/api.ts`) | 60 s (`ADMIN_FETCH_TIMEOUT_MS`) | quá hạn → mã `TIMEOUT` (kết quả chưa rõ; thao tác ghi có `Idempotency-Key`) |
| Storefront (server) → backend | 5–10 s `AbortSignal.timeout` (`apps/storefront/src/lib/{catalog/client,cart/medusa,checkout/address}.ts`) | ngoài phạm vi T-092. Fetch phía TRÌNH DUYỆT tới API route của chính storefront (`CartBadge`, `CheckoutForm` wards; `SearchCombobox`/`FilterDrawer` chỉ huỷ theo input) chưa có timeout tường minh |

## 4. Không gọi mạng trong transaction (DB-TX-003)

- `idle_in_transaction_session_timeout` = 60 s (§1): phiên giữ transaction nhàn rỗi bị Postgres huỷ, khoá được nhả.
- Kiểm tĩnh `src/lib/infra/__tests__/tx-network.unit.spec.ts`: dùng type checker phân giải mọi lời gọi trong callback
  `.transaction(...)`/`.transactional(...)` (bắc cầu qua hàm trong repo); lời gọi tới `fetch`, `node:http(s)`, ioredis,
  BullMQ, Locking Module, Event Bus, gateway VNPAY, cổng hoàn tiền, GHN, adapter thông báo, khoá Redis checkout → đỏ. Ca
  fixture chứng minh bộ kiểm bắt được vi phạm trực tiếp lẫn gián tiếp.
- Rà ngày 2026-10-26: 0 vi phạm trong `apps/backend/src` (trừ admin UI). Mẫu đúng đang dùng: đọc dữ liệu vendor/khoá TRƯỚC
  transaction (vd `capturesOf` trước `svc.transaction` ở `workflows/returns/refunds.ts`), tác động phụ qua outbox sau commit.

Đo trên Postgres thật (2026-10-26, Postgres 16.15 cục bộ, qua `ModulesSdkUtils.createPgConnection` như Medusa):
`?statement_timeout=1500` → `SHOW statement_timeout` = `1500ms`, `SHOW idle_in_transaction_session_timeout` = `1min`,
`select pg_sleep(5)` lỗi `57014` sau 1503 ms.

## 5. Job dài dưới `statement_timeout` 30 s (T-140)

`statement_timeout` cắt **một câu lệnh** (không cắt cả giao dịch), và thời gian câu đó **chờ khoá cũng bị tính**.
`idle_in_transaction_session_timeout` (60 s) cắt khoảng nghỉ giữa hai câu trong một giao dịch. `lock_timeout` mặc định 0 (không
giới hạn) — chỉ đặt cục bộ ở chỗ cần. Kiểm trên Postgres 16.15 (2026-10-27, hai kết nối, khoá advisory đang bị giữ):
`SET LOCAL lock_timeout = '1000ms'` rồi `pg_advisory_xact_lock` → lỗi `55P03` sau 1005 ms (lock_timeout áp cả cho khoá
advisory); `SET LOCAL statement_timeout = '800ms'` → lỗi `57014` sau 801 ms; `pg_try_advisory_xact_lock` → `false` ngay.

**Cách đo.** DB riêng dựng bằng `PERF_DB_NAME=xshop_perf_t140 node scripts/ops/perf-dataset.mjs` (10.024 sản phẩm / 50.105
SKU, 200.000 đơn, 195.804 vận đơn, 95.904 dòng ledger) + `ALTER DATABASE xshop_perf_t140 SET log_min_duration_statement = 0`,
`log_lock_waits = on` (chỉ DB đo); đọc log server: thời gian từng câu, từng giao dịch (BEGIN→COMMIT) và khoảng nghỉ dài nhất
giữa hai câu trong giao dịch. Chạy đúng lệnh vận hành `pnpm --filter @x-shop/backend catalog:reindex`, hàm mặc định của job
`x-catalog-index-rebuild` (`src/jobs/catalog-index-rebuild.ts`) qua `medusa exec`, và `SettlementModuleService.importBatch`
hai lần song song (lần 2 bắt đầu sau 200 ms → phải chờ khoá). **Máy:** 4 CPU Intel Xeon @ 2,30 GHz, 15,7 GiB RAM, Node
22.22.0, Medusa 2.22.1, Postgres 16.15 + Redis cục bộ; **máy đang chạy việc khác song song** (loadavg 1 phút 5,0–6,0 trên 4
CPU suốt lúc đo) — số đo là của máy dev quá tải, không phải production.

| Job (lần đo) | Wall | Số câu | Câu dài nhất (không tính chờ khoá) | Giao dịch dài nhất | Nghỉ dài nhất trong giao dịch |
|---|---:|---:|---|---:|---:|
| `catalog:reindex` 50k SKU (2 lần) | 60,5 s · 69,4 s¹ | 2.871 | 60,5 / 68,2 ms `DELETE FROM catalog_variant_index` | 3,18 / 3,30 s (102 câu) | 167 ms |
| Job `x-catalog-index-rebuild` (2 lần) | 58,4 / 51,4 s² | 2.871 | 59,5 / 70,8 ms (cùng câu) | 3,19 / 3,21 s | 163 ms |
| Nhập đối soát GHN COD 5.000 dòng (trần `maxRows`), `period_end` → 10.000 "thiếu", 12.500 chênh lệch (2 lần) | 5,1 / 5,6 s | 5.073 | 63 / 73 ms (tìm vận đơn theo mã, join `order_finance`) | 5,08 / 5,58 s | 509 ms |
| Lần nhập thứ hai cùng nguồn (chờ `pg_advisory_xact_lock`) | 9,0 / 9,3 s | 5.073 | **chờ khoá 4.842 / 5.349 ms trong MỘT câu** | 9,02 / 9,34 s | 289 ms |

¹ lần 2 do `perf-dataset.mjs` đo (gồm khởi động Medusa). ² thời gian trong hàm job.

**Kết luận.**

- Catalog (`catalog:reindex` và job `x-catalog-index-rebuild` — cùng `rebuildCatalogIndex`): không câu nào gần 30 s (dài
  nhất ~70 ms, gấp ~400 lần dư). Đọc nguồn theo lô 500 sản phẩm, ghi `INSERT` theo lô 500 dòng (≤ 45 ms/lô) → chi phí mỗi câu
  không tăng theo catalog; chỉ `DELETE` cả bảng tăng tuyến tính (~70 ms / 50k dòng → 30 s ở cỡ ~20 triệu dòng). Khoảng nghỉ
  ≤ 167 ms ≪ 60 s. **Không đặt `SET LOCAL statement_timeout`.** Hàng rào: `catalog-index-scale.spec.ts` (T-140) đỏ nếu ghi
  rebuild không còn theo lô 500 dòng.
- Nhập đối soát: mọi câu ≤ 73 ms (theo lô ≤ 5.000 dòng; câu tìm vận đơn/“thiếu” tăng theo bảng `shipment` — 73 ms ở 196k).
  **Câu bị cắt sai là câu chờ khoá của lần nhập thứ hai**: thời gian chờ = thời gian còn lại của lần nhập đang giữ khoá (đo
  ~5 s), cộng cả trường hợp người giữ treo (giữ tới 60 s idle-in-transaction). Trước T-140: chờ quá 30 s → `57014` → 500
  `INTERNAL`, Admin treo 30 s. Từ T-140 (`SettlementModuleService.lockImport`): `set_config('lock_timeout',
  SETTLEMENT_CONFIG.importLockWaitMs = 10 s, true)` chỉ quanh câu chờ khoá rồi `SET LOCAL lock_timeout TO DEFAULT` (khoá dòng
  `FOR UPDATE` phía sau giữ hành vi cũ); hết hạn chờ (`55P03`, hoặc `57014` nếu môi trường đặt `statement_timeout` < 10 s) →
  409 `IMPORT_IN_PROGRESS` + `Retry-After: 10`, chưa ghi gì. 10 s ≈ 1,8 lần lần nhập trần đo trên máy quá tải, nhỏ hơn
  hẳn `statement_timeout` 30 s, và chờ + nhập < 60 s timeout của Admin UI. Kiểm: `pnpm --filter @x-shop/backend
  test:integration -- settlement` (giữ khoá quá hạn → 409 sau ~10 s; nhả trước hạn → 201; khoá dòng vận đơn giữ > 10 s vẫn
  chờ → 201) và `pnpm --filter @x-shop/backend test -- settlement.unit`.
- Phương án đã cân nhắc cho lần nhập thứ hai: `pg_try_advisory_xact_lock` (409 ngay) — loại vì phá giao ước đã có: nhập cùng
  chứng từ song song (bấm hai lần) phải ra 201 + 200 bản đã nhập, hai batch khác nhau cùng đơn song song phải tuần tự hoá
  (`settlement.spec.ts` "đồng thời"); nâng `statement_timeout` cho giao dịch — loại vì vẫn treo và vẫn ra 500.

Đo lại: dựng DB như trên, bật `log_min_duration_statement = 0` cho riêng DB đó, chạy lệnh rồi đọc log server (dòng
`xshop@<db>`, `duration:`); xoá DB đo: `PERF_DB_NAME=… node scripts/ops/perf-dataset.mjs --drop`.
