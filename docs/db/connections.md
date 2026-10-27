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
- `statement_timeout` áp cho cả `medusa db:migrate`/`medusa exec` (cùng `medusa-config.ts`). Migration hay script dài (tạo
  index trên bảng lớn, reindex catalog) → chạy với giá trị nâng tạm: `DB_STATEMENT_TIMEOUT_MS=600000 npx medusa db:migrate`.
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
