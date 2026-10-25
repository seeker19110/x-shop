# RUNBOOK — x-shop · 0.2 · 2026-10-25

> Đặc tả §13.2. Mục 3, 4 đã có quy trình thật + diễn tập (T-037, `bash scripts/ops/restore-drill.sh`). Mỗi mục: dấu hiệu → kiểm tra → xử lý →
> xác nhận đã ổn. Nguyên tắc: **tiền và tồn đúng quan trọng hơn còn bán được**; mất cơ chế khóa an toàn thì dừng checkout,
> vẫn cho xem catalog.

## 0. Liên lạc và quyền
| Vai trò | Ai | Kênh |
|---|---|---|
| Trực kỹ thuật | [chủ dự án điền] | |
| Kế toán (tiền, hoàn) | [chủ dự án điền] | |
| Liên hệ VNPAY / GHN | theo hợp đồng merchant | |

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
- Rollback ứng dụng không rollback database phá hủy (migration expand/contract). Giữ endpoint IPN/callback chạy ở bản rollback; đối soát giao dịch đang dở sau rollback.
- Không cưỡng ép reload storefront khi khách đang thanh toán (service worker có version, cập nhật ở lần điều hướng sau).

## 6. Ảnh lỗi / CDN
- Ảnh hỏng: storefront vẫn hiển thị alt + khung tỷ lệ cố định (không CLS); thay ảnh tạo URL mới (hash), không ghi đè URL cũ.

## 7. Tiền đến sau khi hủy / thu dư
- `ops_exception late_payment|overpayment`: kế toán xác minh trên cổng → tạo refund (một refund, retry cùng id) → ghi chú khách. Không phục hồi đơn, không giao thay thế khi chưa có xác nhận mới của khách.
