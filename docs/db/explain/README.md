# EXPLAIN đường nóng (DB-PERF-001, T-074)

Mỗi truy vấn lõi có một file plan thô `<tên>.txt` (`EXPLAIN (ANALYZE, BUFFERS)` + SQL + tham số + nơi chạy trong mã). Bảng tóm tắt sinh tự động: [`summary.md`](summary.md). Danh sách truy vấn: `scripts/ops/hot-paths.mjs`. **Sửa một truy vấn trong danh sách (hoặc thêm truy vấn đường nóng mới) thì sửa danh sách và chạy lại** (lệnh dưới).

## Tái lập

```bash
bash scripts/dev-services.sh                         # Postgres + Redis cục bộ (nếu chưa chạy)
node scripts/ops/perf-dataset.mjs                    # DB xshop_perf: migrate, seed, 50k SKU, đo catalog:reindex, 200k đơn (~8 phút)
EXPLAIN_DATABASE_URL=postgres://xshop:xshop@localhost:5432/xshop_perf node scripts/ops/explain-hot-paths.mjs --write
node --test scripts/ops/explain-hot-paths.test.mjs   # hàm thuần: placeholder, dò Seq Scan, danh sách, bộ sinh dữ liệu
node scripts/ops/perf-dataset.mjs --drop             # dọn DB + Redis DB index đo đạc
```

`explain-hot-paths.mjs` **thoát mã 1** khi kế hoạch của một truy vấn có `Seq Scan` trên bảng thuộc `LARGE_TABLES` (`catalog_variant_index`, `order_finance`, `checkout_attempt`, `cart_version`, `payment_attempt`, `payment_ledger`, `webhook_inbox`, `outbox_event`, `shipment`, `ops_exception`) mà mục đó không khai `allowSeqScan` kèm lý do; **thoát mã 2** khi một bảng lớn ít dòng hơn ngưỡng (trên DB nhỏ, planner chọn Seq Scan là đúng — kết luận khi đó vô nghĩa). Mỗi truy vấn chạy trong giao dịch ROLLBACK (kể cả `UPDATE` của claim outbox): một lần làm ấm, một lần `FORMAT JSON` để kiểm (duyệt cả InitPlan/SubPlan/CTE), một lần dạng chữ để ghi file.

## Dữ liệu đo

DB `xshop_perf` (PostgreSQL 16.15 cục bộ), sinh bằng `scripts/ops/perf-dataset.mjs` — hoàn toàn tổng hợp, không dữ liệu thật:

| Bảng                    |  Số dòng | Ghi chú                                                                                   |
| ----------------------- | -------: | ----------------------------------------------------------------------------------------- |
| `catalog_variant_index` |   50.105 | 10.000 sản phẩm / 50.000 SKU của bộ dữ liệu tải (`scripts/load/dataset.mjs`) + 105 demo   |
| `order_finance`         |  200.000 | 2 năm bán hàng; nửa COD, nửa VNPAY; 2% hủy; 0,1% mới nhất còn chờ thanh toán/xác nhận     |
| `checkout_attempt`      |  220.029 | 1 attempt thành công/đơn + 10% attempt lỗi trước đó + attempt đang chuẩn bị ở đuôi        |
| `outbox_event`          |  595.604 | ~3 sự kiện/đơn (đặt, xác nhận/hủy, giao xong); đuôi: pending đến hạn / failed / dead      |
| `payment_attempt`       |  110.000 | 1 lượt/đơn VNPAY + 5% có thêm lượt lỗi                                                    |
| `payment_ledger`        |   95.904 | capture của đơn VNPAY đã trả + 1% hoàn                                                    |
| `webhook_inbox`         |   95.904 | 1 IPN/đơn VNPAY đã trả                                                                    |
| `shipment`              |  195.804 | 1 vận đơn/đơn đã xác nhận                                                                 |
| `ops_exception`         |    2.018 | 1% đơn (đã xử lý) + đuôi đang mở                                                          |

Quy mô đơn là **giả định** (≈ 270 đơn/ngày trong 2 năm) để bảng đủ lớn cho planner chọn như production; chưa có số đơn dự kiến của chủ dự án. Bảng còn nhỏ hơn ở production lúc đầu → planner có thể chọn Seq Scan hợp lý; kiểm này trả lời câu "khi bảng lớn, có index phù hợp không".

## Kết quả (2026-10-26)

24/24 truy vấn đạt. **Phát hiện thiếu index thật** — ba truy vấn của trang đơn (`presentOrder`, `apps/backend/src/lib/orders/view.ts`, chạy mỗi lần khách mở đơn) quét tuần tự toàn bảng; đã thêm `apps/backend/src/modules/checkout/migrations/Migration20261026174000.ts` (index thường, có down) + khai trong model + snapshot:

| Truy vấn                      | Trước (Seq Scan)                      | Sau                                                            |
| ----------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `order-view-outbox`           | 46,1 ms · 13.928 buffer (595k dòng)   | 0,03 ms · 4 buffer — Index Scan `IDX_outbox_event_aggregate_id` |
| `order-view-payment-attempts` | 13,2 ms · 1.878 buffer (110k dòng)    | 0,03 ms · 4 buffer — `IDX_payment_attempt_order_id`             |
| `order-view-ops-exceptions`   | 0,21 ms · 39 buffer (2k dòng, tăng dần) | 0,02 ms · 3 buffer — `IDX_ops_exception_order_id`              |

Index cũ `IDX_payment_attempt_order_active_unique` là partial (chỉ lượt đang mở) nên không dùng được cho "mọi lượt của đơn". Test: `pnpm --filter @x-shop/backend test:integration -- checkout-module` (khối "index trang đơn"): index có đúng cột, không partial; 5.000 dòng + `ANALYZE` thì planner chọn index cho đúng hình truy vấn (đột biến: chạy `down()` trước → `Seq Scan on outbox_event`, test đỏ); `down()` chỉ xoá 3 index này, `up()` hai lần không lỗi.

Các truy vấn còn lại dùng index có sẵn (unique `display_ref`/`order_id`/`txn_ref`/`(provider, event_key)`/`(idempotency_scope, idempotency_key)`, `IDX_outbox_event_state_next`, `IDX_checkout_attempt_state_lease`, `IDX_order_finance_state_hold`, GIN danh mục + trigram của read model).

### Ngoại lệ được phép (`allowSeqScan`) — chỉ catalog toàn kênh

| Truy vấn                     | Vì sao index không giúp                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `catalog-listing-all`        | Không danh mục: trang + `total` + 3 facet phải nhóm mọi SKU của kênh (~200 ms ở 50k SKU). Hướng tiếp: cache facet (câu hỏi mở 5 ở `docs/ops/perf/load-dataset.md`). |
| `catalog-search-short-terms` | Mọi từ < 3 ký tự ("ao so mi") không dùng được trigram và khớp ~1/3 bảng; khớp tiền tố từ phải xét mọi dòng của kênh.        |
| `catalog-search-sku`         | Phần tìm dùng trigram (4 dòng), nhưng CTE giá trị facet của phạm vi (không danh mục) đọc mọi dòng của kênh — giao ước API trả đủ giá trị facet (T-058). |

Ngoại lệ chỉ áp cho `catalog_variant_index`; truy vấn đơn/checkout/job **không** có ngoại lệ (test `hotPaths thật` khoá danh sách này). Listing có danh mục (mẫu chính của tải) không Seq Scan.

## Giới hạn

- **Chưa nối CI**: cần DB ~50k SKU + 200k đơn (dựng ~8 phút); `explain-hot-paths.test.mjs` (hàm thuần) chạy được trong CI nhưng chưa có job gọi.
- Truy vấn qua ORM (`listOrderFinances`, `listOutboxEvents`…) được viết lại dưới dạng câu tương đương (cùng `WHERE` + `deleted_at IS NULL` + `ORDER BY`), không bắt từ log MikroORM. Truy vấn catalog dựng bằng chính `listingSql` của backend nên không lệch.
- Không gồm truy vấn native của Medusa (PDP `product.handle`, giỏ, tồn) — index do Medusa quản lý.
- Thời gian là một người dùng, cache ấm, máy dev 4 CPU **đang chịu tải song song** (phiên khác) — chỉ để so trước/sau; thước đo của kiểm là "có/không Seq Scan".
