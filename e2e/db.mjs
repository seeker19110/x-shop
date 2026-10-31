import pg from "pg";
import { DATABASE_URL } from "./env.mjs";

async function withClient(fn) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Dữ liệu cho luồng Store API gọi thẳng (e2e/scale-out.spec.ts): region đầu tiên và một biến thể của sản phẩm đã xuất bản
 * còn ≥ 5 tồn khả dụng (sau boost-stock.mjs).
 */
export async function storeFixture() {
  return withClient(async (client) => {
    const region = await client.query(
      "SELECT id FROM region WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1",
    );
    const variant = await client.query(
      `SELECT pv.id FROM product_variant pv
         JOIN product p ON p.id = pv.product_id AND p.status = 'published' AND p.deleted_at IS NULL
         JOIN product_variant_inventory_item pvi ON pvi.variant_id = pv.id AND pvi.deleted_at IS NULL
         JOIN inventory_level il ON il.inventory_item_id = pvi.inventory_item_id AND il.deleted_at IS NULL
       WHERE pv.deleted_at IS NULL AND il.stocked_quantity - il.reserved_quantity >= 5
       ORDER BY pv.id LIMIT 1`,
    );
    const regionId = region.rows[0]?.id;
    const variantId = variant.rows[0]?.id;
    if (!regionId || !variantId)
      throw new Error("DB E2E thiếu region hoặc biến thể còn hàng (seed/boost-stock?)");
    return { regionId, variantId };
  });
}
