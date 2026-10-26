/**
 * Danh sách truy vấn đường nóng (DB-PERF-001) cho `explain-hot-paths.mjs`. Mỗi mục:
 *  - `name`: tên file plan `docs/db/explain/<name>.txt` (chữ thường, số, gạch ngang);
 *  - `source`: nơi truy vấn chạy trong mã (file + hàm) — sửa truy vấn ở đó thì sửa ở đây và chạy lại;
 *  - `build(ctx)`: trả `{ sql, bindings }` với placeholder `?` kiểu knex (như `this.exec`/`knex.raw` của module);
 *    truy vấn catalog dựng bằng CHÍNH `listingSql`/`productIdsWithExpiredPrice` của backend (không chép SQL);
 *    truy vấn qua ORM (`listOrderFinances`…) là câu tương đương của MikroORM: cùng WHERE + `deleted_at IS NULL` + ORDER BY;
 *  - `allowSeqScan` (tuỳ chọn): bảng lớn được phép quét tuần tự + lý do — chỉ khi truy vấn VỐN đọc gần hết bảng
 *    (index không giảm được số dòng phải đọc); mỗi ngoại lệ ghi trong docs/db/explain/README.md.
 *
 * `ctx` = { channelIds: string[], now: Date, ref: (i) => mã số thứ tự 7 chữ số của đơn tổng hợp `perf-dataset.mjs` }.
 */

const LISTING_PAGE_SIZE = 24; // PAGE_SIZE_DEFAULT (apps/backend/src/lib/catalog/listing.ts)

const filter = (over = {}) => ({
  q: null,
  colors: [],
  sizes: [],
  materials: [],
  priceMin: null,
  priceMax: null,
  inStock: false,
  sort: "newest",
  page: 1,
  ...over,
});

/** Nạp `query.ts` của module catalog-index (TypeScript, Node ≥ 22.18 tự bỏ kiểu). */
export async function loadCatalogQuery(root) {
  const { pathToFileURL } = await import("node:url");
  const path = await import("node:path");
  return import(pathToFileURL(path.join(root, "apps/backend/src/modules/catalog-index/query.ts")).href);
}

/** Bảng được coi là lớn (tăng theo đơn/SKU) → cấm Seq Scan; số = số dòng tối thiểu để kết quả EXPLAIN có nghĩa. */
export const LARGE_TABLES = {
  catalog_variant_index: 40_000,
  order_finance: 100_000,
  checkout_attempt: 100_000,
  cart_version: 100_000,
  payment_attempt: 50_000,
  payment_ledger: 50_000,
  webhook_inbox: 50_000,
  outbox_event: 300_000,
  shipment: 100_000,
  ops_exception: 1_000,
};

const MID = 123_457; // đơn giữa lịch sử (đã xong) của bộ dữ liệu mặc định 200.000 đơn

/** @param {{ listingSql: Function }} cq module query.ts */
export function hotPaths(cq) {
  const listing = (scope, f) => (ctx) =>
    cq.listingSql({ channelIds: ctx.channelIds, ...scope }, f, LISTING_PAGE_SIZE);
  return [
    // --- Đơn hàng sau mua (khách tra cứu/xem đơn) ---
    {
      name: "order-lookup-by-ref",
      source: "apps/backend/src/lib/orders/lookup.ts findByRef → listOrderFinances({ display_ref })",
      build: (ctx) => ({
        sql: `SELECT * FROM order_finance WHERE display_ref = ? AND deleted_at IS NULL`,
        bindings: [`XS-P${ctx.ref(MID)}`],
      }),
    },
    {
      name: "order-finance-by-order-id",
      source:
        "listOrderFinances({ order_id }) — access.ts, cancel.ts, recheck.ts, payment.ts, jobs.ts, notify.ts …",
      build: (ctx) => ({
        sql: `SELECT * FROM order_finance WHERE order_id = ? AND deleted_at IS NULL`,
        bindings: [`order_PF${ctx.ref(MID)}`],
      }),
    },
    {
      name: "order-view-outbox",
      source: "apps/backend/src/lib/orders/view.ts presentOrder → listOutboxEvents({ aggregate_id })",
      build: (ctx) => ({
        sql: `SELECT * FROM outbox_event WHERE aggregate_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
        bindings: [`order_PF${ctx.ref(MID)}`],
      }),
    },
    {
      name: "order-view-payment-attempts",
      source:
        "apps/backend/src/lib/orders/view.ts presentOrder → listPaymentAttempts({ order_id }); recheck.ts",
      build: (ctx) => ({
        sql: `SELECT * FROM payment_attempt WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
        bindings: [`order_PF${ctx.ref(MID - 1)}`],
      }),
    },
    {
      name: "order-view-ops-exceptions",
      source:
        "apps/backend/src/lib/orders/view.ts presentOrder, cancel.ts → listOpsExceptions({ order_id, kind })",
      build: (ctx) => ({
        sql: `SELECT * FROM ops_exception WHERE order_id = ? AND kind IN (?, ?, ?) AND deleted_at IS NULL`,
        bindings: [`order_PF${ctx.ref(123_400)}`, "refund_request", "late_payment", "overpayment"],
      }),
    },
    {
      name: "order-view-ledger",
      source:
        "CheckoutModuleService.ledgerEntriesOf + listPaymentLedgers({ order_id }) (view.ts, shipments.ts)",
      build: (ctx) => ({
        sql: `SELECT kind, amount, provider_txn_id, refund_id, state FROM payment_ledger
               WHERE order_id = ? AND deleted_at IS NULL`,
        bindings: [`order_PF${ctx.ref(MID - 1)}`],
      }),
    },
    {
      name: "order-view-shipment",
      source: "apps/backend/src/modules/shipping/service.ts shipmentOfOrder",
      build: (ctx) => ({
        sql: `SELECT * FROM shipment WHERE order_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
        bindings: [`order_PF${ctx.ref(MID)}`],
      }),
    },
    // --- Checkout / thanh toán ---
    {
      name: "checkout-attempt-by-idempotency",
      source:
        "apps/backend/src/lib/checkout/submit.ts → listCheckoutAttempts({ idempotency_scope, idempotency_key })",
      build: (ctx) => ({
        sql: `SELECT * FROM checkout_attempt
               WHERE idempotency_scope = ? AND idempotency_key = ? AND deleted_at IS NULL`,
        bindings: ["checkout", `idk_PF${ctx.ref(MID)}`],
      }),
    },
    {
      name: "checkout-active-attempt-of-cart",
      source: "apps/backend/src/modules/checkout/service.ts findActiveAttemptId",
      build: (ctx) => ({
        sql: `SELECT id FROM checkout_attempt
               WHERE cart_id = ? AND cart_version = ? AND state IN (?, ?) AND deleted_at IS NULL LIMIT 1`,
        bindings: [`cart_PF${ctx.ref(MID)}`, 1, "preparing", "ready"],
      }),
    },
    {
      name: "cart-version-by-cart",
      source: "apps/backend/src/modules/checkout/service.ts currentCartVersion / observeCartVersion",
      build: (ctx) => ({
        sql: `SELECT version, fingerprint FROM cart_version WHERE cart_id = ?`,
        bindings: [`cart_PF${ctx.ref(MID)}`],
      }),
    },
    {
      name: "payment-attempt-by-txn-ref",
      source: "apps/backend/src/lib/checkout/payment.ts IPN → listPaymentAttempts({ txn_ref, provider })",
      build: (ctx) => ({
        sql: `SELECT * FROM payment_attempt WHERE txn_ref = ? AND provider = ? AND deleted_at IS NULL`,
        bindings: [`T${ctx.ref(MID - 1)}`, "vnpay"],
      }),
    },
    {
      name: "webhook-inbox-by-key",
      source: "apps/backend/src/modules/checkout/service.ts recordInbox (SELECT sau ON CONFLICT)",
      build: (ctx) => ({
        sql: `SELECT id, result, processed_at FROM webhook_inbox WHERE provider = ? AND event_key = ?`,
        bindings: ["vnpay", `V${ctx.ref(MID - 1)}`],
      }),
    },
    // --- Job định kỳ (worker) ---
    {
      name: "outbox-claim",
      source: "apps/backend/src/modules/checkout/service.ts claimDueOutbox (job x-outbox-dispatch, 10 s)",
      build: (ctx) => ({
        sql: `UPDATE outbox_event SET next_attempt_at = ?, updated_at = now()
               WHERE id = (
                 SELECT id FROM outbox_event
                 WHERE state IN ('pending', 'failed') AND next_attempt_at <= ? AND deleted_at IS NULL
                 ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
               RETURNING id, event_key, aggregate_id, type, payload, attempts`,
        bindings: [new Date(ctx.now.getTime() + 60_000), ctx.now],
      }),
    },
    {
      name: "reconcile-attempts-due",
      source:
        "apps/backend/src/modules/checkout/service.ts listStaleAttempts (job x-reconcile-attempts, 1 phút)",
      build: (ctx) => ({
        sql: `SELECT id, cart_id FROM checkout_attempt
               WHERE ((state = 'preparing' AND lease_until < ?) OR (state = 'compensated' AND error_code = 'COMPENSATING'))
                 AND deleted_at IS NULL
               ORDER BY lease_until LIMIT ?`,
        bindings: [ctx.now, 50],
      }),
    },
    {
      name: "expire-holds-due",
      source:
        "apps/backend/src/modules/checkout/service.ts listExpiredHoldOrderIds (job x-expire-holds, 1 phút)",
      build: (ctx) => ({
        sql: `SELECT order_id FROM order_finance
               WHERE state = 'awaiting_payment' AND hold_expires_at <= ? AND deleted_at IS NULL
               ORDER BY hold_expires_at LIMIT ?`,
        bindings: [ctx.now, 100],
      }),
    },
    {
      name: "cod-confirm-overdue",
      source:
        "apps/backend/src/modules/checkout/service.ts listOverdueCodOrders (job x-cod-confirm-timeout, 15 phút)",
      build: (ctx) => ({
        sql: `SELECT order_id, display_ref FROM order_finance
               WHERE state = 'placed' AND payment_method = 'cod' AND cod_confirm_by <= ? AND deleted_at IS NULL
               ORDER BY cod_confirm_by LIMIT ?`,
        bindings: [ctx.now, 200],
      }),
    },
    {
      name: "catalog-expired-prices",
      source:
        "apps/backend/src/modules/catalog-index/service.ts productIdsWithExpiredPrice (markExpiredPrices)",
      build: (ctx) => ({
        sql: `SELECT DISTINCT product_id FROM catalog_variant_index
               WHERE price_valid_until IS NOT NULL AND price_valid_until <= ?`,
        bindings: [ctx.now],
      }),
    },
    // --- Catalog read model (listing/search/facet — một câu, listingSql) ---
    {
      name: "catalog-listing-category",
      source: "apps/backend/src/modules/catalog-index/query.ts listingSql — danh mục lá `ao-nu`",
      build: listing({ category: "ao-nu" }, filter()),
    },
    {
      name: "catalog-listing-filtered",
      source: "listingSql — danh mục cha `nu` + màu đen + size M + giá 200–400k",
      build: listing(
        { category: "nu" },
        filter({ colors: ["den"], sizes: ["m"], priceMin: 200_000, priceMax: 400_000 }),
      ),
    },
    {
      name: "catalog-listing-category-price-sort",
      source: "listingSql — `quan-nam`, giá tăng dần, trang 3",
      build: listing({ category: "quan-nam" }, filter({ sort: "price_asc", page: 3 })),
    },
    {
      name: "catalog-search-sku",
      source: 'listingSql — tìm "mẫu 00042" (trigram ứng viên, không danh mục)',
      build: listing({ category: null }, filter({ q: "mẫu 00042" })),
      allowSeqScan: {
        catalog_variant_index:
          "CTE `v` (giá trị + nhãn facet của phạm vi kênh) đọc mọi dòng của kênh khi không có danh mục — phần đếm " +
          "dùng trigram; facet phải liệt kê mọi giá trị của phạm vi (giao ước API, T-058)",
      },
    },
    {
      name: "catalog-search-in-category",
      source: 'listingSql — `nu` + tìm "lụa" + còn hàng + size S',
      build: listing({ category: "nu" }, filter({ q: "lụa", inStock: true, sizes: ["s"] })),
    },
    {
      name: "catalog-listing-all",
      source: "listingSql — không danh mục, mới nhất (trang chủ / 'tất cả')",
      build: listing({ category: null }, filter()),
      allowSeqScan: {
        catalog_variant_index:
          "phạm vi = mọi SKU của kênh: trang + total + 3 facet phải nhóm toàn bộ dòng — index không giảm số dòng " +
          "(đo T-058: ~150 ms; hướng tiếp: cache facet ngắn hạn, câu hỏi mở 5 của load-dataset.md)",
      },
    },
    {
      name: "catalog-search-short-terms",
      source: 'listingSql — tìm "ao so mi" (mọi từ < 3 ký tự, không danh mục)',
      build: listing({ category: null }, filter({ q: "ao so mi" })),
      allowSeqScan: {
        catalog_variant_index:
          "từ < 3 ký tự không dùng được trigram và khớp ~1/3 bảng; khớp tiền tố từ (strpos) phải xét mọi dòng của kênh",
      },
    },
  ];
}
