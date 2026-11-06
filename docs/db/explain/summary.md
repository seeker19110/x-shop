# Tóm tắt EXPLAIN đường nóng (sinh tự động — không sửa tay)

Sinh bởi `node scripts/ops/explain-hot-paths.mjs --write` lúc 2026-10-26 14:14 UTC trên DB `xshop_perf` (PostgreSQL 16.15). Số dòng: catalog_variant_index 50.105 · order_finance 200.000 · checkout_attempt 220.029 · cart_version 200.000 · payment_attempt 110.000 · payment_ledger 95.904 · webhook_inbox 95.904 · outbox_event 595.604 · shipment 195.804 · ops_exception 2.018.
Thời gian = `Execution Time` của lần EXPLAIN dạng chữ (cache ấm, một người dùng, máy dùng chung — chỉ để so tương đối); Buffers = shared hit + read của nút gốc.

| Truy vấn                                                                       | Thực thi (ms) | Buffers | Kết luận                                       |
| ------------------------------------------------------------------------------ | ------------: | ------: | ---------------------------------------------- |
| [order-lookup-by-ref](order-lookup-by-ref.txt)                                 |          0.02 |       4 | đạt                                            |
| [order-finance-by-order-id](order-finance-by-order-id.txt)                     |          0.02 |       4 | đạt                                            |
| [order-view-outbox](order-view-outbox.txt)                                     |          0.03 |       4 | đạt                                            |
| [order-view-payment-attempts](order-view-payment-attempts.txt)                 |          0.02 |       4 | đạt                                            |
| [order-view-ops-exceptions](order-view-ops-exceptions.txt)                     |          0.01 |       3 | đạt                                            |
| [order-view-ledger](order-view-ledger.txt)                                     |          0.01 |       4 | đạt                                            |
| [order-view-shipment](order-view-shipment.txt)                                 |          0.02 |       4 | đạt                                            |
| [checkout-attempt-by-idempotency](checkout-attempt-by-idempotency.txt)         |          0.02 |       4 | đạt                                            |
| [checkout-active-attempt-of-cart](checkout-active-attempt-of-cart.txt)         |          0.01 |       4 | đạt                                            |
| [cart-version-by-cart](cart-version-by-cart.txt)                               |          0.01 |       4 | đạt                                            |
| [payment-attempt-by-txn-ref](payment-attempt-by-txn-ref.txt)                   |          0.02 |       4 | đạt                                            |
| [webhook-inbox-by-key](webhook-inbox-by-key.txt)                               |          0.01 |       4 | đạt                                            |
| [outbox-claim](outbox-claim.txt)                                               |          0.24 |      41 | đạt                                            |
| [reconcile-attempts-due](reconcile-attempts-due.txt)                           |          0.06 |       8 | đạt                                            |
| [expire-holds-due](expire-holds-due.txt)                                       |          0.11 |      91 | đạt                                            |
| [cod-confirm-overdue](cod-confirm-overdue.txt)                                 |          0.05 |      13 | đạt                                            |
| [catalog-expired-prices](catalog-expired-prices.txt)                           |          0.01 |       1 | đạt                                            |
| [catalog-listing-category](catalog-listing-category.txt)                       |         38.69 |    3656 | đạt                                            |
| [catalog-listing-filtered](catalog-listing-filtered.txt)                       |         75.22 |    4988 | đạt                                            |
| [catalog-listing-category-price-sort](catalog-listing-category-price-sort.txt) |         32.70 |    3906 | đạt                                            |
| [catalog-search-sku](catalog-search-sku.txt)                                   |         50.16 |    4883 | đạt (cho phép Seq Scan: catalog_variant_index) |
| [catalog-search-in-category](catalog-search-in-category.txt)                   |         47.76 |    6854 | đạt                                            |
| [catalog-listing-all](catalog-listing-all.txt)                                 |        204.61 |    9738 | đạt (cho phép Seq Scan: catalog_variant_index) |
| [catalog-search-short-terms](catalog-search-short-terms.txt)                   |        133.27 |   15031 | đạt (cho phép Seq Scan: catalog_variant_index) |
