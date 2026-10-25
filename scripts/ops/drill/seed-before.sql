-- Dữ liệu nghiệp vụ TỔNG HỢP cho diễn tập restore (scripts/ops/restore-drill.sh) — không có dữ liệu khách thật
-- (email/SĐT dùng miền .invalid / số giả). Ghi vào DB nguồn TRƯỚC mốc sao lưu; mọi mốc thời gian lùi về quá khứ
-- (≥ 70 phút) để không rơi vào cửa sổ đối chiếu "sau mốc" (mốc − biên an toàn).
--
-- Tình huống có mặt lúc snapshot (id cố định — integration-tests/ops/redis-loss-drill.ts và restore-drill.sh dựa vào):
--   order_drill_paid    VNPAY đã thu (PA_DRILL_PAID + ledger); outbox order.confirmed còn `pending` NHƯNG email đã gửi
--                       (outbound_message `sent`) — worker chết sau khi gửi, trước khi đánh dấu outbox → phải dedupe.
--                       Vận đơn XS-DRILL-PAID-S1 tạo timeout (provider_order_code NULL) → cần tra hãng.
--   order_drill_await   VNPAY `pending` (PA_DRILL_PENDING) — IPN về SAU mốc (seed-after.sql).
--   order_drill_unknown VNPAY `unknown` (PA_DRILL_UNKNOWN) + ops_exception payment_unknown.
--   order_drill_cod     COD `placed`, outbox order.placed_pending `pending` chưa gửi; vận đơn XS-DRILL-COD-S1 đã có mã hãng.
--   chk_drill_stale     checkout_attempt `preparing` quá lease (submit chết) giữ mã DRILL10 → reconcile-attempts bù trừ.
BEGIN;

INSERT INTO checkout_quote (id, cart_id, cart_version, payment_method, address, breakdown, total, expires_at,
                            created_at, updated_at)
VALUES ('cqt_drill_1', 'cart_drill_paid', 1, 'vnpay', '{"province":"Hà Nội","ward":"Phường Diễn Tập"}',
        '{"subtotal":320000,"shipping":30000,"discount":0,"total":350000}', 350000,
        now() - interval '110 minutes', now() - interval '2 hours', now() - interval '2 hours');

INSERT INTO cart_version (id, cart_id, version, fingerprint, frozen_by_attempt, created_at, updated_at)
VALUES ('cver_drill_stale', 'cart_drill_stale', 1, 'fp-drill-stale', 'chk_drill_stale',
        now() - interval '70 minutes', now() - interval '70 minutes');

INSERT INTO checkout_attempt (id, cart_id, cart_version, idempotency_scope, idempotency_key, payload_hash, quote_id,
                              state, order_id, payment_method, lease_until, created_at, updated_at)
VALUES
  ('chk_drill_paid', 'cart_drill_paid', 1, 'drill', 'idem-paid', 'h-paid', 'cqt_drill_1', 'ready',
   'order_drill_paid', 'vnpay', now() - interval '119 minutes', now() - interval '2 hours', now() - interval '2 hours'),
  ('chk_drill_await', 'cart_drill_await', 1, 'drill', 'idem-await', 'h-await', 'cqt_drill_1', 'ready',
   'order_drill_await', 'vnpay', now() - interval '99 minutes', now() - interval '100 minutes',
   now() - interval '100 minutes'),
  ('chk_drill_unknown', 'cart_drill_unknown', 1, 'drill', 'idem-unknown', 'h-unknown', 'cqt_drill_1', 'ready',
   'order_drill_unknown', 'vnpay', now() - interval '99 minutes', now() - interval '100 minutes',
   now() - interval '100 minutes'),
  ('chk_drill_cod', 'cart_drill_cod', 1, 'drill', 'idem-cod', 'h-cod', 'cqt_drill_1', 'ready',
   'order_drill_cod', 'cod', now() - interval '89 minutes', now() - interval '90 minutes',
   now() - interval '90 minutes'),
  ('chk_drill_stale', 'cart_drill_stale', 1, 'drill', 'idem-stale', 'h-stale', 'cqt_drill_1', 'preparing',
   NULL, 'cod', now() - interval '10 minutes', now() - interval '70 minutes', now() - interval '70 minutes');

INSERT INTO order_finance (id, order_id, display_ref, checkout_attempt_id, cart_id, state, total, payment_method,
                           hold_expires_at, cod_confirm_by, policy_version, quote, address, contact, created_at,
                           updated_at)
VALUES
  ('ofin_drill_paid', 'order_drill_paid', 'XS-DRILL-PAID', 'chk_drill_paid', 'cart_drill_paid', 'confirmed', 350000,
   'vnpay', NULL, NULL, 'drill-v1', '{"total":350000}', '{"province":"Hà Nội"}',
   '{"name":"Khách Diễn Tập","email":"drill-paid@example.invalid"}', now() - interval '2 hours',
   now() - interval '115 minutes'),
  ('ofin_drill_await', 'order_drill_await', 'XS-DRILL-AWAIT', 'chk_drill_await', 'cart_drill_await',
   'awaiting_payment', 420000, 'vnpay', now() + interval '30 minutes', NULL, 'drill-v1', '{"total":420000}',
   '{"province":"Đà Nẵng"}', '{"name":"Khách Chờ Trả","email":"drill-await@example.invalid"}',
   now() - interval '100 minutes', now() - interval '100 minutes'),
  ('ofin_drill_unknown', 'order_drill_unknown', 'XS-DRILL-UNKNOWN', 'chk_drill_unknown', 'cart_drill_unknown',
   'awaiting_payment', 510000, 'vnpay', now() - interval '80 minutes', NULL, 'drill-v1', '{"total":510000}',
   '{"province":"Cần Thơ"}', '{"name":"Khách Chưa Rõ","email":"drill-unknown@example.invalid"}',
   now() - interval '100 minutes', now() - interval '80 minutes'),
  ('ofin_drill_cod', 'order_drill_cod', 'XS-DRILL-COD', 'chk_drill_cod', 'cart_drill_cod', 'placed', 200000, 'cod',
   NULL, now() + interval '2 hours', 'drill-v1', '{"total":200000}', '{"province":"TP. Hồ Chí Minh"}',
   '{"name":"Khách COD","phone":"0900000000"}', now() - interval '90 minutes', now() - interval '90 minutes');

INSERT INTO payment_attempt (id, order_id, provider, txn_ref, amount, state, expires_at, provider_txn_no, created_at,
                             updated_at)
VALUES
  ('payatt_drill_paid', 'order_drill_paid', 'vnpay', 'PA_DRILL_PAID', 350000, 'captured',
   now() - interval '105 minutes', 'VNP_PAID', now() - interval '2 hours', now() - interval '115 minutes'),
  ('payatt_drill_pending', 'order_drill_await', 'vnpay', 'PA_DRILL_PENDING', 420000, 'pending',
   now() + interval '30 minutes', NULL, now() - interval '100 minutes', now() - interval '100 minutes'),
  ('payatt_drill_unknown', 'order_drill_unknown', 'vnpay', 'PA_DRILL_UNKNOWN', 510000, 'unknown',
   now() - interval '80 minutes', NULL, now() - interval '100 minutes', now() - interval '80 minutes');

INSERT INTO payment_ledger (id, order_id, kind, amount, provider, provider_txn_id, state, created_at, updated_at)
VALUES ('pled_drill_paid', 'order_drill_paid', 'capture', 350000, 'vnpay', 'VNP_PAID', 'succeeded',
        now() - interval '115 minutes', now() - interval '115 minutes');

INSERT INTO webhook_inbox (id, provider, event_key, source, payload, payload_hash, verified, result, processed_at,
                           created_at, updated_at)
VALUES ('whin_drill_paid', 'vnpay', 'vnpay:PA_DRILL_PAID:00', 'ipn', '{"vnp_TxnRef":"PA_DRILL_PAID"}', 'hash-paid',
        true, '{"outcome":"paid"}', now() - interval '115 minutes', now() - interval '115 minutes',
        now() - interval '115 minutes');

INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, attempts, next_attempt_at, created_at,
                          updated_at)
VALUES
  ('obx_drill_paid', 'drill:order.confirmed:order_drill_paid', 'order_drill_paid', 'order.confirmed',
   '{"order_id":"order_drill_paid"}', 'pending', 0, now() - interval '115 minutes', now() - interval '115 minutes',
   now() - interval '115 minutes'),
  ('obx_drill_cod', 'drill:order.placed_pending:order_drill_cod', 'order_drill_cod', 'order.placed_pending',
   '{"order_id":"order_drill_cod","payment_method":"cod"}', 'pending', 0, now() - interval '90 minutes',
   now() - interval '90 minutes', now() - interval '90 minutes');

INSERT INTO outbound_message (id, message_key, aggregate_id, template, channel, recipient_masked, adapter, live, state,
                              attempts, sent_at, created_at, updated_at)
VALUES ('omsg_drill_paid', 'notify:drill:order.confirmed:order_drill_paid:email', 'order_drill_paid',
        'order.confirmed', 'email', 'd***@example.invalid', 'log', false, 'sent', 1, now() - interval '114 minutes',
        now() - interval '114 minutes', now() - interval '114 minutes');

INSERT INTO ops_exception (id, kind, dedupe_key, order_id, amount, state, priority, due_at, detail, created_at,
                           updated_at)
VALUES ('opx_drill_unknown', 'payment_unknown', 'payment_unknown:order_drill_unknown:payatt_drill_unknown',
        'order_drill_unknown', 510000, 'open', 'high', now() - interval '50 minutes',
        '{"txn_ref":"PA_DRILL_UNKNOWN","source":"expire-holds"}', now() - interval '80 minutes',
        now() - interval '80 minutes');

INSERT INTO coupon_usage (id, promotion_code, promotion_id, checkout_attempt_id, order_id, state, created_at,
                          updated_at)
VALUES ('cpu_drill_stale', 'DRILL10', NULL, 'chk_drill_stale', NULL, 'held', now() - interval '70 minutes',
        now() - interval '70 minutes');

INSERT INTO shipment (id, order_id, client_order_code, provider, provider_order_code, state, cod_amount, payer,
                      created_by, created_at, updated_at)
VALUES
  ('shp_drill_cod', 'order_drill_cod', 'XS-DRILL-COD-S1', 'ghn', 'GHN_DRILL_COD', 'picking', 200000, 'recipient',
   'drill', now() - interval '85 minutes', now() - interval '85 minutes'),
  ('shp_drill_timeout', 'order_drill_paid', 'XS-DRILL-PAID-S1', 'ghn', NULL, 'unfulfilled', 0, 'shop', 'drill',
   now() - interval '110 minutes', now() - interval '110 minutes');

COMMIT;
