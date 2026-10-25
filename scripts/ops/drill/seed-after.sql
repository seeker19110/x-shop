-- Giao dịch xảy ra SAU mốc sao lưu (ghi vào DB nguồn sau pg_dump) — mô phỏng việc đã diễn ra ở cổng thanh toán/hãng
-- vận chuyển nhưng mất khỏi DB khôi phục. Đối chiếu sau restore phải tìm ra ĐÚNG các mục này (restore-drill.sh bước 4):
--   PA_DRILL_PENDING   IPN về sau mốc: pending → captured (+ ledger, đơn → confirmed)   → DB khôi phục vẫn `pending`
--   PA_DRILL_AFTER_1   đơn mới, khách mở cổng VNPAY (pending)                           → DB khôi phục không có
--   PA_DRILL_AFTER_2   đơn mới đã thu tiền (+ ledger, inbox, outbox)                     → DB khôi phục không có
--   XS-DRILL-AFTER-S1  vận đơn GHN tạo sau mốc                                          → DB khôi phục không có
BEGIN;

UPDATE payment_attempt SET state = 'captured', provider_txn_no = 'VNP_PENDING_PAID', updated_at = now()
WHERE txn_ref = 'PA_DRILL_PENDING';
UPDATE order_finance SET state = 'confirmed', version = version + 1, updated_at = now()
WHERE order_id = 'order_drill_await';
INSERT INTO payment_ledger (id, order_id, kind, amount, provider, provider_txn_id, state)
VALUES ('pled_drill_pending_paid', 'order_drill_await', 'capture', 420000, 'vnpay', 'VNP_PENDING_PAID', 'succeeded');

INSERT INTO checkout_attempt (id, cart_id, cart_version, idempotency_scope, idempotency_key, payload_hash, quote_id,
                              state, order_id, payment_method, lease_until)
VALUES
  ('chk_drill_after1', 'cart_drill_after1', 1, 'drill', 'idem-after1', 'h-after1', 'cqt_drill_1', 'ready',
   'order_drill_after1', 'vnpay', now() + interval '1 minute'),
  ('chk_drill_after2', 'cart_drill_after2', 1, 'drill', 'idem-after2', 'h-after2', 'cqt_drill_1', 'ready',
   'order_drill_after2', 'vnpay', now() + interval '1 minute');

INSERT INTO order_finance (id, order_id, display_ref, checkout_attempt_id, cart_id, state, total, payment_method,
                           hold_expires_at, policy_version, quote, address, contact)
VALUES
  ('ofin_drill_after1', 'order_drill_after1', 'XS-DRILL-AFTER1', 'chk_drill_after1', 'cart_drill_after1',
   'awaiting_payment', 150000, 'vnpay', now() + interval '15 minutes', 'drill-v1', '{"total":150000}',
   '{"province":"Huế"}', '{"name":"Khách Sau Mốc 1","email":"drill-after1@example.invalid"}'),
  ('ofin_drill_after2', 'order_drill_after2', 'XS-DRILL-AFTER2', 'chk_drill_after2', 'cart_drill_after2', 'confirmed',
   275000, 'vnpay', NULL, 'drill-v1', '{"total":275000}', '{"province":"Hải Phòng"}',
   '{"name":"Khách Sau Mốc 2","email":"drill-after2@example.invalid"}');

INSERT INTO payment_attempt (id, order_id, provider, txn_ref, amount, state, expires_at, provider_txn_no)
VALUES
  ('payatt_drill_after1', 'order_drill_after1', 'vnpay', 'PA_DRILL_AFTER_1', 150000, 'pending',
   now() + interval '15 minutes', NULL),
  ('payatt_drill_after2', 'order_drill_after2', 'vnpay', 'PA_DRILL_AFTER_2', 275000, 'captured',
   now() + interval '15 minutes', 'VNP_AFTER_2');

INSERT INTO payment_ledger (id, order_id, kind, amount, provider, provider_txn_id, state)
VALUES ('pled_drill_after2', 'order_drill_after2', 'capture', 275000, 'vnpay', 'VNP_AFTER_2', 'succeeded');

INSERT INTO webhook_inbox (id, provider, event_key, source, payload, payload_hash, verified, result, processed_at)
VALUES ('whin_drill_after2', 'vnpay', 'vnpay:PA_DRILL_AFTER_2:00', 'ipn', '{"vnp_TxnRef":"PA_DRILL_AFTER_2"}',
        'hash-after2', true, '{"outcome":"paid"}', now());

INSERT INTO outbox_event (id, event_key, aggregate_id, type, payload, state, attempts, next_attempt_at)
VALUES ('obx_drill_after2', 'drill:order.confirmed:order_drill_after2', 'order_drill_after2', 'order.confirmed',
        '{"order_id":"order_drill_after2"}', 'pending', 0, now());

INSERT INTO shipment (id, order_id, client_order_code, provider, provider_order_code, state, cod_amount, payer,
                      created_by)
VALUES ('shp_drill_after', 'order_drill_after2', 'XS-DRILL-AFTER-S1', 'ghn', 'GHN_DRILL_AFTER', 'picking', 0, 'shop',
        'drill');

COMMIT;
