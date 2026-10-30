# RUNBOOK — x-shop · 0.3 · 2026-10-26

> Đặc tả §13.2. Mục 3, 4 đã có quy trình thật + diễn tập (T-037, `bash scripts/ops/restore-drill.sh`). Mỗi mục: dấu hiệu → kiểm tra → xử lý →
> xác nhận đã ổn. Nguyên tắc: **tiền và tồn đúng quan trọng hơn còn bán được**; mất cơ chế khóa an toàn thì dừng checkout,
> vẫn cho xem catalog.

## 0. Liên lạc, nơi giữ bí mật, trạng thái diễn tập

| Vai trò                             | Ai                                 | Kênh                                                      |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| Trực kỹ thuật                       | [chủ dự án điền — chưa có dữ liệu] | [chủ dự án điền]                                          |
| Kế toán (tiền, hoàn)                | [chủ dự án điền — chưa có dữ liệu] | [chủ dự án điền]                                          |
| Quyết định rollback / dừng checkout | [chủ dự án điền]                   | [chủ dự án điền]                                          |
| Liên hệ VNPAY / GHN                 | theo hợp đồng merchant             | cổng hỗ trợ trong hợp đồng (chưa có hợp đồng — chủ dự án) |

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

| Mục                    | last_drilled  | Ghi chú                                                              |
| ---------------------- | ------------- | -------------------------------------------------------------------- |
| Khôi phục backup (§4)  | 2026-10-25    | `bash scripts/ops/restore-drill.sh`, DB cỡ nhỏ, máy dev              |
| Mất Redis (§3)         | 2026-10-25    | cùng script, bước 5                                                  |
| Deploy (§8)            | chưa diễn tập | chưa có cơ chế deploy/hạ tầng                                        |
| Rollback ứng dụng (§5) | chưa diễn tập | cần cơ chế deploy; cần trước khi lên production lần đầu (WF-REL-004) |
| Xoay secret (§9)       | chưa diễn tập | cần môi trường staging                                               |
| Lộ bí mật (§10)        | chưa diễn tập | tập bàn giấy khi có staging                                          |
| Redrive outbox (§12)   | chưa diễn tập | lệnh SQL chưa chạy trên DB thật                                      |

## 1. Cổng thanh toán lỗi (VNPAY không phản hồi, IPN không về)

last_drilled: chưa diễn tập (chưa có tài khoản merchant VNPAY/sandbox thật; chỉ chạy qua mock trong test tích hợp).

- Dấu hiệu: `payment_attempt` ở `pending`/`unknown` tăng; cảnh báo "đã nhận dấu hiệu thanh toán nhưng chưa xử lý > 5 phút".
- Kiểm tra: log `webhook_inbox` (verified, result); job `expire-holds` có chạy; gọi `querydr` thủ công cho vài `txn_ref`.
- Breaker `vnpay.querydr` (T-161, §14): VNPAY lỗi tạm liên tiếp → job `expire-holds` ngừng gọi querydr, mở ngoại lệ `job_circuit_open`
  (`detail.breaker = 'vnpay.querydr'`); đơn quá hạn được giữ như `unknown` (`payment_unknown` lý do `breaker_*`), tự hỏi lại khi
  breaker đóng. IPN không đi qua breaker — vẫn xác nhận đơn bình thường.
- Backoff theo đơn (T-164): đơn quá hạn có querydr chưa rõ (mã 91, chữ ký sai, hết giờ…) không bị hỏi mỗi phút — hẹn lại
  1 → 2 → 4 … → 60 phút (`order_finance.next_check_at`, số lần `hold_check_attempts`), nên đơn chưa rõ tồn đọng không chặn đơn
  quá hạn mới. Xem đơn đang hẹn, và buộc hỏi lại ngay một đơn (ví dụ sau khi VNPAY xác nhận đã sửa lỗi) — lượt `x-expire-holds`
  kế tiếp (≤ 1 phút) hỏi lại:

  ```sql
  SELECT order_id, display_ref, hold_expires_at, hold_check_attempts, next_check_at FROM order_finance
   WHERE state = 'awaiting_payment' AND hold_expires_at <= now() ORDER BY hold_check_attempts DESC, hold_expires_at LIMIT 50;
  UPDATE order_finance SET next_check_at = NULL, updated_at = now()
   WHERE order_id = '<order_id>' AND state = 'awaiting_payment';
  ```

  Cảnh báo tồn đọng: log WARN `[expire-holds] N đơn quá hạn chưa rõ thanh toán đang giữ hàng (ngưỡng 50)` mỗi lượt khi số đơn
  quá hạn còn `awaiting_payment` đã được job xét mà chưa có kết cục — querydr chưa rõ/lỗi (`hold_check_attempts` ≥ 1) hoặc bị
  hoãn không hỏi (breaker mở, `VNPAY_ENABLED=false`: `next_check_at` có giá trị) — chạm ngưỡng
  (`HOLD_RECHECK_POLICY.backlogWarnAt`). Đơn quá hạn chưa tới lượt xét lần nào không tính. Thường là cổng trả mã 91/chữ ký sai
  hàng loạt (khoá/cấu hình VNPAY), breaker mở kéo dài hoặc VNPAY đang tắt → kiểm `detail->>'reason'` của `payment_unknown` (§14
  bước 5) và đối chiếu với VNPAY trước khi làm gì khác. Chỉ đặt NULL (không sửa `state`/`hold_check_attempts`). Đơn chưa rõ quá vài giờ (`hold_check_attempts` ≥ 8): đối chiếu trên
  cổng merchant VNPAY theo `txn_ref`, rồi đi §1.1 — không sửa `state` bằng SQL.

- `VNPAY_ENABLED=false` (T-166) chỉ chặn TẠO thanh toán VNPAY mới (quote/submit trả lỗi phương thức chưa bật). Đơn VNPAY đang
  chờ: `x-expire-holds` không querydr, không hủy — giữ hàng như breaker mở (`payment_unknown` lý do `vnpay_disabled`, hẹn lại 1
  phút, không tăng backoff); hủy thường (`/cancel`) trả 409 PAYMENT_PENDING — dùng §1.1; đơn đã có IPN thất bại (không còn attempt mở) vẫn hủy bình thường.
  IPN vẫn xác minh bằng `VNPAY_TMN_CODE`/`VNPAY_HASH_SECRET` (+ `_PREVIOUS`) — phải giữ các biến này khi tắt; production tắt mà
  thiếu khoá (hoặc dùng khoá giả dev) → IPN trả 99 để VNPAY gửi lại, không ghi inbox/tiền, log WARN `[payment] IPN VNPAY tới khi
không có khoá xác minh`. Bật lại → lượt kế tiếp hỏi lại từng đơn.
- Xử lý: KHÔNG hủy hàng loạt đơn `unknown`. Tạm ẩn phương thức VNPAY (`VNPAY_ENABLED=false`, giữ khoá) để khách chọn COD; giữ endpoint IPN chạy để nhận thông báo đến muộn; đối chiếu `querydr` theo lô khi cổng hồi phục.
- Xác nhận: không còn attempt `unknown` quá hạn chưa có owner trong `ops_exception`.

### 1.1 Hủy từng đơn có thanh toán chưa xác minh (T-165, D-118)

Dùng khi một đơn `awaiting_payment` có attempt `unknown` (hoặc `pending` đã quá hạn giữ hàng) mà cổng vẫn không trả lời rõ,
và đã đối chiếu tay trên cổng merchant VNPAY theo `txn_ref` rằng KHÔNG có giao dịch thành công. Từng đơn, không hàng loạt.

1. Người làm: **owner** (quyền `payment.override`, phiên đã qua MFA và xác thực lại — đăng nhập + TOTP — trong 5 phút gần nhất, D-122; quá hạn → 403 `REAUTH_REQUIRED`: đăng nhập lại rồi gửi lại cùng khóa). Vai trò khác — kể cả kế toán — nhận 403; muốn cấp thêm
   là đổi ma trận vai trò (`packages/domain/src/access/rbac.ts`) có quyết định.
2. Lấy `order_id` + `txn_ref` (truy vấn `order_finance` ở trên, hoặc `payment_unknown` → `detail.txn_ref`); tra `txn_ref` trên
   cổng merchant; ghi lại mã đối chiếu thấy trên cổng (mã giao dịch/mã tra cứu — 6–64 ký tự `[A-Za-z0-9_.:-]`; định dạng chưa xác minh với tài liệu merchant).
3. Gọi (một `Idempotency-Key` mới cho mỗi đơn; mất mạng → gửi lại ĐÚNG khóa + nội dung đó):

   ```bash
   KEY=$(uuidgen)   # tạo MỘT lần cho đơn này; gửi lại (mất mạng, 409 BUSY_RETRY, sau khi xác thực lại) dùng lại đúng $KEY
   BODY='{"reason":"Đã tra txn_ref trên cổng merchant: không có giao dịch thành công","merchant_ref":"<mã trên cổng>"}'
   curl -sS -X POST "$BACKEND_URL/admin/x/orders/<order_id>/cancel-unverified" \
     -H "Authorization: Bearer <token phiên owner đã MFA>" -H "Content-Type: application/json" \
     -H "Idempotency-Key: $KEY" -d "$BODY"
   ```

4. Kết quả: 200 `state=cancelled` → đơn hủy, hàng nhả, attempt `failed`, `payment_unknown` của đơn `resolved`
   (`detail.resolution = cancelled_unverified`, `merchant_ref`, `resolved_by`), audit `order.cancelled_unverified`, khách thấy
   "Cửa hàng đã hủy đơn". 409 `NOT_AWAITING_PAYMENT` (`state`): đơn đã xác nhận (tiền về trước — kể cả do lần hỏi cổng cuối
   của chính lệnh này) hoặc đã hủy → không làm gì thêm. 409 `PAYMENT_NOT_UNVERIFIED` (`reason`): `hold_active` (khách còn
   trong hạn trả — chờ), `no_open_payment` (đã có kết quả thất bại — job tự hủy, hoặc `/cancel`), `payment_received` (đã có
   tiền — dùng `/cancel` để mở hoàn tiền). 409 `BUSY_RETRY`: gửi lại cùng khóa sau vài giây.
5. Nếu tiền vẫn về sau đó (IPN/querydr thành công): đơn KHÔNG phục hồi; hệ thống ghi khoản thu + `late_payment` → §7.

### 1.2 WARN `thiếu vnp_create_date` — querydr/hoàn tiền của attempt tạo trước T-170

querydr và refund gửi `vnp_TransactionDate` = `payment_attempt.vnp_create_date` — đúng chuỗi `vnp_CreateDate` của URL
thanh toán gốc (`yyyyMMddHHmmss` giờ VN). Theo nguồn thứ cấp VNPAY so khớp hai giá trị này (chưa xác minh với tài liệu
merchant, RK-006). Attempt tạo trước T-170, hoặc do bản N−1 tạo trong lúc deploy cuốn, có cột NULL → hệ thống dùng
`created_at` (cách cũ, thường lệch 1 giây vì INSERT sau mốc ký URL vài trăm ms) và log:
`[payment] payment_attempt <id> txn_ref=<PA_…> thiếu vnp_create_date hợp lệ (dữ liệu trước T-170) — <querydr|refund> dùng created_at …`.

- Ảnh hưởng nếu VNPAY so khớp chặt: querydr của đơn đó trả lỗi → `unknown` (job `expire-holds` giữ hàng, backoff — không
  hủy nhầm); hoàn qua cổng → `failed`/`unknown` (tiền vẫn giữ, §7). Không mất tiền, chỉ kẹt cho tới khi sửa.
- Sửa: lấy lại chuỗi gốc từ `payment_url` đã lưu (URL đã ký gửi khách, có `vnp_CreateDate`). Xem trước, rồi điền — chỉ
  dòng NULL, chỉ chuỗi đúng 14 chữ số (CHECK `payment_attempt_vnp_create_date_format` chặn giá trị sai dạng):

  ```sql
  SELECT id, txn_ref, state, created_at,
         substring(payment_url from '[?&]vnp_CreateDate=([0-9]{14})(&|$)') AS vnp_create_date
    FROM payment_attempt WHERE vnp_create_date IS NULL AND provider = 'vnpay' ORDER BY created_at DESC LIMIT 100;
  UPDATE payment_attempt
     SET vnp_create_date = substring(payment_url from '[?&]vnp_CreateDate=([0-9]{14})(&|$)'), updated_at = now()
   WHERE vnp_create_date IS NULL AND provider = 'vnpay'
     AND payment_url ~ '[?&]vnp_CreateDate=[0-9]{14}(&|$)';
  ```

  Dòng không có `payment_url` (attempt chưa từng gửi khách — `created`/`failed` do bù trừ) không có giao dịch ở VNPAY: để
  NULL. Sau khi điền: đơn đang backoff → đặt `next_check_at = NULL` (§1) để lượt kế tiếp hỏi lại; hoàn `failed` đã gửi
  cổng → `execute` lại (cùng `vnp_RequestId`).

- Không sửa `created_at` để "khớp" — cột đó là mốc DB, không phải mốc gửi VNPAY.

## 2. Hãng vận chuyển lỗi (GHN)

last_drilled: chưa diễn tập (chưa có tài khoản/khoá GHN thật; chỉ chạy qua mock trong test tích hợp).

- Tạo vận đơn timeout → hệ thống tra theo `client_order_code` trước khi tạo lại (không tạo tay vận đơn mới khi chưa tra).
- Callback ngừng: chạy job đồng bộ trạng thái bằng API; không tự đánh dấu "đã giao".

## 3. Redis / worker lỗi

last_drilled: 2026-10-25 (`bash scripts/ops/restore-drill.sh` bước 5, máy dev).

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
- **Giới hạn**: không mô phỏng Redis chết _giữa_ một workflow Medusa đang chạy (dừng tiến trình giữa bước) mà mô phỏng trạng thái
  bền vững để lại sau đó (attempt `preparing` quá lease, outbox chưa đánh dấu dù đã gửi); không chạy cron thật (gọi thẳng hàm job);
  không có đơn native/reservation thật trong dữ liệu mẫu (nhánh nhả reservation có test tích hợp `checkout-expiry.spec.ts`);
  phản hồi của submit khi Redis đang mất được kiểm riêng ở `checkout-lock-outage.spec.ts` (3.2.1; giả lập trên client ioredis
  của provider locking-redis — event bus/cache/workflow engine vẫn chạy, nên đây không phải diễn tập mất cả Redis).

## 4. Database outage / khôi phục

last_drilled: 2026-10-25 (`bash scripts/ops/restore-drill.sh`, DB cỡ nhỏ, máy dev; chưa diễn tập PITR production — xem 4.5).

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

| Bước        | Kết quả                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 DB nguồn  | migration Medusa đủ (197 module + 22 link + 6 script); attempt `preparing` quá lease, payment `pending`/`unknown`, outbox `pending`, ledger                                     |
| 2 Sao lưu   | `pg_dump -Fc` mã hoá gpg AES256 (passphrase file tạm), ≈ 78 KB; sau mốc ghi: IPN muộn cho `PA_DRILL_PENDING`, 2 đơn VNPAY mới, 1 vận đơn mới                                    |
| 3 Khôi phục | **RTO đo được 14 s và 16 s** (restore + kiểm toàn vẹn + migrate; ngưỡng 7200 s); 175/175 bảng trùng số dòng + md5 nội dung lúc snapshot; migrate lại không đổi bảng migration   |
| 4 Đối chiếu | đúng 4 `txn_ref` cần querydr (2 `missing_in_db`, 1 `provider_activity_after_mark`, 1 `open_in_db`) + 2 vận đơn; khớp kỳ vọng VÀ khớp diff dòng nguồn↔đích (độc lập với mốc giờ) |
| 5 Mất Redis | xem 3.5                                                                                                                                                                         |
| 6 RPO       | **CHỜ NGƯỜI** — xem 4.5                                                                                                                                                         |
| 7 Dọn dẹp   | DB `xs_drill_*_<pid>` đã xoá, Redis DB index diễn tập rỗng                                                                                                                      |

Kiểm đột biến: `XS_RTO_MAX_SECONDS=1` → bước 3 FAIL; biên cửa sổ quá rộng (`XS_RECONCILE_MARGIN_SECONDS=99999`) → bước 4 FAIL (thừa
mục); Redis DB index không rỗng → từ chối chạy, không xoá khoá của người khác. `restore.sh`: sai passphrase, file bị sửa (sha256),
file hỏng → dừng, không để lại DB dở.

**Giới hạn — không suy ra RTO production từ số này:** DB diễn tập ≈ 78 KB; thời gian `pg_restore` tăng gần tuyến tính theo dung lượng

- index. Trước ra mắt đo lại với bộ dữ liệu cỡ thật (T-036: 10.000 sản phẩm / 50.000 SKU + lịch sử đơn ước tính) trên cấu hình máy
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
  CI cưỡng chế (T-102, `scripts/check-migrations.mjs`): `pnpm check:migrations` — migration đã có trên nhánh đích giữ nguyên byte;
  migration mới (SQL thật lấy bằng cách chạy `up()` với `addSql` giả trong `node:vm` — KHÔNG cô lập, migration là mã repo cùng mức
  tin cậy với jest trong CI; rẽ nhánh theo môi trường, import lạ, knex, vòng lặp vô hạn → đỏ; so với schema do các migration trên
  nhánh đích tạo) không DROP
  TABLE/COLUMN, RENAME/SET SCHEMA, đổi kiểu, SET NOT NULL, thêm cột NOT NULL không DEFAULT, TRUNCATE, DELETE không WHERE, drop
  index/ràng buộc đã phát hành mà không tạo lại, trong `up()` — trừ khi file có chú thích
  `// @migration-contract: <lý do, nêu MigrationYYYYMMDDHHMMSS expand>`; SET NOT NULL đi đường `CHECK … NOT VALID` → `VALIDATE` →
  `SET NOT NULL` ở migration contract sau. `pnpm check:migrations:drift` (cần Postgres) — model DML khớp migration
  (`medusa db:generate` không sinh gì, không module nào lỗi).
  **Bản N−1 trên schema N** (T-163, `scripts/n-minus-1.mjs`, job CI `n-minus-1`): code của ref gốc (cùng quy tắc với
  `check:migrations`: `--base` > `MIGRATIONS_BASE_REF` > `origin/master`) chạy bộ test tích hợp của CHÍNH nó trên schema do
  migration của HEAD tạo. Chỉ xét migration của module tùy biến (`apps/backend/src/modules/*/migrations`); không có file nào
  thêm/đổi/xoá so với ref gốc → bỏ qua ngay, exit 0. **Khoảng trống đã biết:** PR nâng `@medusajs/*` (migration lõi đổi) không
  kích job; PR nâng Medusa kèm migration tùy biến sẽ ra mã 2 "schema lệch" vì cây N−1 chạy migration lõi cũ — tách nâng Medusa ra
  PR riêng. Cách làm: `git archive` ref gốc vào thư mục tạm → `pnpm install --frozen-lockfile --prefer-offline --filter
@x-shop/backend...` (store pnpm dùng chung với cây HEAD làm cache) → phủ file migration thêm/đổi/xoá của HEAD lên thư mục
  `migrations/` của các module có ở bản N−1 → hai DB dùng một lần `xshop_n1_<hex>_head|_base`: `medusa db:migrate` bằng mã
  HEAD và bằng mã N−1 + phần phủ; schema `public` phải trùng trên mọi bảng/đối tượng N−1 biết — cột (kiểu, NULL, DEFAULT,
  precision/scale, datetime precision, identity, generated), ràng buộc, index, trigger (trừ trigger nội bộ), policy + cờ RLS,
  function (tham số định danh + md5 thân), enum (nhãn theo thứ tự); bảng/function/enum chỉ có ở HEAD (module/link mới) chỉ
  ghi log → xoá hai DB → `pnpm run test:integration` của cây N−1. Vì sao phủ thay cho "trỏ test vào DB đã migrate":
  `medusaIntegrationTestRunner` (@medusajs/test-utils 2.22.1) tự tạo DB tên ngẫu nhiên cho mỗi suite, tự migrate bằng migration
  của code đang nạp rồi xoá; phép so schema ở bước trước chứng minh phần phủ tái tạo đúng schema N.
  **Phân loại theo CA** (D-124, từ báo cáo `jest --json`): ca đỏ khớp `N1_ALLOW` được bỏ ra; suite còn ca đỏ được chạy lại 2 lần
  trên schema N (xác nhận) rồi, sau khi gỡ phần phủ, 1 lần trên schema N−1 (đối chứng). Mỗi ca: đỏ ở đối chứng → `N−1 TỰ ĐỎ`;
  xanh ở đối chứng, đỏ ở ít nhất một lần xác nhận → `KHÔNG TƯƠNG THÍCH`; xanh ở mọi lần chạy lại → `CHẬP CHỜN`. Mã thoát: 0 = lần
  đầu xanh, hoặc mọi ca đỏ đều được miễn, hoặc không có migration tùy biến đổi · 1 = có ca KHÔNG TƯƠNG THÍCH · 2 = không kết luận
  được (xem bảng dưới). Mã 1 và 2 đều làm job đỏ, có annotation `::error::` nêu nguyên nhân + hướng xử lý.
  **Job `n-minus-1` là cổng thật cho PR có migration** (D-124): chạy song song với `gate` (không `needs`), không nằm trong
  `quality.needs` nên không phải required check của ruleset, nhưng `xt.py merge-check` của khung xét mọi check của PR nên job đỏ
  chặn merge do máy. Chưa chia shard (D-123); timeout 60 phút (cả bộ 26–44 phút ở máy dev + chạy lại suite đỏ).
  **Xử lý job n-minus-1 đỏ (mã 1/2), theo dòng log/annotation:**
  - `KHÔNG TƯƠNG THÍCH` (mã 1, `incompatible`): migration phá bản N−1 → tách expand/contract như trên. Chỉ khi ca là hàng rào so
    bằng schema↔hằng code theo thiết kế (không phải lỗi thật) mới thêm mục `N1_ALLOW` (dưới), kèm số đo "xanh trên schema N−1, chỉ
    ca này đỏ trên schema N".
  - `N−1 TỰ ĐỎ` (mã 2, `base-red`): ca đỏ ngay trên schema N−1 của bản N−1 → merge master mới nhất vào nhánh (nếu ref gốc đã sửa
    test) hoặc sửa test trên nhánh đích, rồi chạy lại.
  - `CHẬP CHỜN` (mã 2, `flaky`): đỏ lần đầu, xanh ở mọi lần chạy lại → chạy lại job; lặp lại thì sửa test chập chờn.
  - Schema lệch (mã 2, `schema-mismatch`): PR nâng `@medusajs/*` kèm migration → tách nâng Medusa ra PR riêng không kèm migration;
    migration của module MỚI chạm bảng/trigger của module cũ → chuyển phần đó vào migration của module cũ.
  - `allow-invalid` (mã 2): mục `N1_ALLOW` nêu migration không còn trong cây / thiếu trường → sửa hoặc xoá mục.
  - `ref-missing`, `step-failed`, `report-unreadable`, `remote-db` (mã 2): clone nông (cần `fetch-depth: 0`), bước
    cài/build/`db:migrate` lỗi (đọc đuôi log của bước), báo cáo jest không đọc được (jest bị kill/hết bộ nhớ — chạy lại), DB không
    phải cục bộ/CI (script CREATE/DROP DB; DB khác phải thêm `--allow-remote-db`).
    Dọn thư mục tạm + DB `xshop_n1_*` của chính lần chạy ở mọi nhánh, cả SIGINT/SIGTERM (chuyển tín hiệu cho nhóm tiến trình con
    theo pid). DB `medusa-*-integration-*` do runner của Medusa tự xoá khi suite kết thúc hoặc khi nhận SIGINT/SIGTERM; bị SIGKILL
    hoặc job hết giờ thì CÓ THỂ SÓT — ở máy dev xoá tay sau khi chắc không còn lần chạy test nào khác đang dùng (tên không cho biết
    của lần chạy nào). Chạy ở máy (Postgres/Redis của `scripts/dev-services.sh`; chỉ host cục bộ, trừ khi `--allow-remote-db`) —
    **merge master vào nhánh trước** để `--base origin/master` so đúng phần của nhánh:

  ```bash
  git fetch origin master && git merge origin/master                          # trước khi chạy ở máy
  N1_WORKDIR=/tmp node scripts/n-minus-1.mjs --base origin/master            # cả bộ test tích hợp của bản N−1
  node scripts/n-minus-1.mjs --base origin/master --test-pattern checkout   # tập con (regex đường dẫn của Jest)
  node scripts/n-minus-1.mjs --detect-only --base origin/master            # chỉ báo có migration đổi không
  ```

  Số đo ở máy dev (4 CPU, 2026-10-27/28): phần trước test (archive, cài cây N−1 từ store, build domain hai cây, hai lần
  `db:migrate`, so schema) 30 s–1,5 phút; cả bộ test tích hợp của N−1 26m29s (ref gốc `bf24224~1`, 43 suite/619 ca) và 44m23s
  (ref gốc `d63dc4e~1`, 45 suite/719 ca, máy đang tải 4–7,5 do phiên khác); chạy lại một suite ~2 phút mỗi lần.
  Hai lần chạy thật cả bộ đều đỏ, cả hai không phải do migration hỏng: (1) `bf24224~1` — `redact-http-db-error.spec.ts` tự đỏ ở
  chính ref gốc (đỏ cả trên schema N−1) → mã 2 "N−1 TỰ ĐỎ"; (2) `d63dc4e~1` — `catalog-model.spec.ts` "hàng rào: CHECK
  ops_exception.kind trên DB thật = OPS_EXCEPTION_KINDS" đỏ vì Migration20261027160101 nới CHECK thêm `job_circuit_open`: test
  so BẰNG giữa schema và hằng của code nên luôn đỏ ở bản N−1 khi CHECK được nới, dù nới CHECK là tương thích ngược cho việc ghi.
  Sau khi có danh sách miễn (2026-10-28, cùng ref gốc, phủ thêm Migration20261027210643 của T-164): tập con catalog-model +
  checkout-submit/checkout-expiry/payment-ipn/staff-cancel (đọc/ghi `order_finance`) ra mã 0 trong 8m43s, 121 ca, chỉ ca hàng rào
  trên được miễn. **Danh sách miễn `N1_ALLOW`** (D-123, trong `scripts/n-minus-1.mjs`): mỗi mục = suite + tên ca đầy đủ (khớp
  chính xác `describe › … › ca`, lấy từ báo cáo `jest --json`) + file migration của HEAD gây lệch + lý do. Mục chỉ đang hiệu lực
  khi migration của nó nằm trong phần phủ của lần chạy; ca đỏ khớp mục đang hiệu lực được miễn (dòng `MIỄN (N1_ALLOW)`), ca đỏ
  khác của cùng suite vẫn được phân loại; mục đang hiệu lực mà không khớp ca đỏ nào → dòng `NHẮC` (xoá mục khi không còn cần);
  mục nêu migration không còn trong cây → mã 2. Thêm mục chỉ cho hàng rào so bằng theo thiết kế; không thêm để che lỗi thật. Mục
  hiện có: ca hàng rào CHECK `ops_exception.kind` ↔ Migration20261027160101.
  **Việc cần làm (chưa có kiểm, D-123):** bản N−1 ĐỌC phải giá trị enum mới do bản N ghi khi hai bản chạy song song trên schema
  N (vd `ops_exception.kind = 'job_circuit_open'` sau Migration20261027160101): bộ test của N−1 chỉ ghi/đọc dữ liệu do chính nó
  tạo nên không phát hiện được. Cần: code đọc enum/kind (danh sách ngoại lệ Admin, zod/parse, `switch` không `default`) chịu
  được giá trị lạ (bỏ qua/hiển thị thô, không 500), và test seed dòng có kind lạ rồi gọi route đọc. Đến lúc đó, migration nới
  CHECK/enum phải kèm rà tay các đường đọc của bản N−1.

- **Ngưỡng quyết định lùi (đề xuất, chủ dự án duyệt — chưa có hạ tầng đo tự động):** trong 30 phút sau deploy, lùi nếu một trong:
  smoke §8.3 đỏ · tỷ lệ 5xx của `/store/x/*` > 2% trong 5 phút liên tiếp · p95 `POST /store/x/checkout/submit` vượt 2× số đo ở
  `docs/ops/perf/` trong 10 phút · có đơn đã đặt nhưng thiếu `order_finance`/`payment_attempt` (đối chiếu truy vấn §3.3.3). Người quyết
  lùi: vai trò "Quyết định rollback" ở §0 (không tự động).
- Sau rollback: đối chiếu như §4.3 và kiểm `outbox_event` theo §12.

## 6. Ảnh lỗi / CDN

last_drilled: chưa diễn tập (chưa có CDN/kho ảnh thật — §8.2b chờ chủ dự án dựng).

- Ảnh hỏng: storefront vẫn hiển thị alt + khung tỷ lệ cố định (không CLS); thay ảnh tạo URL mới (hash), không ghi đè URL cũ.
- Header file tĩnh (D-024): Medusa phục vụ `/static` bằng `express.static` trước middleware dự án nên backend không gắn
  được `X-Content-Type-Options: nosniff` cho đường này. Checklist triển khai: reverse proxy/CDN đặt `nosniff` cho
  `/static/*` (và mọi file ảnh); production nên tắt `/static`, ảnh qua file module S3-compatible + CDN. Kiểm sau deploy:
  `curl -sI https://<backend>/static/<file> | grep -i x-content-type-options`.
- Từ T-154 production bắt buộc `FILE_STORAGE=s3` (§8.2b): ảnh mới nằm ở bucket công khai, URL `<S3_FILE_URL>/<khoá>` — đặt
  `X-Content-Type-Options: nosniff` và `Content-Type` đúng ở kho/CDN đó; `static/` của backend không còn nhận file mới.

## 7. Tiền đến sau khi hủy / thu dư

last_drilled: chưa diễn tập (chỉ chạy trong test tích hợp `late-payment`; chưa có cổng thanh toán thật).

- `ops_exception late_payment|overpayment`: kế toán xác minh trên cổng → tạo refund (một refund, retry cùng id) → ghi chú khách. Không phục hồi đơn, không giao thay thế khi chưa có xác nhận mới của khách.
- Gồm cả đơn đã hủy chưa xác minh (§1.1) và đơn hết hạn mà tiền về sau. Khoản thu đến sau được gắn vào attempt (attempt
  vẫn `failed`, mang `provider_txn_no` của khoản thu — T-168) nên đối soát VNPAY tìm được giao dịch gốc, và ở `mock`
  (dev/CI) hoàn qua cổng (`method` `provider`/`auto`) chạy được.
- **sandbox/live (cổng hoàn tắt khi chưa có ủy quyền hoàn thật — T-169):** `method: "auto"` (mặc định; cũng là cách hệ
  thống tạo hoàn khi hủy đơn và khi kiểm định trả hàng) tự chọn `manual`; `note` của refund có thêm
  `[Hoàn tay do hệ thống chọn: … (provider_disabled)]`. Hoàn ngoài hệ thống rồi `execute` kèm `evidence_ref` (mã chứng từ
  chuyển khoản). Chọn `provider` tường minh khi cổng tắt → 409 `REFUND_PROVIDER_DISABLED` ngay lúc tạo (không giữ tiền).
- Yêu cầu `provider` tạo TRƯỚC khi cổng tắt (hoặc trước T-169), hay trỏ khoản thu không còn giao dịch gốc: `execute` →
  409 `REFUND_PROVIDER_DISABLED` / 422 `REFUND_METHOD_UNAVAILABLE` và yêu cầu chuyển `failed` (`last_error` =
  `provider_disabled` / `method_unavailable`, `attempts = 0` = chưa từng gửi cổng). Vẫn giữ số tiền cho tới khi **hủy**
  (`POST /admin/x/refunds/:id/cancel`, lý do bắt buộc — hủy ngay, không cần hỏi cổng vì chưa gửi) → tạo `manual` cùng số
  tiền. Bản ghi cũ còn kẹt ở `approved`: gọi `execute` một lần để chuyển `failed`, rồi hủy.
- Yêu cầu `provider` cũ còn ở `requested` (tạo trước T-169, chưa duyệt): **từ chối** (`POST /admin/x/refunds/:id/reject`,
  quyền `refund.approve`, lý do bắt buộc) — nhả số tiền ngay, chưa có gì gửi cổng — rồi tạo `auto`/`manual` mới. Hoặc
  duyệt → `execute` (→ `failed`, `attempts = 0`) → hủy như dòng trên. Hoàn do hủy đơn bị từ chối mở lại được bằng
  `POST /admin/x/refunds` `reason: "cancellation"`. **Hoàn theo trả hàng (`reason = return`) KHÔNG từ chối** — chỉ bản
  `cancelled` mới mở lại được theo `return_id`; server trả 409 `RETURN_REFUND_NOT_REJECTABLE` (T-173), Admin ẩn nút
  "Từ chối" và hiện hướng dẫn. Đường đi tiếp nằm ở `next_steps` của 409, tính theo cách hoàn + trạng thái:
  - `provider`: duyệt → `execute`; cần đổi cách hoàn (cổng tắt/từ chối) → `failed` → hủy → mở lại (`reason: "return"`,
    `return_id`). `failed` → thực hiện lại (còn lượt) hoặc hủy → mở lại; `processing`/`unknown` → chỉ `execute` (hỏi cổng).
  - `manual` (gồm mọi đơn COD, và kiểm định lúc cổng tắt): không bao giờ tự vào `failed` → chỉ duyệt → `execute` kèm
    `evidence_ref` (`evidence_required: true`); không có đường hủy/mở lại.
  - Đã kết thúc (`succeeded`/`cancelled`): `next_steps` rỗng.
- **Dữ liệu cũ — hoàn theo trả hàng đã `rejected` TRƯỚC T-173** (yêu cầu trả kẹt: mở lại → 409 `INVALID_STATE`; gọi
  `reject` lại chỉ trả 200 nguyên bản ghi). CHỈ dùng cho bản ghi tạo trước T-173, sau khi đối chiếu chưa có tiền rời hệ
  thống (bản `rejected` chưa từng duyệt/gửi cổng); chạy từng `id`, trong transaction, ghi vào sổ sự cố:

  ```sql
  UPDATE x_refund SET state='cancelled', cancelled_by=rejected_by, cancelled_at=rejected_at, cancel_reason=coalesce(reject_reason,'legacy reject (T-173)') WHERE id=? AND state='rejected' AND return_id IS NOT NULL
  ```

  Phải cập nhật đúng 1 dòng (0 dòng = sai id hoặc không phải bản cũ — dừng). Sau đó mở lại theo `return_id`
  (`POST /admin/x/refunds` `reason: "return"`, `return_id`) — số tiền lấy theo kiểm định. Không dùng câu này cho bản
  ghi mới: từ T-173 server không còn tạo `rejected` cho hoàn theo trả hàng.

- **Không nhả tiền khi cổng CÓ THỂ đã hoàn:** yêu cầu `unknown`/`processing` (timeout, 5xx, đứt mạng — có ngoại lệ
  `refund_unknown`) hoặc `failed` đã gửi cổng (`attempts > 0`) giữ nguyên; khi cổng tắt, `execute`/`cancel` trả 409 và
  không đổi trạng thái. Thoát cần cổng trả lời (cổng bật → `execute` hỏi cùng mã rồi mới gửi lại) — chưa có đường chốt
  tay. ĐỪNG chuyển khoản ngoài hệ thống cho khách trong lúc chờ: nếu cổng đã hoàn là hoàn hai lần; đối chiếu trên cổng
  merchant theo `txn_ref` của đơn trước.
- `late_payment` tự đóng (`detail.resolution = refunded`, `refund_id`) khi tiền của đơn đã hủy được trả lại hết (ledger ròng
  = 0, cổng hoặc tay); hoàn một phần → còn mở. Trên sao kê VNPAY dòng khoản thu này là chênh lệch `late_after_cancel` (gắn
  đúng khoản thu/đơn), dòng hoàn khớp `matched`.
- Attempt (`failed` hoặc `captured`) nhận khoản thu với mã giao dịch KHÁC mã nó đang mang (thông báo thất bại có mã rồi
  tiền về với mã khác; hai giao dịch thành công sau khi đơn đã hủy; hay AT36 — giao dịch thành công thứ hai khi đơn đã
  thu/đã xác nhận; với mọi kết cục của đơn): hệ thống KHÔNG ghi đè mã cũ, mở `payment_unknown` (`detail.reason =
attempt_txn_conflict`, `provider_txn_id` = khoản thu mới, `attempt_provider_txn_no` = mã đang gắn, `attempt_state`,
  `order_state`), bên cạnh ngoại lệ theo trạng thái đơn (`overpayment` nếu đã xác nhận, `late_payment` nếu đã hủy).
  Khoản thu mới không gắn attempt: không hoàn qua cổng được và đối soát không gắn được dòng sao kê vào chính nó (dòng
  cùng `txn_ref` dồn vào khoản thu đầu) → đối chiếu trên cổng merchant theo `txn_ref` + `provider_txn_id` rồi hoàn
  `manual` có chứng từ. Khi `payment_unknown` này còn mở, `auto` tự chọn `manual` (`note` … `(attempt_txn_conflict)`; ở
  sandbox/live ghi cả hai mã: `(attempt_txn_conflict, provider_disabled)`);
  `provider` cho khoản không gắn → 422 `REFUND_METHOD_UNAVAILABLE` ngay lúc tạo. Đóng ngoại lệ sau khi đã hoàn/đối chiếu.

## 8. Deploy

last_drilled: chưa diễn tập. **Hiện trạng thật:** repo có `Dockerfile` (target `backend`, `storefront`), `compose.prod.example.yml` (ví dụ
một máy) và CI `.github/workflows/image.yml` (build + hadolint + Trivy, KHÔNG push) — T-191, D-150: container chỉ là định dạng artefact.
Chưa có registry, workflow deploy hay IaC; hạ tầng production chưa được chọn (chủ dự án — cần tài khoản/khoá thật). Phần dưới là các
bước đã có lệnh thật trong repo, KHÔNG phải quy trình đã chạy trên production (compose mẫu mới chạy thử cục bộ với biến giả, 2026-10-30).

### 8.1 Cơ chế deploy — việc chờ người

Chủ dự án chọn hạ tầng (xem cả §4.5). Khi chọn xong, bổ sung vào mục này: đích deploy, lệnh/pipeline, kho bí mật, nơi ghi SHA đang chạy;
rồi diễn tập deploy + rollback (§5) trên staging và ghi `last_drilled`.

### 8.2 Các bước (lệnh thật, thứ tự bắt buộc)

```bash
set -euo pipefail   # bắt buộc: bước 0 thất bại thì KHÔNG chạy tiếp bước 1
pnpm install --frozen-lockfile
pnpm build   # domain → medusa build (backend) và next build (storefront)
# 0) Cổng backup TRƯỚC db:migrate (DB-MIG-011) — xem "Điều kiện dừng" ngay dưới khối lệnh này; không qua = KHÔNG chạy bước 1.
#    (PITR: kiểm tay theo khối "Đường B" bên dưới; không dán liền bước 1.)
#    Đường A (file, scripts/ops/backup.sh): bản gần nhất ≤ N giờ (mặc định 24 = RPO của pg_dump hằng ngày, §4) và sha256 khớp.
#    $BACKUP_DIR = thư mục nơi cron/job chạy `scripts/ops/backup.sh "$BACKUP_DIR/<tên>.dump"` ghi file (+ .meta). Chưa có bản
#    đủ mới → tạo ngay: DATABASE_URL="$MIGRATION_DATABASE_URL" scripts/ops/backup.sh "$BACKUP_DIR/pre-migrate-$(date -u +%Y%m%dT%H%M%SZ).dump"
# >>> gate-backup (scripts/check-runbook.test.mjs trích đúng khối này giữa hai dấu và chạy thử)
(
  max_s=$(( ${XS_BACKUP_MAX_AGE_HOURS:-24} * 3600 ))
  meta="$(ls -1t "$BACKUP_DIR"/*.meta | head -n 1)"          # không có file → ls lỗi → dừng
  mark="$(sed -n 's/^snapshot_mark_utc=//p' "$meta")"        # giờ DB (UTC) lấy ngay trước khi pg_dump chụp
  want="$(sed -n 's/^sha256=//p' "$meta")"
  [ -n "$mark" ] && [ -n "$want" ] || { echo "DỪNG: $meta thiếu snapshot_mark_utc/sha256" >&2; exit 1; }
  age_s=$(( $(date -u +%s) - $(date -u -d "$mark" +%s) ))
  [ "$age_s" -ge 0 ] && [ "$age_s" -le "$max_s" ] || { echo "DỪNG: bản gần nhất $meta cũ ${age_s} giây (> ${max_s})" >&2; exit 1; }
  [ "$(sha256sum "${meta%.meta}" | cut -d' ' -f1)" = "$want" ] || { echo "DỪNG: sha256 không khớp ${meta%.meta}" >&2; exit 1; }
  echo "OK: backup $meta mốc $mark (${age_s} giây trước)"
) || { echo "DỪNG trước db:migrate: cổng backup không qua" >&2; exit 1; }
# <<< gate-backup
# 1) Migration TRƯỚC khi chạy bản mới (một lần, từ một máy/job duy nhất; bản trước phải chạy được với schema mới).
#    Vai trò DB (T-184, docs/ops/ENV.md mục "Vai trò DB"): hạ tầng tạo xshop_app + xshop_migrator TRƯỚC lần migrate đầu;
#    `db:*` kết nối bằng MIGRATION_DATABASE_URL (xshop_migrator), server/worker bằng DATABASE_URL (xshop_app). Không dùng
#    --skip-links/--skip-scripts ở production; lỡ dùng, hoặc vai trò tạo sau lần migrate đầu (log có WARNING "chưa có vai
#    trò xshop_app") → chạy thêm: psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db-app-grants.sql
cd apps/backend && npx medusa db:migrate
# 2) Backend: hai tiến trình cùng mã, khác chế độ (mỗi tiến trình có đủ biến ở docs/ops/ENV.md)
#    Script `start` bind 127.0.0.1 mặc định (BASE-SEC-010): sau LB / trong container PHẢI đặt HOST=0.0.0.0 cho tiến trình
#    server (không publish cổng DB/Redis); thiếu thì LB không tới được backend. Xem cấu hình hiệu lực (đã che): pnpm --filter @x-shop/backend config:print
MEDUSA_WORKER_MODE=server pnpm --filter @x-shop/backend start   # nhận HTTP (store, admin, IPN, callback GHN)
MEDUSA_WORKER_MODE=worker pnpm --filter @x-shop/backend start   # chạy job định kỳ (outbox, reconcile, expire-holds…)
# 3) Storefront (script `start` cũng bind 127.0.0.1 mặc định: sau LB/container đặt HOST=0.0.0.0)
pnpm --filter @x-shop/storefront start
```

**Đường B của bước 0 — kiểm TAY (không nằm trong khối lệnh trên)**: PITR tự host (WAL archiving; PITR của dịch vụ managed: ghi ảnh chụp/ID cấu hình từ console vào log deploy). Chỉ khi đạt mới chạy bước 1.

```bash
#    Đường B (PITR tự host, WAL archiving; PITR của dịch vụ managed: ghi ảnh chụp/ID cấu hình từ console vào log deploy):
psql "$MIGRATION_DATABASE_URL" -Atc "select current_setting('archive_mode'), coalesce(extract(epoch from now() - last_archived_time)::int, -1), failed_count, coalesce(last_failed_time > last_archived_time, false) from pg_stat_archiver"
#    → cột 1 phải là on|always, cột 2 (tuổi lần archive cuối, giây) trong [0, 900] (RPO 15 phút, §4.1), cột 4 là `f` (lần archive
#      gần nhất không lỗi; cột 3 là tổng lỗi tích luỹ, chỉ để tham khảo).
```

**Điều kiện dừng của bước 0 (migrate không đảo ngược được bằng `db:migrate:down` khi có DDL phá dữ liệu — đường lùi thật là khôi phục, §4.2):**
đạt khi Đường A in `OK` HOẶC Đường B thoả đủ ba điều kiện. DỪNG, không chạy `db:migrate`, báo trực kỹ thuật (§0) khi: không có file `.meta`
nào / bản gần nhất cũ hơn N giờ / sha256 lệch (backup hỏng); `archive_mode=off` hoặc `last_archived_time` rỗng (`-1`) hoặc quá 900 giây hoặc
lần archive gần nhất lỗi; không đọc được cả hai (không kết nối được DB, thiếu quyền) — coi là chưa chứng minh được, không đoán. Chỉ với migration
chỉ thêm (thêm bảng/cột nullable, không DROP/ALTER kiểu/UPDATE hàng loạt) mà người quyết định rollback (§0) ghi lý do vào log deploy mới được
bỏ qua bước 0; mọi trường hợp khác không có ngoại lệ. Ghi kết quả bước 0 (dòng `OK` hoặc đầu ra psql, giờ UTC) vào log deploy.

Production thiếu/sai biến → backend thoát mã 1 và in TÊN biến (không in giá trị): đọc log khởi động trước khi chuyển lưu lượng. Chạy ≥ 2
instance server thì `REDIS_URL` bắt buộc (§3.2.1). File upload/xuất: `FILE_STORAGE=s3` bắt buộc (§8.2b). Không deploy khi đang có sự cố
thanh toán (§1).

#### 8.2c Cùng các bước bằng container (T-191, D-150)

Image chạy đúng các lệnh trên (không thêm hành vi): `backend` = ENTRYPOINT CLI medusa trên `.medusa/server`, lệnh mặc định `start`,
`HOST=0.0.0.0`, `PORT=9000`; server và worker CÙNG image, khác `MEDUSA_WORKER_MODE`; migrate = cùng image, lệnh `db:migrate`.
`storefront` = `next start`. Cả hai chạy uid 1000, `STOPSIGNAL SIGTERM`, có HEALTHCHECK (server `/x/readyz`, worker `/health`, storefront
`/robots.txt`). Mẫu file biến và lệnh chi tiết ở đầu `compose.prod.example.yml`.

```bash
# Build MỘT lần mỗi commit, gắn tag = SHA; promote theo digest (OPS-DEPLOY-001) — registry/pipeline: chờ §8.1.
docker build --target backend -t x-shop-backend:<sha> .
docker build --target storefront -t x-shop-storefront:<sha>-<môi-trường> \
  --build-arg NEXT_PUBLIC_SITE_URL=https://shop.example.vn --build-arg NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_… \
  --build-arg XS_MEDIA_URL=https://media.shop.example.vn   # + NEXT_PUBLIC_ANALYTICS_TRANSPORT nếu dùng
# Đặt XSHOP_BACKEND_IMAGE / XSHOP_STOREFRONT_IMAGE = <registry>/…@sha256:<digest>; file biến backend.env, storefront.env,
# postgres.env, redis.env (không commit; docs/ops/ENV.md).
docker compose -f compose.prod.example.yml up -d postgres redis
docker compose -f compose.prod.example.yml run --rm backend-migrate          # bước 1
docker compose -f compose.prod.example.yml up -d backend-server backend-worker # bước 2
docker compose -f compose.prod.example.yml up -d storefront                  # bước 3
```

- Postgres/Redis không publish cổng (mạng `data` internal — BASE-SEC-010); backend server/storefront chỉ publish lên `127.0.0.1` cho
  reverse proxy TLS (§8.2a). `stop_grace_period: 35s` > `SHUTDOWN_TIMEOUT_MS` (mặc định 25 s): tăng biến này thì tăng theo.
- **Ngoại lệ đã chấp nhận (D-150, Q2 của T-191): image storefront build THEO MÔI TRƯỜNG.** `NEXT_PUBLIC_*` và `XS_MEDIA_URL` được Next
  nhúng lúc build (docs/ops/ENV.md mục Storefront) → staging và production là hai image storefront khác nhau, trái WF-ENV-006/OPS-DEPLOY-001
  ở riêng storefront. Bù lại: build cả hai từ CÙNG commit SHA với cùng lockfile, ghi digest từng môi trường vào log deploy; chỉ tham số build
  công khai khác nhau. Backend không có ngoại lệ: một digest cho mọi môi trường (cấu hình chỉ qua biến lúc chạy).
- CI `image.yml` (không phải required check): HIGH/CRITICAL đã có bản vá = đỏ; chưa có bản vá chỉ in báo cáo; chạy lại hằng tuần.

### 8.2b Lưu trữ file dùng chung giữa các bản sao (T-154, ARC-RES-005)

Provider local của Medusa ghi file lên đĩa của từng máy: ảnh upload ở bản sao A không có ở bản sao B, file xuất do worker ghi không tải được
qua server. Production vì vậy BẮT BUỘC `FILE_STORAGE=s3` (kiểm lúc khởi động: vắng hoặc `local` → thoát mã 1). Biến: `docs/ops/ENV.md`.

Ràng buộc triển khai (chủ dự án làm trước lần deploy đầu có T-154):

1. **Chọn và dựng kho S3-compatible** (cần máy/tài khoản thật — việc của người). Mặc định tự host: **Garage** (AGPL-3.0, Rust, một binary)
   hoặc **SeaweedFS** (Apache-2.0); chạy như dịch vụ riêng, không sửa mã của chúng (AGPL chỉ ràng buộc khi sửa/phân phối lại bản sửa).
   **Không dùng MinIO bản cộng đồng**: repo `minio/minio` ghi "THIS REPOSITORY IS NO LONGER MAINTAINED", bản cộng đồng chỉ còn mã nguồn,
   `dl.min.io` trả 410 "archived and no longer maintained … no security updates" (kiểm 2026-10-27). Dịch vụ quản lý (S3, R2…) cũng được —
   cần tài khoản/khoá của chủ dự án.
2. **Hai bucket**: `S3_BUCKET` (công khai) có policy đọc nặc danh `s3:GetObject` (hoặc website endpoint/CDN); `S3_PRIVATE_BUCKET` KHÔNG có
   policy công khai/website/CDN. Kiểm sau khi dựng: `curl -sI <S3_ENDPOINT>/<S3_PRIVATE_BUCKET>/x` (không chữ ký) phải 403.
3. **Một khoá truy cập riêng cho backend**, chỉ quyền `s3:GetObject`/`s3:PutObject`/`s3:DeleteObject` trên object và `s3:ListBucket` trên
   CẢ HAI bucket; không quyền quản trị kho. Thiếu `s3:ListBucket` thì AWS trả 403 (không phải 404) cho khoá không tồn tại → route tải file
   private trả 500 thay vì 404 (backend log "Kho S3 từ chối đọc (403) khoá hợp lệ…"). Đặt `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` vào kho bí mật.
4. **Mọi tiến trình dựng File Module có cùng biến S3**: server (mọi bản sao), worker, `medusa db:migrate`, script `medusa exec`. Không cần
   volume dùng chung cho file nữa (PRIVATE_UPLOAD_DIR không dùng khi `s3` — đặt kèm là lỗi khởi động).
5. **TLS**: production đòi `https://` cho `S3_ENDPOINT` và `S3_FILE_URL` (file private mang PII đi qua kết nối này).
6. **`MEDUSA_BACKEND_URL`** bắt buộc, https (URL tải file private trong thông báo xuất).
7. **Storefront**: đặt `XS_MEDIA_URL` = `S3_FILE_URL` (https ở production) TRƯỚC `next build` — `images.remotePatterns` được đóng vào bản build
   (`apps/storefront/src/lib/env/media.ts`); đổi host ảnh = build lại storefront. Host này phải phân giải ra IP công khai (bộ chặn SSRF của
   `next/image` bật ở production). CSP `img-src` không cần nới: ảnh đi qua `/_next/image` cùng origin.
8. **Chuyển file cũ** (nếu đã chạy local trước đó): chép `static/<khoá>` → bucket công khai, `PRIVATE_UPLOAD_DIR/private-*` → bucket private
   (cùng tên khoá); URL ảnh đã lưu trong sản phẩm vẫn trỏ `/static/…` cũ — cập nhật hoặc giữ `/static` phục vụ tạm tới khi thay.

Đường lùi: đặt lại biến về bản trước + triển khai lại bản trước T-154 (chỉ được khi một bản sao, vì local không dùng chung); file đã ghi ở
kho vẫn còn — chép ngược về `static/`/PRIVATE_UPLOAD_DIR theo cùng tên khoá. Sức khoẻ kho chưa nằm trong `/x/health` (chưa làm): kho lỗi →
upload/xuất/tải file private trả 5xx, phần còn lại của shop chạy bình thường. Mọi lời gọi kho có hạn tường minh (`S3_TIMEOUTS` trong
`apps/backend/src/lib/infra/timeouts.ts`: kết nối 5 s, request 30 s, socket im lặng 30 s; SDK thử lại 3 lần) — kho treo không làm treo request.

Bằng chứng: test tích hợp `upload` mặc định chạy trên kho S3 GIẢ trong tiến trình (`integration-tests/helpers/fake-s3.ts` — không multipart,
không kiểm chữ ký SigV4, không policy/ACL thật). Chưa đủ để coi BE-FILE-004/ARC-RES-005 đã đạt: chạy lại suite với kho thật đã dựng ở bước 1
(`XS_TEST_S3_ENDPOINT…`, `docs/ops/ENV.md`) và lưu kết quả trước khi tick.

### 8.2a Reverse proxy cho luồng mời admin qua dashboard (T-138, D-075)

Link mời admin mở dashboard ở `/app` với `invite_token` trong query; trang đăng ký của dashboard gọi API cùng origin. Reverse proxy phải:

- giữ nguyên header `Host` (không viết lại) — kiểm tra origin/URL mời dựa vào đó;
- phục vụ dashboard (`/app`) CÙNG origin với backend (cùng scheme + host + cổng);
- không đặt `Referrer-Policy` làm mất query cho đường `/app` (`no-referrer`, `origin` bị cấm; giữ mặc định trình duyệt hoặc `same-origin`/`strict-origin-when-cross-origin`);
- nếu buộc phải khác origin: làm trang mời riêng, tự gửi `invite_token` tới backend (không dựa vào query/Referer của dashboard).

### 8.3 Kiểm sau deploy (smoke) và theo dõi

- Tay (chưa có job tự động — WF-REL-007 còn mở): `curl -fsS "$MEDUSA_BACKEND_URL/x/health"`; mở trang chủ và một trang sản phẩm; tạo giỏ và gọi
  báo giá; log khởi động không có lỗi biến môi trường.
- Phiên bản khớp tag (D-050): `/x/health` cố ý không lộ phiên bản; dùng `GET /admin/x/version` (cần admin có `report.read`; trả
  `{version, commit?, built_at?}` từ `XS_RELEASE_VERSION`/`XS_RELEASE_COMMIT`/`XS_BUILT_AT`, vắng thì version trong package.json — ENV.md):
  `XS_SMOKE_BASE_URL=https://… XS_SMOKE_ADMIN_TOKEN=<từ kho bí mật> node scripts/load/smoke.mjs --expect-version <tag>` (exit 0 khớp,
  1 lệch/401/403, 2 thiếu cấu hình). Chỉ đọc, không tạo tải; token không đặt trên dòng lệnh. Pipeline đặt `XS_RELEASE_*` lúc chạy image.
- Kịch bản có sẵn, chạy tay trên môi trường tải riêng: `pnpm load:smoke` (T-036) — không chạy lên production.
- Cửa sổ theo dõi 30 phút theo ngưỡng §5; chưa có dashboard/cảnh báo thật cho tới khi chọn hạ tầng.

## 9. Xoay secret

last_drilled: chưa diễn tập. Nguyên tắc: tạo giá trị mới ngẫu nhiên (`openssl rand -base64 48`), đặt vào kho bí mật, khởi động lại server +
worker (và storefront nếu biến của nó đổi), kiểm hiệu ứng, rồi thu hồi giá trị cũ. Không dán giá trị vào lệnh/log/ticket. Nhịp định kỳ đề
xuất: 12 tháng cho khoá ký, và NGAY khi nghi lộ (§10). Hiệu ứng khi đổi (theo mã):

| Biến                                                      | Hiệu ứng khi đổi                                                                                                                                                                               | Thủ tục                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`, `COOKIE_SECRET`                             | phiên admin hiện có hết hiệu lực — đăng nhập lại                                                                                                                                               | đổi → restart server+worker; hai biến phải khác nhau                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ORDER_LOOKUP_SECRET`                                     | mọi liên kết tra cứu và phiên xem đơn của khách đang có mất hiệu lực (khách tra cứu lại)                                                                                                       | đổi → restart; không ảnh hưởng đơn/dữ liệu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `AUTH_MFA_ENCRYPTION_KEY`                                 | TOTP đã đăng ký không giải mã được — mọi admin đăng ký lại TOTP (`docs/ops/ENV.md`). Lệnh re-encrypt giữ nguyên TOTP: không có trong repo (Medusa có hay không: chưa xác minh)                 | đặt khoá mới → từng admin đăng ký lại TOTP; trong lúc đó quyền nhạy cảm (hoàn tiền, quản lý user…) không dùng được                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `VNPAY_HASH_SECRET`                                       | chữ ký IPN/return/querydr đổi theo khoá cổng; IPN ký bằng khoá mới tới TRƯỚC khi env đổi bị từ chối chữ ký                                                                                     | **Thứ tự không hở** (backend ký bằng `VNPAY_HASH_SECRET` = current, xác minh cả current lẫn `VNPAY_HASH_SECRET_PREVIOUS`, T-099): (1) `VNPAY_HASH_SECRET`=khoá cũ, `VNPAY_HASH_SECRET_PREVIOUS`=khoá MỚI → restart (đã nhận được chữ ký khoá mới, vẫn ký bằng khoá cũ); (2) đổi khoá ở cổng merchant VNPAY; (3) `VNPAY_HASH_SECRET`=khoá mới, `VNPAY_HASH_SECRET_PREVIOUS`=khoá cũ → restart (ký bằng khoá mới, IPN/querydr còn ký khoá cũ vẫn qua); (4) theo dõi log `vnpay_secret_previous_used` (cảnh báo mỗi lần xác minh bằng khoá trước, không chứa khoá/chữ ký; T-139) về 0 liên tục ≥ 24 giờ (chính sách gửi lại IPN của VNPAY: chưa xác minh) rồi bỏ `VNPAY_HASH_SECRET_PREVIOUS`, restart. Lưu ý: ở bước 1 log này xuất hiện khi VNPAY đã ký khoá mới; chỉ dùng làm tín hiệu thu hồi sau bước 3. Hiện log chỉ ghi ở IPN (return/querydr chưa có). Querydr bù cho `payment_attempt` mở, xem `ops_exception` `webhook_rejected` (§1). VNPAY có cho hai khoá song song phía cổng không: (chưa xác minh) |
| `GHN_TOKEN` (+ `GHN_SHOP_ID` nếu đổi shop)                | gọi GHN thất bại tới khi khớp                                                                                                                                                                  | tạo token mới ở GHN → đổi env → restart worker+server; vận đơn timeout xử lý như §2; callback GHN không chữ ký nên không bị ảnh hưởng                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CATALOG_REVALIDATE_SECRET` (backend + storefront, T-142) | webhook vô hiệu hoá cache catalog bị 401 trong lúc hai phía lệch khoá → outbox `dead` + MỘT ngoại lệ `outbox_dead` đang mở (ưu tiên thường); giá/tồn trên storefront tươi lại theo TTL 60 giây | đặt khoá mới ở storefront → restart storefront → đặt ở backend → restart server+worker; ngoại lệ `outbox_dead` loại `catalog.revalidate` trong khoảng lệch: đóng, không redrive (dữ liệu đã tươi theo TTL; lần gửi thành công đầu tiên sau lỗi tạm tự gửi bù tag `catalog`). Production: `CATALOG_REVALIDATE_URLS` chỉ nhận https (D-117) — URL nội bộ từng bản storefront cần TLS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Mật khẩu trong `DATABASE_URL`, `REDIS_URL`                | kết nối mới thất bại tới khi restart                                                                                                                                                           | tạo vai trò/mật khẩu mới → cập nhật env → restart → thu hồi cái cũ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` (T-154)       | upload/xuất/tải file private lỗi tới khi khớp; ảnh công khai vẫn đọc được (nặc danh)                                                                                                           | tạo khoá mới cùng quyền trên hai bucket ở kho → đổi env mọi tiến trình → restart server+worker → kiểm upload ảnh + tải một file xuất → thu hồi khoá cũ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Khoá email/SMS provider                                   | thông báo không gửi (rơi vào `outbox_event` `failed`, thử lại — §12)                                                                                                                           | thủ tục theo nhà cung cấp thật (xem `docs/privacy/processors.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 10. Lộ bí mật

last_drilled: chưa diễn tập. Sự cố bảo mật = SEV1: bảo toàn bằng chứng (chép log liên quan sang nơi chỉ-đọc TRƯỚC khi xoay), thu hồi/xoay,
rà log trong khoảng lộ, ghi sự cố, đánh giá nghĩa vụ thông báo (Luật 91/2025/QH15 — chưa xác minh văn bản gốc; quy trình đầy đủ ở
`docs/ops/runbooks/data-breach.md`). Xoá commit KHÔNG đủ: coi mọi khoá từng nằm trong lịch sử git là đã lộ.

| Khoá                                                | Thu hồi / xoay ngay                                                                                                                     | Rà log trong khoảng lộ                                                                                                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VNPAY_HASH_SECRET`                                 | đổi ở cổng merchant VNPAY (liên hệ VNPAY nếu nghi bị dùng), đặt khoá mới vào env, restart (§9). Kẻ có khoá giả được IPN "đã thanh toán" | `webhook_inbox` (`verified`, `result`) và `payment_ledger` trong khoảng lộ: mọi `capture` không có giao dịch ở cổng merchant → mở `ops_exception`, giữ đơn, chạy querydr; hoàn tiền nếu đã giao nhầm                               |
| `GHN_TOKEN`                                         | vô hiệu hoá token ở GHN, tạo token mới, đổi env, restart                                                                                | vận đơn lạ ở cổng GHN so với `shipment`; `shipment_event` bất thường                                                                                                                                                               |
| `JWT_SECRET`, `COOKIE_SECRET`                       | đổi cả hai, restart: toàn bộ phiên admin bị huỷ                                                                                         | `audit_log` (bất biến — trigger chặn sửa/xoá) lọc theo `actor_id`/`action` trong khoảng lộ; kiểm tài khoản admin mới và thay đổi quyền                                                                                             |
| `AUTH_MFA_ENCRYPTION_KEY`                           | đổi khoá (mọi TOTP đăng ký lại, §9); coi bí mật TOTP đã lộ nếu lộ cả DB                                                                 | `audit_log` đăng nhập/MFA bất thường                                                                                                                                                                                               |
| `ORDER_LOOKUP_SECRET`                               | đổi, restart: mọi liên kết/phiên xem đơn mất hiệu lực                                                                                   | log truy cập `/store/x/orders/*` trong khoảng lộ                                                                                                                                                                                   |
| `CATALOG_REVALIDATE_SECRET`                         | xoay như §9. Kẻ có khoá chỉ ép storefront nạp lại cache catalog (tải thêm lên backend, không đổi dữ liệu)                               | log truy cập `POST /api/revalidate` của storefront (tần suất bất thường)                                                                                                                                                           |
| `DATABASE_URL` / `REDIS_URL`                        | đổi mật khẩu, đóng cổng ra ngoài, restart                                                                                               | log truy cập DB của nhà cung cấp hạ tầng; `audit_log`                                                                                                                                                                              |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (T-154) | thu hồi khoá ở kho S3, tạo khoá mới cùng quyền trên hai bucket, đổi env, restart server+worker (§9)                                     | log truy cập của kho trong khoảng lộ: `GetObject` trên bucket private (file xuất có PII — đánh giá nghĩa vụ thông báo theo `docs/ops/runbooks/data-breach.md`), `PutObject`/`DeleteObject` lạ trên cả hai bucket (ảnh bị thay/xoá) |
| Khoá email/SMS provider                             | thu hồi ở nhà cung cấp, tạo khoá mới                                                                                                    | lịch sử gửi ở nhà cung cấp so với `outbound_message`                                                                                                                                                                               |

Sau xử lý: ghi post-mortem vào `docs/ops/incidents/` (sổ sự cố; quy trình ở `docs/ops/INCIDENT-RESPONSE.md`) — nguyên nhân gốc, khoảng lộ, khoá đã xoay, dữ liệu bị chạm, hàng rào mới
(vd quét bí mật bổ sung). Đầu mối pháp lý: [chủ dự án điền].

## 11. Dữ liệu staging / preview

last_drilled: chưa diễn tập (chưa có môi trường staging/preview).

Chính sách: staging, preview và máy dev CHỈ dùng dữ liệu tổng hợp. **Cấm** copy, dump hoặc khôi phục dữ liệu production (PII khách, đơn, vận
đơn, log) vào staging/preview/dev — kể cả "tạm thời để tái hiện lỗi" (Luật 91/2025/QH15 — chưa xác minh điều khoản). Nguồn dữ liệu cho phép:
`apps/backend/src/scripts/seed*.ts`, `scripts/ops/drill/seed-*.sql`, `scripts/load/dataset.mjs` (đều tổng hợp). Tái hiện lỗi từ production:
dựng ca bằng dữ liệu tổng hợp cùng hình dạng. Diễn tập khôi phục (§4) dùng seed tổng hợp, không dùng dump production. Hiện CHƯA có môi trường
staging, script ẩn danh hoá hay quét PII mẫu.

## 12. Outbox: sự kiện `dead` — kiểm tra và redrive

last_drilled: chưa diễn tập trên DB vận hành (câu bước 3 chạy trong test tích hợp `outbox-redrive`, đọc thẳng từ mục này; chưa có hạn giữ/dọn riêng cho `dead` — không job nào xoá `outbox_event`).

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
   \set k '<event_key>'
   -- redrive-one
   UPDATE outbox_event SET state = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL, updated_at = now()
    WHERE event_key = :'k' AND state = 'dead' AND deleted_at IS NULL;
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

## 14. Ngoại lệ `job_circuit_open` — job nền tạm dừng gọi dịch vụ ngoài (circuit breaker chi phí)

last_drilled: chưa diễn tập (test đơn vị `breaker` + test tích hợp `outbox-breaker`).

Mô hình thật (`apps/backend/src/lib/outbox/breaker.ts`, T-097, OPS-COST-004): dispatcher outbox chia breaker theo adapter
(`outbox.notify` = mọi thông báo email/SMS; loại khác `outbox.<loại sự kiện>`); job `x-expire-holds` có breaker `vnpay.querydr` cho lời
gọi VNPAY querydr (T-161) — lỗi tạm = timeout/mạng/adapter ném/HTTP 5xx·408·429 (mỗi đơn tính một); khi breaker không cho gọi, đơn
quá hạn giữ hàng KHÔNG bị hủy mà xử lý như `unknown` (giữ hàng, attempt `unknown`, ngoại lệ `payment_unknown` với `detail.reason` =
`breaker_open` | `breaker_probing` | `breaker_throttled` | `breaker_budget_exhausted`, xem §1) và được hỏi lại ở lượt chạy sau khi
breaker đóng; lượt thử half-open xoay vòng giữa các đơn quá hạn (theo `trip_count`, đơn vừa lỗi — `last_failed_event_id` — luôn xuống cuối) nên một đơn lỗi ổn định không giữ breaker mở mãi;
ngân sách ngày 144 000 = trần vật lý của lịch chạy nên chỉ mở vì lỗi. Trạng thái ở bảng `job_breaker` (dùng chung mọi bản
sao), ngân sách lượt gọi theo ngày UTC ở `rate_limit_counter` (bucket `breaker.budget:<breaker>`). Ngưỡng trong code
(`OUTBOX_BREAKER_POLICY`, `OUTBOX_RUN_LIMITS` — đổi qua review): mỗi lượt chạy tối đa 100 sự kiện / 50 lượt gọi; 5 sự kiện khác nhau
lỗi tạm liên tiếp → mở 5 phút; ngân sách ngày `outbox.notify` 3 000, loại khác 10 000 — 80 % log WARN, 90 % bóp còn 5 lượt gọi/lượt
chạy, vượt 100 % → mở tới 00:00 UTC hôm sau. **Ngân sách con** (T-162, `subBudgets`): thông báo do khách tự kích
(`order.lookup_link`) tối đa 1 000 lượt/ngày NẰM TRONG 3 000 của `outbox.notify` (bucket `breaker.budget:outbox.notify.customer_triggered`);
vượt → chỉ hoãn loại đó tới 00:00 UTC (không có dòng `job_breaker`, breaker `outbox.notify` không đổi — thư xác nhận/giao hàng vẫn gửi)
và mở ngoại lệ này với `detail.breaker = 'outbox.notify.customer_triggered'`; thường là lạm dụng tra cứu đơn → kiểm giới hạn tra cứu
(5 lượt/giờ/SĐT) và nguồn yêu cầu trước khi nâng trần. Breaker mở → mở ngoại lệ này (ưu tiên `high`, owner `owner`, một ngoại lệ đang mở mỗi
breaker). **Không mất sự kiện**: sự kiện bị hoãn vẫn `pending`/`failed` trong `outbox_event`, `attempts` không đổi, `next_attempt_at`
= hết nguội. Hết nguội → đúng một lượt thử (half-open); thành công hoặc lỗi vĩnh viễn (dịch vụ đã trả lời, D-111) → đóng, lỗi tạm → mở thêm một kỳ.
**Lỗi DB khi đọc/ghi breaker hoặc đếm ngân sách → fail-closed**: lượt chạy job lỗi (chỉ có log lỗi của job `x-outbox-dispatch`
hoặc `x-expire-holds` — KHÔNG có ngoại lệ vận hành), không gọi dịch vụ ngoài; outbox: sự kiện đang xét giữ lease nhận 60 giây rồi được
nhận lại (không tăng `attempts`); expire-holds: không querydr, không hủy — đơn vẫn `awaiting_payment` quá hạn, giữ hàng tới lượt chạy
sau; nếu đã nhận lượt thử thì breaker ở `half_open` tới `probe_until` rồi bản sao khác thử. Không cần thao tác tay — xử lý sự cố DB
trước.

1. Xem breaker và lý do (`detail.reason`: `consecutive_failures` | `budget_exhausted`):

   ```sql
   SELECT breaker_key, state, trip_reason, consecutive_failures, open_until, probe_until, trip_count, updated_at
     FROM job_breaker WHERE state <> 'closed' ORDER BY updated_at DESC;
   SELECT bucket, window_start, count FROM rate_limit_counter WHERE bucket LIKE 'breaker.budget:%' ORDER BY window_start DESC;
   ```

   Log: `[breaker] <breaker>: … — dừng gọi tới <giờ>`; cảnh báo ngân sách `[breaker] <breaker>: đã dùng N/M lượt ngân sách`.

2. `consecutive_failures`: kiểm nhà cung cấp (trang trạng thái, khoá API, hạn mức) và `last_error` của sự kiện gần nhất
   (`SELECT event_key, attempts, last_error FROM outbox_event WHERE state = 'failed' ORDER BY updated_at DESC LIMIT 20;`). Không cần
   làm gì để mở lại — breaker tự thử khi hết nguội; lỗi kéo dài thì breaker cứ mở lại từng kỳ, sự kiện không vào `dead` vì bị hoãn.
3. `budget_exhausted`: số lượt gọi bất thường (vòng lặp gửi lại, sự kiện bị sinh hàng loạt) → tìm nguồn trước
   (`SELECT type, count(*) FROM outbox_event WHERE created_at > now() - interval '1 day' GROUP BY type;`). Lưu lượng thật tăng → nâng
   ngân sách bằng PR sửa `OUTBOX_BREAKER_POLICY` (có review), không sửa DB.
4. Đã chắc nguyên nhân hết và cần gửi ngay (không chờ hết nguội): đóng breaker, rồi đưa sự kiện đã hoãn của breaker đó về hạn ngay
   (không làm bước sau thì chúng được gửi khi tới `next_attempt_at` cũ). **Không kéo sự kiện đang được giữ lease**: không có cột
   lease riêng — lúc nhận, dispatcher đặt `next_attempt_at = now + 60 s` (`OUTBOX_POLICY.claimLeaseMs`), và gửi thông báo KHÔNG
   chống gửi đôi khi hai bản cùng gửi một lúc (`outbound_message` đang `sending` vẫn cho giữ chỗ lại). Vì vậy chỉ kéo sự kiện có
   `next_attempt_at` xa hơn một lease (chắc chắn không phải lease đang chạy); phần còn lại tự tới hạn trong ≤ 60 giây —

   ```sql
   UPDATE job_breaker SET state = 'closed', consecutive_failures = 0, last_failed_event_id = NULL, open_until = NULL,
          probe_until = NULL, updated_at = now() WHERE breaker_key = '<breaker>';
   -- outbox.notify: type IN ('order.placed_pending', 'order.confirmed', 'order.lookup_link', 'shipment.shipped')
   UPDATE outbox_event SET next_attempt_at = now(), updated_at = now()
    WHERE state IN ('pending', 'failed') AND type IN ('<loại>') AND next_attempt_at > now() + interval '60 seconds';
   ```

   (với `budget_exhausted` thì bộ đếm ngày vẫn còn — lượt gọi kế tiếp sẽ mở lại; chỉ làm khi đã nâng ngân sách).

5. Riêng `detail.breaker = 'vnpay.querydr'` (job `x-expire-holds`): đơn bị hoãn có ngoại lệ `payment_unknown` lý do `breaker_*`;
   đơn lỗi thật có lý do `timeout`/`network`/`http_5xx`/`adapter_error:…` —

   ```sql
   SELECT detail->>'reason' AS reason, count(*) FROM ops_exception
    WHERE kind = 'payment_unknown' AND state IN ('open', 'in_progress') AND detail->>'source' = 'expire-holds' GROUP BY 1;
   ```

   KHÔNG hủy tay các đơn này (§1). Cổng đã hồi phục (querydr thủ công cho vài `txn_ref` trả lời bình thường) → đóng breaker bằng câu
   `UPDATE job_breaker …` ở bước 4 với `breaker_key = 'vnpay.querydr'` (không có bước kéo outbox); lượt `x-expire-holds` kế tiếp
   (≤ 1 phút) hỏi lại và xác nhận/hủy đúng từng đơn — đơn bị hoãn chỉ lùi 1 phút (không tăng backoff); đơn từng nhận lỗi tạm
   (`timeout`/`network`/…) đang backoff theo đơn (T-164, §1) được hỏi khi tới `next_check_at` (≤ 60 phút) — cần ngay thì đặt
   `next_check_at = NULL` như §1. Sau đó đóng các `payment_unknown` lý do `breaker_*` của đơn đã có kết cục.

6. Đóng ngoại lệ kèm ghi chú nguyên nhân (Admin chưa có nút đóng):

   ```sql
   UPDATE ops_exception SET state = 'resolved', updated_at = now()
    WHERE id = '<id>' AND kind = 'job_circuit_open' AND state IN ('open', 'in_progress');
   ```

   Breaker mở lại sau khi đóng → ngoại lệ mới; lặp lại nhiều lần trong ngày → leo thang cho kỹ thuật (§0).
