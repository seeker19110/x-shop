import pg from "pg";
import { DATABASE_URL, E2E_DB_NAME_PATTERN } from "./env.mjs";

/**
 * Dọn dữ liệu theo danh tính test (QA-E2E-006). Mỗi test có email `<tên>+e2e-<uuid>@example.com` riêng; mọi thứ test tạo
 * ra (đơn, giỏ, thanh toán, tồn đã giữ…) truy ngược được về email đó hoặc về mã giỏ test đã theo dõi.
 */
const IDENTITY_EMAIL = /\+e2e-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@/i;

async function withClient(fn) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function assertIdentity(email) {
  if (!IDENTITY_EMAIL.test(email)) throw new Error(`Không phải danh tính E2E (thiếu +e2e-<uuid>): ${email}`);
}

/** Chọn đơn của một email liên hệ: email nằm ở metadata đơn (`x_contact_email`) và ở order_finance.contact. */
const ORDER_OF_EMAIL = `(o.email = $1 OR o.metadata->>'x_contact_email' = $1
  OR EXISTS (SELECT 1 FROM order_finance f WHERE f.order_id = o.id AND f.contact->>'email' = $1))`;

const col = (rows, name) => rows.map((r) => r[name]).filter((v) => typeof v === "string" && v.length > 0);

/** Số đơn của một khách E2E — đếm theo danh tính từng test nên không nhiễu khi các test chạy song song. */
export async function countOrdersFor(email) {
  assertIdentity(email);
  return withClient(async (client) => {
    const r = await client.query(`SELECT count(*)::int AS n FROM "order" o WHERE ${ORDER_OF_EMAIL}`, [email]);
    return r.rows[0].n;
  });
}

/**
 * Xoá MỌI dữ liệu của một danh tính test, trong MỘT giao dịch:
 *  - đơn, dòng hàng, giao hàng, địa chỉ, thanh toán (collection/session/payment/capture), sổ cái, lần thử thanh toán;
 *  - giỏ (theo email, theo `cartIds` test đã theo dõi, theo giỏ gắn với đơn) và báo giá/lần checkout;
 *  - outbox/outbound/webhook_inbox liên quan;
 *  - TRẢ TỒN: mỗi reservation của test bị xoá và `reserved_quantity` của inventory_level giảm đúng số đã giữ (phép trừ
 *    bù, không ghi đè → an toàn khi nhiều test chạy song song trên cùng SKU).
 * Từ chối email không có `+e2e-<uuid>` để không bao giờ xoá nhầm dữ liệu khác. Trả số bản ghi (đơn + giỏ) còn sót.
 */
export async function cleanupIdentity(email, cartIds = []) {
  assertIdentity(email);
  return withClient(async (client) => {
    const db = (await client.query("SELECT current_database() AS d")).rows[0].d;
    if (!E2E_DB_NAME_PATTERN.test(db))
      throw new Error(`cleanupIdentity: từ chối chạy trên DB "${db}" (không phải DB E2E)`);
    await client.query("BEGIN");
    try {
      const orders = (
        await client.query(
          `SELECT o.id, o.shipping_address_id, o.billing_address_id FROM "order" o WHERE ${ORDER_OF_EMAIL}`,
          [email],
        )
      ).rows;
      const orderIds = col(orders, "id");
      const addressIds = [...col(orders, "shipping_address_id"), ...col(orders, "billing_address_id")];
      const carts = (
        await client.query(
          `SELECT id, shipping_address_id, billing_address_id FROM cart
            WHERE email = $1 OR id = ANY($2::text[])
               OR id IN (SELECT cart_id FROM order_finance WHERE order_id = ANY($3::text[]))
               OR id IN (SELECT cart_id FROM checkout_attempt WHERE order_id = ANY($3::text[]))`,
          [email, cartIds, orderIds],
        )
      ).rows;
      const cartIdList = col(carts, "id");
      const cartAddressIds = [...col(carts, "shipping_address_id"), ...col(carts, "billing_address_id")];

      const orderLineIds = col(
        (await client.query("SELECT item_id FROM order_item WHERE order_id = ANY($1::text[])", [orderIds]))
          .rows,
        "item_id",
      );
      const cartLineIds = col(
        (await client.query("SELECT id FROM cart_line_item WHERE cart_id = ANY($1::text[])", [cartIdList]))
          .rows,
        "id",
      );
      const shippingMethodIds = col(
        (
          await client.query(
            "SELECT shipping_method_id FROM order_shipping WHERE order_id = ANY($1::text[])",
            [orderIds],
          )
        ).rows,
        "shipping_method_id",
      );
      const collectionIds = col(
        (
          await client.query(
            `SELECT payment_collection_id FROM order_payment_collection WHERE order_id = ANY($1::text[])
             UNION SELECT payment_collection_id FROM cart_payment_collection WHERE cart_id = ANY($2::text[])`,
            [orderIds, cartIdList],
          )
        ).rows,
        "payment_collection_id",
      );
      const txnRefs = col(
        (
          await client.query("SELECT txn_ref FROM payment_attempt WHERE order_id = ANY($1::text[])", [
            orderIds,
          ])
        ).rows,
        "txn_ref",
      );

      // 1. Trả tồn: trừ bù reserved_quantity theo từng reservation của test rồi xoá reservation.
      const reservations = (
        await client.query(
          "SELECT id, inventory_item_id, location_id, quantity FROM reservation_item WHERE deleted_at IS NULL AND line_item_id = ANY($1::text[])",
          [[...orderLineIds, ...cartLineIds]],
        )
      ).rows;
      for (const rv of reservations) {
        // Chỉ reservation còn sống (deleted_at IS NULL): reservation đã soft-delete (hủy/fulfill) Medusa đã tự trả tồn.
        // Không GREATEST: kết quả âm = lệch tồn thật → ném lỗi (rollback) để lộ ra, không nuốt.
        const upd = await client.query(
          `UPDATE inventory_level
              SET reserved_quantity = reserved_quantity - $3,
                  raw_reserved_quantity = jsonb_set(raw_reserved_quantity, '{value}',
                    to_jsonb((reserved_quantity - $3)::text))
            WHERE inventory_item_id = $1 AND location_id = $2
            RETURNING reserved_quantity`,
          [rv.inventory_item_id, rv.location_id, Number(rv.quantity)],
        );
        if (upd.rowCount !== 1 || Number(upd.rows[0].reserved_quantity) < 0)
          throw new Error(`Trả tồn lệch: reservation ${rv.id} làm reserved_quantity âm/không tìm thấy level`);
      }
      await client.query("DELETE FROM reservation_item WHERE id = ANY($1::text[])", [
        col(reservations, "id"),
      ]);

      // 2. Thanh toán, sổ cái, sự kiện.
      await client.query("DELETE FROM order_payment_collection WHERE order_id = ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM cart_payment_collection WHERE cart_id = ANY($1::text[])", [cartIdList]);
      // cascade: payment, payment_session, capture, refund
      await client.query("DELETE FROM payment_collection WHERE id = ANY($1::text[])", [collectionIds]);
      await client.query("DELETE FROM payment_ledger WHERE order_id = ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM payment_attempt WHERE order_id = ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM webhook_inbox WHERE payload->>'vnp_TxnRef' = ANY($1::text[])", [
        txnRefs,
      ]);
      await client.query("DELETE FROM outbound_message WHERE aggregate_id = ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM outbox_event WHERE aggregate_id = ANY($1::text[])", [orderIds]);

      // 3. Đơn.
      await client.query("DELETE FROM order_access_redemption WHERE order_id = ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM order_cart WHERE order_id = ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM order_finance WHERE order_id = ANY($1::text[])", [orderIds]);
      // cascade: order_item, adjustment, tax_line
      await client.query("DELETE FROM order_line_item WHERE id = ANY($1::text[])", [orderLineIds]);
      await client.query("DELETE FROM order_shipping WHERE order_id = ANY($1::text[])", [orderIds]);
      await client.query("DELETE FROM order_shipping_method WHERE id = ANY($1::text[])", [shippingMethodIds]);
      // cascade: order_summary, order_transaction, order_change, order_credit_line
      await client.query('DELETE FROM "order" WHERE id = ANY($1::text[])', [orderIds]);
      await client.query("DELETE FROM order_address WHERE id = ANY($1::text[])", [addressIds]);

      // 4. Giỏ, báo giá, lần checkout.
      await client.query(
        "DELETE FROM checkout_attempt WHERE cart_id = ANY($1::text[]) OR order_id = ANY($2::text[])",
        [cartIdList, orderIds],
      );
      await client.query("DELETE FROM checkout_quote WHERE cart_id = ANY($1::text[])", [cartIdList]);
      await client.query("DELETE FROM cart_version WHERE cart_id = ANY($1::text[])", [cartIdList]);
      // cascade: cart_line_item, cart_shipping_method
      await client.query("DELETE FROM cart WHERE id = ANY($1::text[])", [cartIdList]);
      await client.query("DELETE FROM cart_address WHERE id = ANY($1::text[])", [cartAddressIds]);

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    const left = await client.query(
      `SELECT (SELECT count(*) FROM "order" o WHERE ${ORDER_OF_EMAIL})::int
            + (SELECT count(*) FROM cart WHERE email = $1 OR id = ANY($2::text[]))::int AS n`,
      [email, cartIds],
    );
    return left.rows[0].n;
  });
}
