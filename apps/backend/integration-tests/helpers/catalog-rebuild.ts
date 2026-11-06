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

/**
 * Ngữ cảnh "việc của ca test": lời gọi khởi phát trong `run` của MỘT cửa sổ `exclusiveRebuilds` (kể cả timer/promise con).
 * Mỗi cửa sổ một token riêng (T-238): timer/lượt xả hẹn sinh trong cửa sổ của ca trước (ngữ cảnh lan theo `setTimeout`)
 * không được coi là việc của cửa sổ sau.
 */
const testOwned = new AsyncLocalStorage<symbol>();

export interface ExclusiveRebuilds {
  /** Chạy `fn` trong ngữ cảnh của cửa sổ: rebuild nó khởi phát giành `CATALOG_REBUILD_LOCK` như thường. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Chạy `fn` NGOÀI ngữ cảnh của cửa sổ (giả lập job nền) — dùng cho test chống hồi quy. */
  outside<T>(fn: () => T): T;
  /**
   * Lời gọi hiện tại thuộc ngữ cảnh của CHÍNH cửa sổ này? Spy toàn cục (clockNow, replaceAll, locking…) dùng để chỉ đếm
   * việc của ca, không lẫn job/lượt xả nền chạy song song (T-238).
   */
  owns(): boolean;
  /** Đóng cửa sổ: rebuild nền đang chờ giành được khoá như thường. Gọi nhiều lần vô hại. */
  close(): void;
}

/**
 * Độc quyền rebuild toàn phần cho một ca dùng móc dừng hoặc spy toàn cục (T-167, T-238). App test chạy job thật:
 * `x-catalog-index-rebuild` (mỗi 30 phút) có thể giành `CATALOG_REBUILD_LOCK` giữa ca — vd ca "đồng bộ đọc TRƯỚC mốc, ghi
 * SAU mốc" dừng một lượt xả đang GIỮ `CATALOG_INDEX_LOCK` chờ rebuild CỦA CA lấy mốc; rebuild của job giữ khoá rebuild và
 * chờ khoá ghi (5 phút = hạn test) → vòng chờ: rebuild của ca chờ khoá rebuild, lượt xả chờ rebuild của ca, job chờ lượt
 * xả. Hết hạn test thì lượt xả vẫn dừng (gia hạn lease mãi) → mọi ca sau chờ khoá ghi, cả bộ im (lần chạy 04:05/22:05).
 * Ca đếm qua spy toàn cục thì rebuild của job chen vào thành thêm một cặp đọc/thay (T-238).
 *
 * Trong cửa sổ: mọi lần giành `CATALOG_REBUILD_LOCK` NGOÀI ngữ cảnh của cửa sổ nhận đúng lỗi "khoá bận" của provider (job
 * thăm dò tiếp như khi khoá đang bị giữ — không lỗi giả, không bỏ job). Mở cửa sổ: giành khoá rebuild trong ngữ cảnh của
 * cửa sổ (chờ rebuild nền đang chạy xong) và chỉ CÀI chặn lúc đang giữ khoá — trong lúc chờ, lời gia hạn lease của rebuild
 * nền đang giữ khoá đi thẳng (chặn thì lease hết hạn giữa rebuild nền, cửa sổ giành được khoá khi nó còn chạy — mất độc
 * quyền); lúc cài, không ai khác giữ khoá nên mọi lời giành ngoài ngữ cảnh sau đó đều là giành mới (hoặc lời gia hạn của
 * lease đã mất — chặn đúng). `locking.acquire` đã là spy (ca cài trước) → bọc nối tiếp lên cài đặt hiện có; đóng thì trả
 * lại. Không lồng hai cửa sổ trong một ca.
 */
export async function exclusiveRebuilds(
  container: MedusaContainer,
  waitMs = 60_000,
): Promise<ExclusiveRebuilds> {
  const locking = container.resolve(Modules.LOCKING);
  const token = Symbol("exclusive-rebuilds");
  const owns = () => testOwned.getStore() === token;
  let close = () => {};
  const install = () => {
    const created = !jest.isMockFunction(locking.acquire);
    const spy = jest.spyOn(locking, "acquire");
    const prev = spy.getMockImplementation()!;
    let active = true;
    const impl: typeof prev = async (keys, args) => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (active && list.includes(CATALOG_REBUILD_LOCK) && !owns()) {
        throw new Error(
          `Failed to acquire lock for key "${CATALOG_REBUILD_LOCK}" (ca test giữ độc quyền rebuild)`,
        );
      }
      return prev.call(locking, keys, args);
    };
    spy.mockImplementation(impl);
    close = () => {
      // Có spy khác bọc lên trên (chưa gỡ) → để lại một lớp đi thẳng; `jest.restoreAllMocks` ở afterEach dọn hết.
      active = false;
      if (spy.getMockImplementation() !== impl) return;
      if (created) spy.mockRestore();
      else spy.mockImplementation(prev);
    };
  };
  // Rebuild nền đã giữ khoá trước khi mở cửa sổ → chờ nó nhả; cài chặn khi CHÍNH cửa sổ đang giữ khoá rồi nhả.
  await testOwned.run(token, () =>
    withOwnedLock(
      locking,
      CATALOG_REBUILD_LOCK,
      { waitMs, ttlSeconds: 30, scope: "test-exclusive-rebuild" },
      async () => install(),
    ),
  );
  return {
    run: (fn) => testOwned.run(token, fn),
    outside: (fn) => testOwned.exit(fn),
    owns,
    close: () => close(),
  };
}
