import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Chèn trễ có kiểm soát vào lúc rebuild ĐANG ĐỌC NGUỒN (T-167): lần `query.graph` đầu tiên trên `product` có `productId`
 * trong bộ lọc id (lô nguồn của rebuild chứa sản phẩm đó) đọc xong thì DỪNG trước khi trả kết quả — rebuild đã cầm ảnh
 * chụp CŨ của sản phẩm; test đổi nguồn/đồng bộ trong lúc đó rồi `release()`. Chỉ dừng một lần: các lần đọc sau (lượt xả
 * đồng bộ chính sản phẩm đó trong lúc dừng) đi thẳng. Gài sẵn khi tạo — tạo ngay trước khi chạy rebuild.
 */
export function pauseSourceReadAfter(container: MedusaContainer, productId: string) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const original = query.graph.bind(query);
  let armed = true;
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const releaseP = new Promise<void>((r) => (release = r));
  const spy = jest.spyOn(query, "graph").mockImplementation((async (...args: Parameters<typeof original>) => {
    const out = await original(...args);
    const q = args[0] as { entity?: string; filters?: { id?: unknown } };
    const ids = q.filters?.id;
    if (armed && q.entity === "product" && Array.isArray(ids) && ids.includes(productId)) {
      armed = false;
      reached();
      await releaseP;
    }
    return out;
  }) as typeof original);
  return {
    /** Đợi tới khi rebuild đã đọc xong lô chứa sản phẩm và đang dừng. */
    reached: reachedP,
    release: () => release(),
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}
