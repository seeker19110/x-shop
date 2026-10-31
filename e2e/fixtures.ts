import { randomInt, randomUUID } from "node:crypto";
import { expect, test as base, type APIRequestContext } from "@playwright/test";
import { cleanupIdentity } from "./cleanup.mjs";
import { E2E_ADMIN, URLS } from "./env.mjs";

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

/** Payload XSS dùng chung (T-180, SEC-WEB-004): mỗi chuỗi tự đặt cờ `window.__xss` nếu bị thực thi. */
export const XSS_PAYLOADS = {
  img: '<img src=x onerror="window.__xss=1;alert(1)">',
  link: '<a href="javascript:window.__xss=1;alert(1)">bấm</a> javascript:alert(1)',
  svg: '"><svg onload="window.__xss=1;alert(1)">',
  /** Đóng thẻ script sớm trong JSON-LD (nhúng trong `<script type="application/ld+json">`). */
  script: '</script><img src=x onerror="window.__xss=1">',
} as const;

/** URL ảnh nguy hiểm cho thumbnail (nhánh safeImgSrc của storefront). */
export const XSS_BAD_THUMBNAILS = [
  "javascript:window.__xss=1;alert(1)",
  "data:text/html,<script>window.__xss=1</script>",
] as const;

/** Admin API từ chối handle chứa payload (kiểm ở xss-probe.spec.ts): handle seed phải là slug hợp lệ. */
export const XSS_BAD_HANDLE = `x${XSS_PAYLOADS.svg}`;

/** Handle gốc của sản phẩm/danh mục demo bị đổi nội dung trong lúc probe (trả lại ở teardown). */
const XSS_PRODUCT_HANDLE = "that-lung-da-bo";
const XSS_CATEGORY_HANDLE = "that-lung";

export interface XssContent {
  /** Handle của sản phẩm đã seed: backend CHẶN handle không phải slug (400) nên dùng slug mang chữ của payload. */
  productHandle: string;
  /** Tên chứa payload của sản phẩm/danh mục đã seed. */
  productTitle: string;
  categoryName: string;
  /** Handle gốc (danh mục không đổi handle: cắm payload ở tên và mô tả). */
  categoryHandle: string;
  /** Mã trạng thái Admin API trả khi đặt handle chứa payload (kỳ vọng 400: nhập liệu bị chặn từ gốc). */
  badHandleStatus: number;
  /** Đặt thumbnail sản phẩm = `url` qua Admin API; trả mã trạng thái (400 = bị chặn từ gốc, 200 = đã lưu, được trả lại ở teardown). */
  setThumbnail: (url: string) => Promise<number>;
}

const publishableKey = (): string => {
  const key = process.env.E2E_PUBLISHABLE_KEY;
  if (key === undefined || key === "") throw new Error("Thiếu E2E_PUBLISHABLE_KEY — chạy bằng `pnpm e2e`");
  return key;
};

async function adminHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${URLS.backendLb}/auth/user/emailpass`, { data: E2E_ADMIN });
  expect(res.status(), "đăng nhập admin E2E").toBe(200);
  return { authorization: `Bearer ${String(((await res.json()) as { token: string }).token)}` };
}

/**
 * Seed nội dung độc hại bằng Admin API (đúng đường nhập liệu thật: sửa sản phẩm/danh mục demo đã có — publish guard,
 * read model và webhook vô hiệu hoá cache chạy như production). Trả hàm `restore` đưa mọi thứ về nguyên trạng.
 */
export async function seedXssContent(
  request: APIRequestContext,
): Promise<{ content: XssContent; restore: () => Promise<void> }> {
  const admin = await adminHeaders(request);
  const pdp = await request.get(`${URLS.backendLb}/store/x/products/${XSS_PRODUCT_HANDLE}`, {
    headers: { "x-publishable-api-key": publishableKey() },
  });
  expect(pdp.status()).toBe(200);
  const productId = ((await pdp.json()) as { product_id: string }).product_id;
  const prodRes = await request.get(
    `${URLS.backendLb}/admin/products/${productId}?fields=id,title,handle,description,thumbnail`,
    { headers: admin },
  );
  const orig = (
    (await prodRes.json()) as {
      product: { title: string; handle: string; description: string | null; thumbnail: string | null };
    }
  ).product;
  const catRes = await request.get(
    `${URLS.backendLb}/admin/product-categories?handle=${XSS_CATEGORY_HANDLE}&fields=id,name,description`,
    { headers: admin },
  );
  const cat = (
    (await catRes.json()) as {
      product_categories: { id: string; name: string; description: string | null }[];
    }
  ).product_categories[0];
  if (cat === undefined) throw new Error(`Không thấy danh mục ${XSS_CATEGORY_HANDLE}`);

  const content: XssContent = {
    productHandle: "xssprobe-img-src-x-onerror-alert-1",
    productTitle: `XSSPROBE ${XSS_PAYLOADS.img} ${XSS_PAYLOADS.svg}`,
    categoryName: `XSSCAT ${XSS_PAYLOADS.img}`,
    categoryHandle: XSS_CATEGORY_HANDLE,
    badHandleStatus: (
      await request.post(`${URLS.backendLb}/admin/products/${productId}`, {
        headers: admin,
        data: { handle: XSS_BAD_HANDLE },
      })
    ).status(),
    setThumbnail: async (url) =>
      (
        await request.post(`${URLS.backendLb}/admin/products/${productId}`, {
          headers: admin,
          data: { thumbnail: url },
        })
      ).status(),
  };
  const description = `${XSS_PAYLOADS.link} ${XSS_PAYLOADS.svg} ${XSS_PAYLOADS.img} ${XSS_PAYLOADS.script}`;
  const put = async (url: string, data: object, what: string) => {
    const r = await request.post(`${URLS.backendLb}${url}`, { headers: admin, data });
    expect(r.status(), `${what}: ${await r.text()}`).toBe(200);
  };
  const restore = async () => {
    const errors: unknown[] = [];
    try {
      await put(
        `/admin/products/${productId}`,
        { title: orig.title, handle: orig.handle, description: orig.description, thumbnail: orig.thumbnail },
        "trả sản phẩm",
      );
    } catch (e) {
      errors.push(e);
    }
    try {
      // Giữ null gốc của description (không đổi thành "").
      await put(
        `/admin/product-categories/${cat.id}`,
        { name: cat.name, description: cat.description },
        "trả danh mục",
      );
    } catch (e) {
      errors.push(e);
    }
    if (errors.length > 0) throw new AggregateError(errors, "Trả nội dung catalog sau probe XSS thất bại");
  };
  try {
    await put(
      `/admin/products/${productId}`,
      { title: content.productTitle, handle: content.productHandle, description },
      "seed sản phẩm",
    );
    await put(
      `/admin/product-categories/${cat.id}`,
      { name: content.categoryName, description },
      "seed danh mục",
    );
  } catch (e) {
    await restore();
    throw e;
  }
  return { content, restore };
}

interface Fixtures {
  /** Nội dung catalog chứa payload XSS (T-180); trả lại nguyên trạng ở teardown. */
  xssContent: XssContent;
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
  xssContent: async ({ request }, use) => {
    const { content, restore } = await seedXssContent(request);
    try {
      await use(content);
    } finally {
      await restore();
    }
  },
  trackCart: async ({ buyer }, use) => {
    await use((cartId) => void trackedCarts.get(buyer)?.add(cartId));
  },
});

export { expect } from "@playwright/test";
