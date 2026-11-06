/** globalTeardown của Jest cho test tích hợp (T-146 / D-077): trả Redis DB do global-setup.ts giành (Lua so token). */
import { LEASE_STATE, type LeaseState } from "./global-setup";

export default async function globalTeardown(): Promise<void> {
  const g = globalThis as Record<symbol, unknown>;
  const state = g[LEASE_STATE] as LeaseState | undefined;
  if (state === undefined) return;
  delete g[LEASE_STATE];
  const { lease, client } = state;
  try {
    const released = await lease.release();
    process.stderr.write(
      released
        ? `[redis-db-lease] trả Redis DB ${lease.db}\n`
        : `[redis-db-lease] khoá Redis DB ${lease.db} không còn của lần chạy này (TTL hết/lần chạy khác giữ) — không xoá\n`,
    );
  } finally {
    await client.quit().catch(() => client.disconnect());
  }
}
