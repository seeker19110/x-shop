/**
 * Kiểm tính đúng SAU tải (đặc tả §10.3: "không mất dữ liệu, không vượt tồn"): đọc thẳng DB. Mỗi kiểm tra trả
 * { name, ok, detail }; không có kiểm tra nào được phép "bỏ qua" âm thầm.
 */

const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];

export async function snapshotBefore(db) {
  const r = await one(db, 'SELECT count(*)::int AS orders FROM "order" WHERE is_draft_order = false');
  return { orders: r.orders };
}

/**
 * @param {import("pg").Client} db
 * @param {{ submits: {key:string,cartId:string,status:number,orderId:string|null}[], violations: string[] }} ctx
 * @param {{ before: {orders:number}, contention: {variantId:string,itemId:string}, contentionResult: {prepared:number,statuses:number[],orderIds:string[]} }} extra
 */
export async function verifyAfter(db, ctx, { before, contention, contentionResult }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const neg = await one(
    db,
    `SELECT count(*)::int AS n FROM inventory_level
      WHERE deleted_at IS NULL AND (stocked_quantity < 0 OR reserved_quantity < 0 OR reserved_quantity > stocked_quantity)`,
  );
  add("Không bán âm tồn (mọi inventory_level: 0 ≤ giữ chỗ ≤ tồn)", neg.n === 0, `${neg.n} dòng vi phạm`);

  const drift = await one(
    db,
    `SELECT count(*)::int AS n FROM inventory_level il
       LEFT JOIN (SELECT inventory_item_id, sum(quantity) AS q FROM reservation_item
                   WHERE deleted_at IS NULL GROUP BY inventory_item_id) r USING (inventory_item_id)
      WHERE il.deleted_at IS NULL AND il.reserved_quantity <> COALESCE(r.q, 0)`,
  );
  add("Giữ chỗ khớp reservation_item (không lệch sổ)", drift.n === 0, `${drift.n} dòng lệch`);

  const dupKey = await one(
    db,
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM checkout_attempt WHERE deleted_at IS NULL
       GROUP BY idempotency_scope, idempotency_key HAVING count(*) > 1) x`,
  );
  add("Không có hai lần đặt cùng Idempotency-Key", dupKey.n === 0, `${dupKey.n} khoá trùng`);

  const dupCart = await one(
    db,
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM checkout_attempt
       WHERE state = 'ready' AND order_id IS NOT NULL AND deleted_at IS NULL
       GROUP BY cart_id HAVING count(DISTINCT order_id) > 1) x`,
  );
  add("Không có giỏ nào thành hai đơn", dupCart.n === 0, `${dupCart.n} giỏ có > 1 đơn`);

  const clientOrders = new Set(
    ctx.submits.filter((s) => s.status === 200 && s.orderId).map((s) => s.orderId),
  );
  const after = await one(db, 'SELECT count(*)::int AS orders FROM "order" WHERE is_draft_order = false');
  const created = after.orders - before.orders;
  add(
    "Số đơn mới trong DB = số đơn khác nhau khách nhận được (không mất, không thừa)",
    created === clientOrders.size,
    `DB +${created}, phía khách ${clientOrders.size} (submit 200: ${ctx.submits.filter((s) => s.status === 200).length})`,
  );
  const known = clientOrders.size
    ? await one(db, 'SELECT count(*)::int AS n FROM "order" WHERE id = ANY($1)', [[...clientOrders]])
    : { n: 0 };
  add(
    "Mọi mã đơn đã trả về cho khách đều có trong DB",
    known.n === clientOrders.size,
    `${known.n}/${clientOrders.size}`,
  );
  add(
    "Gửi lại cùng Idempotency-Key trả đúng đơn cũ",
    ctx.violations.length === 0,
    ctx.violations.length ? ctx.violations.slice(0, 3).join("; ") : "không vi phạm",
  );

  // Stress §10.3: nhiều lượt đặt đồng thời cho SKU còn 1 đơn vị.
  const { statuses, orderIds, prepared } = contentionResult;
  const wins = statuses.filter((s) => s === 200).length;
  const serverErr = statuses.filter((s) => s === 0 || s >= 500).length;
  const level = await one(
    db,
    "SELECT stocked_quantity::int AS stocked, reserved_quantity::int AS reserved FROM inventory_level WHERE inventory_item_id = $1",
    [contention.itemId],
  );
  const lines = await one(
    db,
    `SELECT count(DISTINCT oi.order_id)::int AS n FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
       JOIN "order" o ON o.id = oi.order_id
      WHERE li.variant_id = $1 AND o.is_draft_order = false`,
    [contention.variantId],
  );
  add(
    `Stress ${prepared} lượt đặt đồng thời cho SKU còn 1: đúng 1 đơn thành công`,
    prepared > 1 && wins === 1 && new Set(orderIds).size === 1,
    `thành công ${wins}, trạng thái: ${JSON.stringify(countBy(statuses))}`,
  );
  add(
    "Stress: các lượt còn lại nhận lỗi hiểu được (4xx), không có 5xx/timeout",
    serverErr === 0,
    `${serverErr} lỗi server`,
  );
  add(
    "Stress: tồn của SKU không âm (giữ chỗ ≤ 1) và chỉ có đúng một đơn chứa SKU",
    level.reserved >= 0 && level.reserved <= level.stocked && level.reserved === 1 && lines.n === 1,
    `tồn ${level.stocked}, giữ chỗ ${level.reserved}, đơn chứa SKU ${lines.n}`,
  );
  return checks;
}

function countBy(xs) {
  const o = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
}

/** Đếm cache PostgreSQL (blks_hit / (hit + read)) của DB hiện tại — để báo hit ratio. */
export async function pgCacheStats(db) {
  const r = await one(
    db,
    "SELECT blks_hit::bigint AS hit, blks_read::bigint AS read FROM pg_stat_database WHERE datname = current_database()",
  );
  return { hit: Number(r.hit), read: Number(r.read) };
}
