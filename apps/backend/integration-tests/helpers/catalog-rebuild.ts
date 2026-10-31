import { AsyncLocalStorage } from "node:async_hooks";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { CATALOG_REBUILD_LOCK } from "../../src/lib/catalog/indexer";
import { withOwnedLock } from "../../src/lib/checkout/locks";

/**
 * Chèn trễ có kiểm soát vào lúc rebuild ĐANG ĐỌC NGUỒN (T-167): lần đầu `query.graph` đọc GIÁ biến thể
 * (`product_variant` + `calculated_price.*`, `sell-state.ts` `loadVariantPrices`) có `variantId` trong bộ lọc id trả về
 * thì DỪNG trước khi trả kết quả — lúc đó rebuild đã cầm ảnh chụp sản phẩm VÀ giá CŨ của biến thể (đọc giá đi sau đọc
 * sản phẩm trong cùng lô). Test đổi nguồn/đồng bộ trong lúc dừng rồi `release()`. Chỉ dừng một lần: các lần đọc sau
 * (lượt xả đồng bộ chính sản phẩm đó trong lúc dừng) đi thẳng. Gài sẵn khi tạo — tạo ngay trước khi chạy rebuild.
 */
export function pauseAfterPriceRead(container: MedusaContainer, variantId: string) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const original = query.graph.bind(query);
  let armed = true;
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const releaseP = new Promise<void>((r) => (release = r));
  const spy = jest.spyOn(query, "graph").mockImplementation((async (...args: Parameters<typeof original>) => {
    const out = await original(...args);
    const q = args[0] as { entity?: string; fields?: string[]; filters?: { id?: unknown } };
    const ids = q.filters?.id;
    if (
      armed &&
      q.entity === "product_variant" &&
      (q.fields ?? []).includes("calculated_price.*") &&
      Array.isArray(ids) &&
      ids.includes(variantId)
    ) {
      armed = false;
      reached();
      await releaseP;
    }
    return out;
  }) as typeof original);
  return {
    /** Đợi tới khi rebuild đã đọc xong giá của lô chứa biến thể và đang dừng. */
    reached: reachedP,
    release: () => release(),
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}

/** Ngữ cảnh "việc của ca test": lời gọi khởi phát trong `run` của `exclusiveRebuilds` (kể cả timer/promise con). */
const testOwned = new AsyncLocalStorage<true>();

export interface ExclusiveRebuilds {
  /** Chạy `fn` trong ngữ cảnh của ca: rebuild nó khởi phát giành `CATALOG_REBUILD_LOCK` như thường. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Chạy `fn` NGOÀI ngữ cảnh của ca (giả lập job nền) — dùng cho test chống hồi quy. */
  outside<T>(fn: () => T): T;
  /** Đóng cửa sổ: rebuild nền đang chờ giành được khoá như thường. Gọi nhiều lần vô hại. */
  close(): void;
}

/**
 * Độc quyền rebuild toàn phần cho một ca dùng móc dừng (T-167). App test chạy job thật: `x-catalog-index-rebuild`
 * (mỗi 30 phút) có thể giành `CATALOG_REBUILD_LOCK` giữa ca — vd ca "đồng bộ đọc TRƯỚC mốc, ghi SAU mốc" dừng một lượt
 * xả đang GIỮ `CATALOG_INDEX_LOCK` chờ rebuild CỦA CA lấy mốc; rebuild của job giữ khoá rebuild và chờ khoá ghi (5 phút
 * = hạn test) → vòng chờ: rebuild của ca chờ khoá rebuild, lượt xả chờ rebuild của ca, job chờ lượt xả. Hết hạn test thì
 * lượt xả vẫn dừng (gia hạn lease mãi) → mọi ca sau chờ khoá ghi, cả bộ im (lần chạy 04:05/22:05).
 *
 * Trong cửa sổ: mọi lần giành `CATALOG_REBUILD_LOCK` NGOÀI ngữ cảnh của ca nhận đúng lỗi "khoá bận" của provider (job
 * thăm dò tiếp như khi khoá đang bị giữ — không lỗi giả, không bỏ job); mở cửa sổ thì chờ rebuild nền đang chạy (nếu
 * có) xong trước. Không lồng hai cửa sổ trong một ca.
 */
export async function exclusiveRebuilds(
  container: MedusaContainer,
  waitMs = 60_000,
): Promise<ExclusiveRebuilds> {
  const locking = container.resolve(Modules.LOCKING);
  const acquire = locking.acquire.bind(locking);
  const spy = jest.spyOn(locking, "acquire").mockImplementation(async (keys, args) => {
    const list = Array.isArray(keys) ? keys : [keys];
    if (list.includes(CATALOG_REBUILD_LOCK) && testOwned.getStore() !== true) {
      throw new Error(
        `Failed to acquire lock for key "${CATALOG_REBUILD_LOCK}" (ca test giữ độc quyền rebuild)`,
      );
    }
    return acquire(keys, args);
  });
  const close = () => spy.mockRestore();
  try {
    // Rebuild nền đã giữ khoá trước khi mở cửa sổ → chờ nó nhả (giành rồi nhả ngay).
    await testOwned.run(true, () =>
      withOwnedLock(
        locking,
        CATALOG_REBUILD_LOCK,
        { waitMs, ttlSeconds: 30, scope: "test-exclusive-rebuild" },
        async () => undefined,
      ),
    );
  } catch (e) {
    close();
    throw e;
  }
  return {
    run: (fn) => testOwned.run(true, fn),
    outside: (fn) => testOwned.exit(fn),
    close,
  };
}
