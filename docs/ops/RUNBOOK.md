# RUNBOOK — x-shop · 0.3 · 2026-10-26

> Đặc tả §13.2. Mục 3, 4 đã có quy trình thật + diễn tập (T-037, `bash scripts/ops/restore-drill.sh`). Mỗi mục: dấu hiệu → kiểm tra → xử lý →
> xác nhận đã ổn. Nguyên tắc: **tiền và tồn đúng quan trọng hơn còn bán được**; mất cơ chế khóa an toàn thì dừng checkout,
> vẫn cho xem catalog.

## 0. Liên lạc, nơi giữ bí mật, trạng thái diễn tập
| Vai trò | Ai | Kênh |
|---|---|---|
| Trực kỹ thuật | [chủ dự án điền — chưa có dữ liệu] | [chủ dự án điền] |
| Kế toán (tiền, hoàn) | [chủ dự án điền — chưa có dữ liệu] | [chủ dự án điền] |
| Quyết định rollback / dừng checkout | [chủ dự án điền] | [chủ dự án điền] |
| Liên hệ VNPAY / GHN | theo hợp đồng merchant | cổng hỗ trợ trong hợp đồng (chưa có hợp đồng — chủ dự án) |

**Bí mật nằm ở đâu (không ghi giá trị):** biến môi trường của tiến trình server + worker backend và storefront; danh sách và ý nghĩa ở
`docs/ops/ENV.md`. Production lấy từ kho bí mật của nền tảng triển khai (chưa chọn — chủ dự án chọn, xem §8.1). Không có bí mật trong
repo (quét `gitleaks`, `.github/workflows/secret-scan.yml`). Máy dev: `.env` cục bộ đã gitignore.

**Lệnh chẩn đoán chung** (chạy trên máy có quyền với DB/Redis; không in bí mật):

```bash
curl -fsS "$MEDUSA_BACKEND_URL/x/health"   # {"status":"ok"} — kiểm sống, không chạm DB, không trả phiên bản
curl -sS "$MEDUSA_BACKEND_URL/x/readyz"    # 200 {"status":"ready"} | 503 NOT_READY — DB+Redis trả lời trong 1 s (chi tiết ở log server)
curl -fsS "$MEDUSA_BACKEND_URL/health"     # health native của Medusa
psql "$DATABASE_URL" -c "select state, count(*) from outbox_event group by 1"
psql "$DATABASE_URL" -c "select kind, state, count(*) from ops_exception where state <> 'resolved' group by 1,2"
redis-cli -u "$REDIS_URL" ping
```

Phản hồi lỗi của backend (problem+json) có `trace_id`; log server ghi cùng mã (`[http|checkout|returns|settlement|shipping] <METHOD> <path> trace_id=<mã>: <stack>`) — khách/nhân viên báo mã đó → tìm đúng dòng log. Tiến trình chết vì lỗi ngoài request để lại một dòng JSON `level: fatal` (`exception.type/message/stacktrace`) trên stderr và thoát mã 1.

**Trạng thái diễn tập** (`last_drilled` = ngày diễn tập thật gần nhất; hạn ≤ 6 tháng, quá hạn = diễn tập lại):

| Mục | last_drilled | Ghi chú |
|---|---|---|
| Khôi phục backup (§4) | 2026-10-25 | `bash scripts/ops/restore-drill.sh`, DB cỡ nhỏ, máy dev |
| Mất Redis (§3) | 2026-10-25 | cùng script, bước 5 |
| Deploy (§8) | chưa diễn tập | chưa có cơ chế deploy/hạ tầng |
| Rollback ứng dụng (§5) | chưa diễn tập | cần cơ chế deploy; cần trước khi lên production lần đầu (WF-REL-004) |
| Xoay secret (§9) | chưa diễn tập | cần môi trường staging |
| Lộ bí mật (§10) | chưa diễn tập | tập bàn giấy khi có staging |
| Redrive outbox (§12) | chưa diễn tập | lệnh SQL chưa chạy trên DB thật |

## 1. Cổng thanh toán lỗi (VNPAY không phản hồi, IPN không về)
- Dấu hiệu: `payment_attempt` ở `pending`/`unknown` tăng; cảnh báo "đã nhận dấu hiệu thanh toán nhưng chưa xử lý > 5 phút".
- Kiểm tra: log `webhook_inbox` (verified, result); job `expire-holds` có chạy; gọi `querydr` thủ công cho vài `txn_ref`.
- Xử lý: KHÔNG hủy hàng loạt đơn `unknown`. Tạm ẩn phương thức VNPAY (cờ cấu hình) để khách chọn COD; giữ endpoint IPN chạy để nhận thông báo đến muộn; đối chiếu `querydr` theo lô khi cổng hồi phục.
- Xác nhận: không còn attempt `unknown` quá hạn chưa có owner trong `ops_exception`.

## 2. Hãng vận chuyển lỗi (GHN)
- Tạo vận đơn timeout → hệ thống tra theo `client_order_code` trước khi tạo lại (không tạo tay vận đơn mới khi chưa tra).
- Callback ngừng: chạy job đồng bộ trạng thái bằng API; không tự đánh dấu "đã giao".

## 3. Redis / worker lỗi

Trong Redis chỉ có thứ **tạo lại được**: khóa phân tán (Locking Module), hàng đợi event bus, trạng thái workflow engine, cache.
Nguồn sự thật là Postgres: `checkout_attempt` (lease), `outbox_event` (`pending`/`failed` + `next_attempt_at`), `payment_attempt`,
`order_finance`, `ops_exception`, `outbound_message` (UNIQUE `message_key`).

### 3.1 Dấu hiệu
- Log Medusa `ECONNREFUSED`/`MaxRetriesPerRequestError` tới Redis; submit checkout lỗi khi lấy khóa; job định kỳ ngừng chạy;
  `outbox_event` `pending` quá hạn tăng; cảnh báo "task quan trọng chờ > 60 giây".

### 3.2 Trong lúc Redis mất
1. **Checkout tự dừng, catalog vẫn chạy** (T-042, đặc tả §13.2) — không cần thao tác tay:
   - `POST /store/x/checkout/submit` khi Locking Module không dùng được (ioredis từ chối lệnh — `Connection is closed.`,
     `MaxRetriesPerRequestError`… — hoặc một lệnh khóa không trả lời trong 3 giây, `LOCK_CALL_TIMEOUT_MS`) → **503**
     `application/problem+json` `code: LOCK_UNAVAILABLE`, `detail: "Hệ thống tạm thời không nhận đơn, vui lòng thử lại sau ít
     phút"`, `action: retry_same_key`, header `Retry-After: 60`. Không lời gọi nào treo theo hàng đợi ioredis (~10 s).
   - Dừng TRƯỚC khi đọc tồn/giữ hàng: không tạo đơn, không reservation, không bán bằng tồn đọc ngoài khóa; không có khóa
     in-memory thay thế. Khóa đang bận khi Redis khỏe vẫn là **409** `BUSY_RETRY` (`Retry-After: 1`) — 503 chỉ cho hạ tầng khóa.
   - Attempt kết thúc rõ ràng `failed/LOCK_UNAVAILABLE` (lỗi tạm): khách gửi lại **cùng Idempotency-Key** sau khi Redis về →
     attempt được mở lại và đặt đúng một đơn (nhiều request đồng thời cùng key vẫn một đơn).
   - Redis mất giữa workflow: bù trừ chạy hết → như trên. Nếu bù trừ không xong (vd reservation cần khóa native để xoá) →
     attempt giữ `preparing` (không mở lại cho retry, gửi lại cùng key nhận 202), job `x-reconcile-attempts` dọn đơn +
     reservation (tìm cả theo mô tả `checkout <attempt_id>`) sau lease khi Redis về → `compensated` (gửi lại: 409
     `ATTEMPT_ABORTED`, đặt bằng key mới). Khóa không nhả được không còn được gia hạn — tự hết hạn sau `lockTtlSeconds` (30 s).
   - Log server: `[checkout] hạ tầng khóa không dùng được (<scope>)…` (error) kèm nguyên nhân gốc; khách không thấy chi tiết hạ tầng.
   - Catalog (`/store/x/products`, `/store/products/:id`) vẫn 200.
   KHÔNG bật lại checkout bằng khóa in-memory (bỏ `REDIS_URL`) khi chạy > 1 instance: hai tiến trình giữ "cùng một khóa" → bán
   vượt tồn. Kiểm: `pnpm --filter @x-shop/backend test:integration -- checkout-lock-outage`.
2. Giữ endpoint IPN VNPAY/callback GHN chạy: chúng ghi `webhook_inbox`/`shipment_event` vào Postgres trước khi xử lý; phần nào
   không xử lý xong do thiếu khóa sẽ được provider gửi lại hoặc job query bù.
3. Khôi phục Redis (managed: failover/instance mới; tự host: khởi động lại). Redis **trống** là chấp nhận được — không cần khôi phục
   dữ liệu Redis.

### 3.3 Sau khi Redis trở lại — tạo lại công việc
1. Khởi động lại server + worker (`MEDUSA_WORKER_MODE=worker`) để kết nối lại event bus/workflow engine/locking.
2. Job định kỳ tự nhặt việc từ Postgres trong ≤ 1 phút — không cần thao tác tay:
   - `x-reconcile-attempts` (mỗi phút): attempt `preparing` quá `lease_until` → nhận quyền bù trừ dưới khóa giỏ → nhả reservation,
     hủy đơn native, mã giảm → `released`, `order_finance` → `cancelled`.
   - `x-outbox-dispatch` (10 s): `outbox_event` `pending`/`failed` đến hạn, nhận bằng `FOR UPDATE SKIP LOCKED` + lease 60 s →
     nhiều worker cùng chạy không xử lý trùng.
   - `x-expire-holds`: đơn `awaiting_payment` quá hạn → querydr trước khi hủy (không hủy mù).
3. Xem việc đang tồn (cùng điều kiện với job):
   ```sql
   SELECT 'reconcile-attempts', id FROM checkout_attempt
    WHERE ((state = 'preparing' AND lease_until < now()) OR (state = 'compensated' AND error_code = 'COMPENSATING'))
      AND deleted_at IS NULL
   UNION ALL
   SELECT 'outbox-dispatch', event_key FROM outbox_event
    WHERE state IN ('pending', 'failed') AND next_attempt_at <= now() AND deleted_at IS NULL;
   ```
4. Dedupe tác động ngoài: thông báo theo `outbound_message.message_key` (`notify:<event_key>:<kênh>` — dòng `sent` không gửi lại);
   thanh toán theo `txn_ref` + UNIQUE ledger `(provider, provider_txn_id, kind)`; vận đơn theo `client_order_code` (tra trước khi tạo).
5. Phần cần người: `ops_exception` `state <> 'resolved'` (vd `payment_unknown`, `checkout_stuck`, `outbox_dead`,
   `notification_failed`) — giao owner theo §0.

### 3.4 Xác nhận đã ổn
Truy vấn ở 3.3.3 trả rỗng (hoặc chỉ còn việc chưa đến hạn); submit checkout thử thành công; không có `outbound_message` trùng
`message_key` (UNIQUE bảo đảm); `ops_exception` mới đều có owner.

### 3.5 Diễn tập (T-037) — kết quả và giới hạn
- `bash scripts/ops/restore-drill.sh` bước 5: trên DB vừa khôi phục, đặt khóa/công việc giả + hàng đợi Medusa thật vào Redis DB index
  riêng (`XS_DRILL_REDIS_DB`, mặc định 15), **xoá toàn bộ DB index đó**, rồi `medusa exec integration-tests/ops/redis-loss-drill.ts`
  gọi đúng hàm của job `reconcileAttempts` + `dispatchOutbox` — **hai worker đồng thời**, rồi chạy lại lần nữa.
- Kết quả 2026-10-25 (2 lần liên tiếp PASS): việc tạo lại = đúng `chk_drill_stale` + 2 `outbox_event`; attempt bù trừ đúng 1 lần
  (`compensated/LEASE_EXPIRED`, mã `released`); mỗi sự kiện outbox xử lý đúng 1 lần; sự kiện có thông báo **đã gửi trước sự cố**
  không gửi lại (0 lần), sự kiện chưa gửi gửi đúng 1 lần; lượt chạy lại rỗng; phần cần người được liệt kê (`payment_unknown`).
- Kiểm đột biến: đổi thông báo đã gửi thành `failed` → bước 5 FAIL (gửi lặp bị phát hiện).
- **Giới hạn**: không mô phỏng Redis chết *giữa* một workflow Medusa đang chạy (dừng tiến trình giữa bước) mà mô phỏng trạng thái
  bền vững để lại sau đó (attempt `preparing` quá lease, outbox chưa đánh dấu dù đã gửi); không chạy cron thật (gọi thẳng hàm job);
  không có đơn native/reservation thật trong dữ liệu mẫu (nhánh nhả reservation có test tích hợp `checkout-expiry.spec.ts`);
  phản hồi của submit khi Redis đang mất được kiểm riêng ở `checkout-lock-outage.spec.ts` (3.2.1; giả lập trên client ioredis
  của provider locking-redis — event bus/cache/workflow engine vẫn chạy, nên đây không phải diễn tập mất cả Redis).

## 4. Database outage / khôi phục

### 4.1 Sao lưu
- **Production (chờ chủ dự án chọn hạ tầng — xem 4.5):** PITR bằng WAL archiving cho RPO ≤ 15 phút + base backup hằng ngày,
  mã hoá, lưu ngoài máy chủ DB, retention đề xuất 7–30 ngày PITR + 12 bản tháng.
- **Logic (bổ sung, trước migration lớn, và cho diễn tập):** `scripts/ops/backup.sh <đường-dẫn.dump>` — `pg_dump -Fc`, ghi
  `<file>.meta` gồm `snapshot_mark_utc` (giờ DB lấy NGAY TRƯỚC snapshot của pg_dump → giao dịch sau mốc luôn là tập cha của phần
  mất), sha256, kích thước, phiên bản. Mã hoá: `XS_BACKUP_GPG_RECIPIENT=<key>` (khoá công khai; khoá riêng giữ ngoài máy sao lưu)
  hoặc `XS_BACKUP_PASSPHRASE_FILE=<file 600>` (AES256). Không ghi đè file có sẵn; không in URL/mật khẩu.

### 4.2 Khôi phục (từng bước, có lệnh)
1. Quyết định khôi phục (người trực + chủ dự án). **Dừng checkout** (như 3.2.1); giữ catalog đọc được nếu DB cũ còn đọc được.
2. Dựng DB MỚI, không ghi đè DB cũ (giữ làm bằng chứng/đường lùi):
   - PITR: instance mới với `recovery_target_time = <thời điểm trước sự cố>` → mốc = thời điểm đó.
   - Bản logic: `DATABASE_URL=<server đích> scripts/ops/restore.sh <file.dump[.gpg]> <db_mới>` — kiểm sha256 với `.meta`, giải mã
     ra file tạm 600, `pg_restore --exit-on-error -j 4`, lỗi giữa chừng tự xoá DB dở; mốc = `snapshot_mark_utc` trong `.meta`.
3. Migration tới phiên bản ứng dụng đang chạy: `cd apps/backend && DATABASE_URL=<db_mới> npx medusa db:migrate`. Bản vá chạy
   lại lệnh này phải không đổi `mikro_orm_migrations`/`link_module_migrations`/`script_migrations` (diễn tập kiểm điều này).
4. Trỏ ứng dụng sang DB mới (biến `DATABASE_URL` của server + worker), khởi động, **chưa mở checkout**.
5. **Đối chiếu giao dịch sau mốc** (đặc tả §13.2 — giao dịch ngoài hệ thống có thể đã diễn ra):
   1. Xuất từ cổng merchant VNPAY danh sách giao dịch trong cửa sổ `[mốc − 5 phút, hiện tại]` → file `txn_ref` (mỗi dòng một mã);
      xuất từ GHN vận đơn trong cùng cửa sổ → file `client_order_code`.
   2. `DATABASE_URL=<db_mới> scripts/ops/post-restore-reconcile.sh --since <mốc> --payment-refs vnpay.txt --courier-codes ghn.txt`
      → in `QUERYDR|COURIER <mã> <lý do>` (chỉ đọc DB):
      - `QUERYDR … open_in_db` / `provider_activity_after_mark` → chạy querydr qua hệ thống (đường IPN/query idempotent ghi ledger,
        chuyển đơn); KHÔNG sửa tay số dư/trạng thái.
      - `QUERYDR … missing_in_db` → tiền đã đi nhưng đơn mất khỏi DB: mở `ops_exception` thủ công (kế toán + CSKH), liên hệ khách theo
        thông tin trên cổng; mặc định hoàn tiền nếu không tái lập được đơn — không tự tạo đơn/giao hàng khi chưa xác nhận lại với khách.
      - `COURIER … missing_in_db` → vận đơn có ở hãng, không có trong DB: tra API hãng theo mã, nếu đơn tồn tại thì tạo lại bản ghi
        `shipment` (giữ `client_order_code`), nếu không thì hủy vận đơn ở hãng; `open_in_db` → tra theo mã trước khi tạo lại.
   3. Outbox/thông báo của giao dịch sau mốc mất cùng DB: sinh lại qua đường IPN/query ở bước trên (message key cũ → không gửi trùng
      với thư đã gửi trước sự cố nếu dòng `outbound_message` còn; nếu đã mất cùng DB thì khách có thể nhận lại thư — chấp nhận).
6. Kiểm như 3.4, mở lại checkout, ghi biên bản (mốc, RTO thực, số mục đối chiếu, số ngoại lệ).

### 4.3 Xác nhận đã ổn
`post-restore-reconcile.sh` chạy lại chỉ còn mục đã có `ops_exception` có owner; không còn `payment_attempt` `created/pending/unknown`
quá hạn không có ngoại lệ; tổng ledger khớp báo cáo cổng cho cửa sổ đối chiếu; checkout thử thành công.

### 4.4 Diễn tập khôi phục (T-037) — kết quả
`bash scripts/ops/restore-drill.sh` (máy dev, PostgreSQL 16.15 cục bộ, 2026-10-25; CI có Postgres/Redis chạy cùng lệnh). Dữ liệu tổng
hợp ở `scripts/ops/drill/seed-*.sql` (không dữ liệu thật). Hai lần liên tiếp PASS:

| Bước | Kết quả |
|---|---|
| 1 DB nguồn | migration Medusa đủ (197 module + 22 link + 6 script); attempt `preparing` quá lease, payment `pending`/`unknown`, outbox `pending`, ledger |
| 2 Sao lưu | `pg_dump -Fc` mã hoá gpg AES256 (passphrase file tạm), ≈ 78 KB; sau mốc ghi: IPN muộn cho `PA_DRILL_PENDING`, 2 đơn VNPAY mới, 1 vận đơn mới |
| 3 Khôi phục | **RTO đo được 14 s và 16 s** (restore + kiểm toàn vẹn + migrate; ngưỡng 7200 s); 175/175 bảng trùng số dòng + md5 nội dung lúc snapshot; migrate lại không đổi bảng migration |
| 4 Đối chiếu | đúng 4 `txn_ref` cần querydr (2 `missing_in_db`, 1 `provider_activity_after_mark`, 1 `open_in_db`) + 2 vận đơn; khớp kỳ vọng VÀ khớp diff dòng nguồn↔đích (độc lập với mốc giờ) |
| 5 Mất Redis | xem 3.5 |
| 6 RPO | **CHỜ NGƯỜI** — xem 4.5 |
| 7 Dọn dẹp | DB `xs_drill_*_<pid>` đã xoá, Redis DB index diễn tập rỗng |

Kiểm đột biến: `XS_RTO_MAX_SECONDS=1` → bước 3 FAIL; biên cửa sổ quá rộng (`XS_RECONCILE_MARGIN_SECONDS=99999`) → bước 4 FAIL (thừa
mục); Redis DB index không rỗng → từ chối chạy, không xoá khoá của người khác. `restore.sh`: sai passphrase, file bị sửa (sha256),
file hỏng → dừng, không để lại DB dở.

**Giới hạn — không suy ra RTO production từ số này:** DB diễn tập ≈ 78 KB; thời gian `pg_restore` tăng gần tuyến tính theo dung lượng
+ index. Trước ra mắt đo lại với bộ dữ liệu cỡ thật (T-036: 10.000 sản phẩm / 50.000 SKU + lịch sử đơn ước tính) trên cấu hình máy
production, và tính cả thời gian dựng instance PITR của nhà cung cấp. Đối chiếu dùng "xuất từ provider" mô phỏng bằng DB nguồn — định
dạng file xuất thật của VNPAY/GHN cần chuyển về một mã mỗi dòng (cột đầu CSV được chấp nhận).

### 4.5 RPO ≤ 15 phút — việc chờ người (chủ dự án)
Diễn tập cục bộ chứng minh **quy trình restore + đối chiếu**, KHÔNG chứng minh PITR production. `pg_dump` hằng ngày chỉ cho RPO ≈ 24 giờ.
Chủ dự án chọn một (cần tài khoản/hạ tầng thật):
- (a) Postgres managed có PITR (retention ≥ 7 ngày) — ít vận hành nhất; RPO thường vài phút theo nhà cung cấp (chưa xác minh từng dịch vụ).
- (b) Tự host: `archive_mode = on`, `archive_command`/pgBackRest/WAL-G đẩy WAL lên kho object mã hoá ngoài máy, `archive_timeout ≤ 300 s`,
  base backup hằng ngày, theo dõi tuổi WAL lưu trữ (cảnh báo > 10 phút).
Sau khi chọn: diễn tập PITR thật trên staging (khôi phục tới `recovery_target_time`, rồi 4.2 bước 3–6), ghi RPO/RTO đo được vào bảng 4.4.

## 5. Triển khai lỗi / rollback
last_drilled: chưa diễn tập (chưa có cơ chế deploy — §8.1).

- Nguyên tắc: rollback ứng dụng không rollback database phá hủy (migration expand/contract). Giữ endpoint IPN/callback chạy ở bản
  rollback; đối soát giao dịch đang dở sau rollback. Không cưỡng ép reload storefront khi khách đang thanh toán (service worker có
  version, cập nhật ở lần điều hướng sau).
- **Bản trước là gì:** artefact build của lần deploy liền trước, định danh bằng commit SHA/tag git. Mỗi lần deploy phải ghi SHA đang
  chạy và SHA ngay trước ở biên bản deploy. Hiện chưa có hệ thống ghi — việc của cơ chế deploy (§8.1).
- **Lệnh lùi ứng dụng (khi đã có cơ chế deploy):** triển khai lại artefact của SHA trước (đổi tag image / chạy lại pipeline với ref cũ):

  ```bash
  git checkout <sha_truoc> && pnpm install --frozen-lockfile && pnpm build   # dựng lại đúng bản trước
  ```

  rồi khởi động lại server + worker backend và storefront như §8.2.

- **Migration đi kèm:** mọi migration phải tương thích ngược với bản trước (thêm cột/bảng trước, bỏ sau một phát hành). Nếu bản mới có
  migration chưa tương thích ngược, KHÔNG lùi ứng dụng khi chưa kiểm: chỉ lùi migration khi chưa có dữ liệu mới ghi vào cấu trúc mới,
  bằng `cd apps/backend && npx medusa db:rollback --modules <module>` (hoàn lại lô migration cuối của module; `down()` giữ dữ liệu — xem ghi
  chú trong từng file ở `apps/backend/src/modules/*/migrations/`). Ngược lại → sửa tiến (bản vá) thay vì lùi. Không sửa migration đã áp.
- **Ngưỡng quyết định lùi (đề xuất, chủ dự án duyệt — chưa có hạ tầng đo tự động):** trong 30 phút sau deploy, lùi nếu một trong:
  smoke §8.3 đỏ · tỷ lệ 5xx của `/store/x/*` > 2% trong 5 phút liên tiếp · p95 `POST /store/x/checkout/submit` vượt 2× số đo ở
  `docs/ops/perf/` trong 10 phút · có đơn đã đặt nhưng thiếu `order_finance`/`payment_attempt` (đối chiếu truy vấn §3.3.3). Người quyết
  lùi: vai trò "Quyết định rollback" ở §0 (không tự động).
- Sau rollback: đối chiếu như §4.3 và kiểm `outbox_event` theo §12.

## 6. Ảnh lỗi / CDN
- Ảnh hỏng: storefront vẫn hiển thị alt + khung tỷ lệ cố định (không CLS); thay ảnh tạo URL mới (hash), không ghi đè URL cũ.
- Header file tĩnh (D-024): Medusa phục vụ `/static` bằng `express.static` trước middleware dự án nên backend không gắn
  được `X-Content-Type-Options: nosniff` cho đường này. Checklist triển khai: reverse proxy/CDN đặt `nosniff` cho
  `/static/*` (và mọi file ảnh); production nên tắt `/static`, ảnh qua file module S3-compatible + CDN. Kiểm sau deploy:
  `curl -sI https://<backend>/static/<file> | grep -i x-content-type-options`.

## 7. Tiền đến sau khi hủy / thu dư
- `ops_exception late_payment|overpayment`: kế toán xác minh trên cổng → tạo refund (một refund, retry cùng id) → ghi chú khách. Không phục hồi đơn, không giao thay thế khi chưa có xác nhận mới của khách.

## 8. Deploy

last_drilled: chưa diễn tập. **Hiện trạng thật:** repo chưa có Dockerfile, workflow deploy hay IaC; hạ tầng production chưa được chọn (chủ
dự án — cần tài khoản/khoá thật). Phần dưới là các bước đã có lệnh thật trong repo, KHÔNG phải quy trình đã chạy.

### 8.1 Cơ chế deploy — việc chờ người

Chủ dự án chọn hạ tầng (xem cả §4.5). Khi chọn xong, bổ sung vào mục này: đích deploy, lệnh/pipeline, kho bí mật, nơi ghi SHA đang chạy;
rồi diễn tập deploy + rollback (§5) trên staging và ghi `last_drilled`.

### 8.2 Các bước (lệnh thật, thứ tự bắt buộc)

```bash
pnpm install --frozen-lockfile
pnpm build   # domain → medusa build (backend) và next build (storefront)
# 1) Migration TRƯỚC khi chạy bản mới (một lần, từ một máy/job duy nhất; bản trước phải chạy được với schema mới):
cd apps/backend && npx medusa db:migrate
# 2) Backend: hai tiến trình cùng mã, khác chế độ (mỗi tiến trình có đủ biến ở docs/ops/ENV.md)
#    Script `start` bind 127.0.0.1 mặc định (BASE-SEC-010): sau LB / trong container PHẢI đặt HOST=0.0.0.0 cho tiến trình
#    server (không publish cổng DB/Redis); thiếu thì LB không tới được backend. Xem cấu hình hiệu lực (đã che): pnpm --filter @x-shop/backend config:print
MEDUSA_WORKER_MODE=server pnpm --filter @x-shop/backend start   # nhận HTTP (store, admin, IPN, callback GHN)
MEDUSA_WORKER_MODE=worker pnpm --filter @x-shop/backend start   # chạy job định kỳ (outbox, reconcile, expire-holds…)
# 3) Storefront (script `start` cũng bind 127.0.0.1 mặc định: sau LB/container đặt HOST=0.0.0.0)
pnpm --filter @x-shop/storefront start
```

Production thiếu/sai biến → backend thoát mã 1 và in TÊN biến (không in giá trị): đọc log khởi động trước khi chuyển lưu lượng. Chạy ≥ 2
instance server thì `REDIS_URL` bắt buộc (§3.2.1). Không deploy khi đang có sự cố thanh toán (§1).

### 8.2a Reverse proxy cho luồng mời admin qua dashboard (T-138, D-075)

Link mời admin mở dashboard ở `/app` với `invite_token` trong query; trang đăng ký của dashboard gọi API cùng origin. Reverse proxy phải:
- giữ nguyên header `Host` (không viết lại) — kiểm tra origin/URL mời dựa vào đó;
- phục vụ dashboard (`/app`) CÙNG origin với backend (cùng scheme + host + cổng);
- không đặt `Referrer-Policy` làm mất query cho đường `/app` (`no-referrer`, `origin` bị cấm; giữ mặc định trình duyệt hoặc `same-origin`/`strict-origin-when-cross-origin`);
- nếu buộc phải khác origin: làm trang mời riêng, tự gửi `invite_token` tới backend (không dựa vào query/Referer của dashboard).

### 8.3 Kiểm sau deploy (smoke) và theo dõi

- Tay (chưa có job tự động — WF-REL-007 còn mở): `curl -fsS "$MEDUSA_BACKEND_URL/x/health"`; mở trang chủ và một trang sản phẩm; tạo giỏ và gọi
  báo giá; log khởi động không có lỗi biến môi trường. "Phiên bản trả về khớp tag": **chưa có** — `/x/health` cố ý không lộ phiên bản.
- Kịch bản có sẵn, chạy tay trên môi trường tải riêng: `pnpm load:smoke` (T-036) — không chạy lên production.
- Cửa sổ theo dõi 30 phút theo ngưỡng §5; chưa có dashboard/cảnh báo thật cho tới khi chọn hạ tầng.

## 9. Xoay secret

last_drilled: chưa diễn tập. Nguyên tắc: tạo giá trị mới ngẫu nhiên (`openssl rand -base64 48`), đặt vào kho bí mật, khởi động lại server +
worker (và storefront nếu biến của nó đổi), kiểm hiệu ứng, rồi thu hồi giá trị cũ. Không dán giá trị vào lệnh/log/ticket. Nhịp định kỳ đề
xuất: 12 tháng cho khoá ký, và NGAY khi nghi lộ (§10). Hiệu ứng khi đổi (theo mã):

| Biến | Hiệu ứng khi đổi | Thủ tục |
|---|---|---|
| `JWT_SECRET`, `COOKIE_SECRET` | phiên admin hiện có hết hiệu lực — đăng nhập lại | đổi → restart server+worker; hai biến phải khác nhau |
| `ORDER_LOOKUP_SECRET` | mọi liên kết tra cứu và phiên xem đơn của khách đang có mất hiệu lực (khách tra cứu lại) | đổi → restart; không ảnh hưởng đơn/dữ liệu |
| `AUTH_MFA_ENCRYPTION_KEY` | TOTP đã đăng ký không giải mã được — mọi admin đăng ký lại TOTP (`docs/ops/ENV.md`). Lệnh re-encrypt giữ nguyên TOTP: không có trong repo (Medusa có hay không: chưa xác minh) | đặt khoá mới → từng admin đăng ký lại TOTP; trong lúc đó quyền nhạy cảm (hoàn tiền, quản lý user…) không dùng được |
| `VNPAY_HASH_SECRET` | chữ ký IPN/return/querydr đổi theo khoá cổng; IPN ký bằng khoá mới tới TRƯỚC khi env đổi bị từ chối chữ ký | **Thứ tự không hở** (backend ký bằng `VNPAY_HASH_SECRET` = current, xác minh cả current lẫn `VNPAY_HASH_SECRET_PREVIOUS`, T-099): (1) `VNPAY_HASH_SECRET`=khoá cũ, `VNPAY_HASH_SECRET_PREVIOUS`=khoá MỚI → restart (đã nhận được chữ ký khoá mới, vẫn ký bằng khoá cũ); (2) đổi khoá ở cổng merchant VNPAY; (3) `VNPAY_HASH_SECRET`=khoá mới, `VNPAY_HASH_SECRET_PREVIOUS`=khoá cũ → restart (ký bằng khoá mới, IPN/querydr còn ký khoá cũ vẫn qua); (4) theo dõi log `vnpay_secret_previous_used` (cảnh báo mỗi lần xác minh bằng khoá trước, không chứa khoá/chữ ký; T-139) về 0 liên tục ≥ 24 giờ (chính sách gửi lại IPN của VNPAY: chưa xác minh) rồi bỏ `VNPAY_HASH_SECRET_PREVIOUS`, restart. Lưu ý: ở bước 1 log này xuất hiện khi VNPAY đã ký khoá mới; chỉ dùng làm tín hiệu thu hồi sau bước 3. Hiện log chỉ ghi ở IPN (return/querydr chưa có). Querydr bù cho `payment_attempt` mở, xem `ops_exception` `webhook_rejected` (§1). VNPAY có cho hai khoá song song phía cổng không: (chưa xác minh) |
| `GHN_TOKEN` (+ `GHN_SHOP_ID` nếu đổi shop) | gọi GHN thất bại tới khi khớp | tạo token mới ở GHN → đổi env → restart worker+server; vận đơn timeout xử lý như §2; callback GHN không chữ ký nên không bị ảnh hưởng |
| `CATALOG_REVALIDATE_SECRET` (backend + storefront, T-142) | webhook vô hiệu hoá cache catalog bị 401 trong lúc hai phía lệch khoá → outbox `dead` + `outbox_dead`; giá/tồn trên storefront tươi lại theo TTL 60 giây | đặt khoá mới ở storefront → restart storefront → đặt ở backend → restart server+worker; ngoại lệ `outbox_dead` loại `catalog.revalidate` trong khoảng lệch: đóng, không redrive (dữ liệu đã tươi theo TTL) |
| Mật khẩu trong `DATABASE_URL`, `REDIS_URL` | kết nối mới thất bại tới khi restart | tạo vai trò/mật khẩu mới → cập nhật env → restart → thu hồi cái cũ |
| Khoá email/SMS provider | thông báo không gửi (rơi vào `outbox_event` `failed`, thử lại — §12) | thủ tục theo nhà cung cấp thật (xem `docs/privacy/processors.md`) |

## 10. Lộ bí mật

last_drilled: chưa diễn tập. Sự cố bảo mật = SEV1: bảo toàn bằng chứng (chép log liên quan sang nơi chỉ-đọc TRƯỚC khi xoay), thu hồi/xoay,
rà log trong khoảng lộ, ghi sự cố, đánh giá nghĩa vụ thông báo (Luật 91/2025/QH15 — chưa xác minh văn bản gốc; quy trình đầy đủ ở
`docs/ops/runbooks/data-breach.md`). Xoá commit KHÔNG đủ: coi mọi khoá từng nằm trong lịch sử git là đã lộ.

| Khoá | Thu hồi / xoay ngay | Rà log trong khoảng lộ |
|---|---|---|
| `VNPAY_HASH_SECRET` | đổi ở cổng merchant VNPAY (liên hệ VNPAY nếu nghi bị dùng), đặt khoá mới vào env, restart (§9). Kẻ có khoá giả được IPN "đã thanh toán" | `webhook_inbox` (`verified`, `result`) và `payment_ledger` trong khoảng lộ: mọi `capture` không có giao dịch ở cổng merchant → mở `ops_exception`, giữ đơn, chạy querydr; hoàn tiền nếu đã giao nhầm |
| `GHN_TOKEN` | vô hiệu hoá token ở GHN, tạo token mới, đổi env, restart | vận đơn lạ ở cổng GHN so với `shipment`; `shipment_event` bất thường |
| `JWT_SECRET`, `COOKIE_SECRET` | đổi cả hai, restart: toàn bộ phiên admin bị huỷ | `audit_log` (bất biến — trigger chặn sửa/xoá) lọc theo `actor_id`/`action` trong khoảng lộ; kiểm tài khoản admin mới và thay đổi quyền |
| `AUTH_MFA_ENCRYPTION_KEY` | đổi khoá (mọi TOTP đăng ký lại, §9); coi bí mật TOTP đã lộ nếu lộ cả DB | `audit_log` đăng nhập/MFA bất thường |
| `ORDER_LOOKUP_SECRET` | đổi, restart: mọi liên kết/phiên xem đơn mất hiệu lực | log truy cập `/store/x/orders/*` trong khoảng lộ |
| `CATALOG_REVALIDATE_SECRET` | xoay như §9. Kẻ có khoá chỉ ép storefront nạp lại cache catalog (tải thêm lên backend, không đổi dữ liệu) | log truy cập `POST /api/revalidate` của storefront (tần suất bất thường) |
| `DATABASE_URL` / `REDIS_URL` | đổi mật khẩu, đóng cổng ra ngoài, restart | log truy cập DB của nhà cung cấp hạ tầng; `audit_log` |
| Khoá email/SMS provider | thu hồi ở nhà cung cấp, tạo khoá mới | lịch sử gửi ở nhà cung cấp so với `outbound_message` |

Sau xử lý: ghi post-mortem vào `docs/ops/incidents/` (sổ sự cố; quy trình ở `docs/ops/INCIDENT-RESPONSE.md`) — nguyên nhân gốc, khoảng lộ, khoá đã xoay, dữ liệu bị chạm, hàng rào mới
(vd quét bí mật bổ sung). Đầu mối pháp lý: [chủ dự án điền].

## 11. Dữ liệu staging / preview

Chính sách: staging, preview và máy dev CHỈ dùng dữ liệu tổng hợp. **Cấm** copy, dump hoặc khôi phục dữ liệu production (PII khách, đơn, vận
đơn, log) vào staging/preview/dev — kể cả "tạm thời để tái hiện lỗi" (Luật 91/2025/QH15 — chưa xác minh điều khoản). Nguồn dữ liệu cho phép:
`apps/backend/src/scripts/seed*.ts`, `scripts/ops/drill/seed-*.sql`, `scripts/load/dataset.mjs` (đều tổng hợp). Tái hiện lỗi từ production:
dựng ca bằng dữ liệu tổng hợp cùng hình dạng. Diễn tập khôi phục (§4) dùng seed tổng hợp, không dùng dump production. Hiện CHƯA có môi trường
staging, script ẩn danh hoá hay quét PII mẫu.

## 12. Outbox: sự kiện `dead` — kiểm tra và redrive

last_drilled: chưa diễn tập (lệnh SQL chưa chạy trên DB thật).

Mô hình thật (`apps/backend/src/lib/checkout/jobs.ts` `dispatchOutbox`, `apps/backend/src/lib/outbox/policy.ts` `OUTBOX_POLICY`): job
`x-outbox-dispatch` (10 s) xử lý `outbox_event` `pending`/`failed`; lỗi tạm → `failed` + `next_attempt_at` lùi lũy thừa có equal jitter
(lần n chờ trong [exp/2, exp), exp = 10 s·2^(n−1), trần 1 giờ) hoặc theo `Retry-After` bên kia trả nếu lâu hơn; sau 8 lần → trạng thái
**`dead`** (đây là "DLQ": giữ `payload`, `last_error`, `attempts`) và mở `ops_exception` loại `outbox_dead` (hoặc `notification_failed` cho
thông báo khách), ưu tiên `high`. Vào `dead` NGAY ở lần nhận đầu (T-093), `detail.dead_reason` cho biết vì sao:
`invalid_payload` (payload sai schema `lib/outbox/payload.ts` — `last_error` nêu trường + mã lỗi, không nêu giá trị), `permanent_error` (lỗi
vĩnh viễn: 4xx không phải 408/429, lỗi validate), `max_attempts` (hết lượt). Job KHÔNG tự nhặt `dead`; `invalid_payload`/`permanent_error`
redrive mà không sửa nguyên nhân sẽ lại `dead` ngay.

1. Phát hiện (chưa có rule cảnh báo tự động "dead > 0 sau N phút" — BE-JOB-004 còn mở; kiểm tay hoặc gắn vào giám sát khi có hạ tầng):

   ```sql
   SELECT event_key, type, attempts, last_error, updated_at FROM outbox_event WHERE state = 'dead' AND deleted_at IS NULL ORDER BY updated_at;
   ```

2. Tìm nguyên nhân gốc từ `last_error` TRƯỚC khi redrive (khoá provider hết hạn §9, provider sập, lỗi mã). Redrive khi nguyên nhân còn nguyên chỉ
   đưa sự kiện về `dead` lần nữa.
3. Redrive MỘT sự kiện — an toàn vì tác động ngoài có dedupe (thông báo theo `outbound_message.message_key`, thanh toán theo ledger UNIQUE,
   đồng bộ thanh toán idempotent; xem §3.3.4):

   ```sql
   UPDATE outbox_event SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
    WHERE event_key = '<event_key>' AND state = 'dead' AND deleted_at IS NULL;
   ```

   Không redrive hàng loạt `WHERE state='dead'` khi chưa xem từng `type`. Không đổi `payload`, không xoá dòng.
4. Xác nhận: sau ≤ 1 phút dòng thành `sent` (truy vấn bước 1 không còn nó); rồi đóng `ops_exception` tương ứng trong Admin với ghi chú nguyên
   nhân + việc đã làm. Dòng quay lại `dead` → leo thang cho kỹ thuật (§0), không lặp redrive.

## 13. Ngoại lệ `catalog_compensation_failed` — sản phẩm lệch sau khi hoàn tác lỗi

last_drilled: chưa diễn tập (chỉ chạy trong test tích hợp `catalog-model`, trigger PG giả lập lỗi).

Mô hình thật (`apps/backend/src/workflows/fashion/set-product-fashion.ts`, D-095/D-101): lưu dữ liệu thời trang của một sản phẩm
(`POST /admin/x/products/:id/fashion` — thuộc tính, bảng size, số đo người mẫu) lỗi ở bước sau thì workflow hoàn tác các bước trước.
Hoàn tác cũng lỗi → sản phẩm có thể đang mang **một phần** dữ liệu mới (thuộc tính đã đổi, bảng size đã gỡ, số đo thiếu/thừa so với
trước). Hệ thống ghi log ERROR và mở `ops_exception` loại này, ưu tiên `high`, owner mặc định `owner`; bình thường mỗi sản phẩm có
tối đa một ngoại lệ đang mở (lỗi lặp lại ở cùng sản phẩm không mở thêm; sản phẩm khác có ngoại lệ riêng). **Có thể trùng khi DB nghẽn**
(D-105): chờ khoá mở ngoại lệ quá 5 s thì hệ thống vẫn ghi, không khoá (thà trùng còn hơn mất dấu) — nhận biết qua log WARN
`[ops-exception] Chờ khoá mở ngoại lệ quá 5000ms — ghi dự phòng không khoá: kind=catalog_compensation_failed scope=[product_id]
code=55P03`; bản trùng đóng theo bước 5. `detail` chỉ có id + mã lỗi — không có giá trị thuộc tính hay số đo (số đo người mẫu là PII).

1. Tìm sản phẩm: dashboard ngoại lệ (Admin → Ngoại lệ, lọc "Hoàn tác dữ liệu sản phẩm lỗi") — cột tham chiếu là id sản phẩm; hoặc

   ```sql
   SELECT id, created_at, detail->>'product_id' AS product_id, detail->>'step' AS step, detail->>'error' AS error,
          detail->>'attributes_id' AS attributes_id
     FROM ops_exception
    WHERE kind = 'catalog_compensation_failed' AND state IN ('open', 'in_progress') AND deleted_at IS NULL
    ORDER BY created_at;
   ```

   Log tương ứng: dòng `[set-product-fashion] Hoàn tác … lỗi: product_id=<id> …: <mã lỗi>` (cùng thời điểm `created_at`).
   `step`: `attributes` (thuộc tính), `size_chart` (gắn lại bảng size — `from`/`to` là id bảng size), `measurements` (số đo người mẫu).
   `error` chỉ gồm tên lỗi + mã Postgres/constraint (vd. `code=23514 constraint=…`, `code=57014` hết giờ) — đủ để biết lỗi tạm hay lỗi
   dữ liệu. Không thấy log/ngoại lệ mở được (`Không mở được ngoại lệ catalog_compensation_failed`) → tìm theo log.
2. Sửa nguyên nhân trước nếu là lỗi dữ liệu/ràng buộc (constraint mới, DB hết chỗ…); lỗi tạm (mất kết nối, hết giờ) thì bỏ qua bước này.
3. Đưa sản phẩm về đúng: người quản lý catalog mở sản phẩm trong Admin, kiểm thuộc tính thời trang, bảng size, số đo người mẫu so với dữ
   liệu đúng (ảnh/phiếu người mẫu gốc) và **gửi lại toàn bộ** dữ liệu thời trang (lưu lại form = `POST /admin/x/products/:id/fashion`
   với đủ thuộc tính, `size_chart_id`, `model_measurements` — thay toàn bộ, không vá từng phần). Không sửa thẳng bảng
   `fashion_*` bằng SQL.
4. Kiểm điều kiện xuất bản: `GET /admin/x/products/:id/publish-check` → `ready: true`. Sản phẩm đang `published` mà chưa đạt → chuyển
   `draft` cho tới khi đủ dữ liệu (khách không thấy trang thiếu bảng size/chất liệu).
5. Đóng ngoại lệ kèm ghi chú nguyên nhân + việc đã làm. Admin chưa có nút đóng ngoại lệ vận hành (`ops_exception`) — tạm thời:

   ```sql
   UPDATE ops_exception SET state = 'resolved', updated_at = now()
    WHERE id = '<id>' AND kind = 'catalog_compensation_failed' AND state IN ('open', 'in_progress');
   ```

   Nhiều dòng đang mở cùng `product_id` (bản trùng do ghi dự phòng D-105, xem log WARN ở trên): xử lý sản phẩm **một lần** (bước 2–4),
   giữ dòng sớm nhất để ghi chú, đóng các bản trùng còn lại:

   ```sql
   UPDATE ops_exception SET state = 'resolved', updated_at = now()
    WHERE kind = 'catalog_compensation_failed' AND state IN ('open', 'in_progress') AND deleted_at IS NULL
      AND detail->>'product_id' = '<product_id>' AND id <> '<id dòng giữ lại>';
   ```

   Sản phẩm đó lỗi lại sau khi đóng → ngoại lệ mới được mở; cùng sản phẩm lặp lại nhiều lần → leo thang cho kỹ thuật (§0).
