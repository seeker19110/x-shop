import pg from "pg";
import { DATABASE_URL } from "./env.mjs";

/** Số đơn hàng (không tính nháp) trong DB E2E — để chứng minh reload/đặt lại không tạo đơn thứ hai. */
export async function countOrders() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query('SELECT count(*)::int AS n FROM "order" WHERE is_draft_order = false');
    return r.rows[0].n;
  } finally {
    await client.end();
  }
}
