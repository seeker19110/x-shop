import { randomInt, randomUUID } from "node:crypto";
import { test as base } from "@playwright/test";
import { cleanupIdentity } from "./cleanup.mjs";

/**
 * Dữ liệu riêng cho từng test (QA-E2E-006): mỗi test nhận một khách `<tên>+e2e-<uuid>@example.com` + SĐT riêng, mọi đơn/
 * giỏ/thanh toán/tồn test tạo ra truy ngược được về email đó và bị dọn ở teardown của fixture — kể cả khi test đỏ
 * (teardown của fixture luôn chạy). Tồn: test chỉ MƯỢN tồn của SKU chung (đã nâng ở boost-stock.mjs); teardown trả đúng
 * số đã giữ bằng phép trừ bù trên inventory_level nên các test không giành tồn của nhau và chạy lại không làm tồn cạn.
 */
export interface Buyer {
  name: string;
  phone: string;
  email: string;
  addressLine: string;
}

/** Cookie giỏ của storefront (apps/storefront/src/lib/cart/cookie.ts). */
const CART_COOKIE = "xs_cart";

/** Danh tính mới: UUID ngẫu nhiên trong email, SĐT di động 091x hợp lệ (không phải số của ai — dải test cục bộ). */
export function newBuyer(label = "khach"): Buyer {
  const phoneTail = String(randomInt(0, 10_000_000)).padStart(7, "0");
  return {
    name: "Nguyễn Thị Ánh Tuyết",
    phone: `091${phoneTail}`,
    email: `${label}+e2e-${randomUUID()}@example.com`,
    addressLine: "12 Phố Điện Biên Phủ, tòa A, căn 305",
  };
}

/** Che SĐT như trang đơn (PII): giữ 4 số đầu + 3 số cuối. */
export const maskPhone = (phone: string): string => `${phone.slice(0, 4)}***${phone.slice(-3)}`;

/** Dọn mọi dữ liệu của `buyer`; còn sót bản ghi → ném lỗi (không để dữ liệu dồn lại âm thầm). */
export async function cleanupBuyer(buyer: Buyer, cartIds: string[] = []): Promise<void> {
  const left = await cleanupIdentity(buyer.email, cartIds);
  if (left !== 0) throw new Error(`Dọn dữ liệu E2E chưa sạch: còn ${left} bản ghi của ${buyer.email}`);
}

interface Fixtures {
  /** Khách riêng của test; dọn ở teardown. */
  buyer: Buyer;
  /** Đăng ký mã giỏ tạo trực tiếp qua API để teardown dọn (giỏ tạo qua UI được tìm theo cookie/đơn/email). */
  trackCart: (cartId: string) => void;
}

/** Mã giỏ đã đăng ký theo từng buyer (mỗi test một buyer → không lẫn giữa các test). */
const trackedCarts = new WeakMap<Buyer, Set<string>>();

export const test = base.extend<Fixtures>({
  buyer: async ({ context }, use) => {
    const buyer = newBuyer();
    const tracked = new Set<string>();
    trackedCarts.set(buyer, tracked);
    try {
      await use(buyer);
    } finally {
      // Giỏ chưa đặt (cookie còn) và giỏ đã đăng ký; giỏ đã thành đơn tìm qua order_finance.cart_id.
      const cookies = await context.cookies().catch(() => []);
      for (const c of cookies) if (c.name === CART_COOKIE && c.value) tracked.add(c.value);
      await cleanupBuyer(buyer, [...tracked]);
    }
  },
  trackCart: async ({ buyer }, use) => {
    await use((cartId) => void trackedCarts.get(buyer)?.add(cartId));
  },
});

export { expect } from "@playwright/test";
