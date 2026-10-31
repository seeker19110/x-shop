import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

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
