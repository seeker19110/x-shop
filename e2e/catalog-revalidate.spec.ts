import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_ADMIN, URLS } from "./env.mjs";

/**
 * T-142 (D-070, BE-CACHE-007) — "sửa giá rồi đọc PDP ngay thấy giá mới" trên hệ thật: Admin API sửa giá (backend thật,
 * hai bản sao) → subscriber + lượt xả read model → outbox → webhook ký HMAC tới `/api/revalidate` của storefront
 * `next start` → `revalidateTag(…, { expire: 0 })` → PDP (cache dữ liệu thật của Next 16, TTL 60 giây) hiện giá mới sau
 * vài giây thay vì sau TTL. Không có webhook (mã cũ) thì trong 60 giây PDP vẫn giá cũ → test đỏ.
 *
 * Chỉ chạy ở project desktop (không phụ thuộc viewport). Dùng sản phẩm phụ kiện cuối danh mục demo (luồng mua của spec khác
 * đi qua danh mục "Nữ") và trả giá cũ khi xong.
 */

const HANDLE = "that-lung-da-bo";
const NEW_PRICE = 987_000;
/** Ngân sách thấy giá mới — nhỏ hơn hẳn TTL 60 giây (cửa sổ gộp 2 s + lượt xả + gửi). */
const FRESH_WITHIN_MS = 15_000;
const vnd = (n: number) => new Intl.NumberFormat("vi-VN").format(n);

const publishableKey = () => {
  const key = process.env.E2E_PUBLISHABLE_KEY;
  if (!key) throw new Error("Thiếu E2E_PUBLISHABLE_KEY — chạy bằng `pnpm e2e`");
  return key;
};

interface Variant {
  id: string;
  prices: { amount: number; currency_code: string }[];
}

async function adminAuth(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${URLS.backendLb}/auth/user/emailpass`, { data: E2E_ADMIN });
  expect(res.status(), "đăng nhập admin E2E").toBe(200);
  return { authorization: `Bearer ${String(((await res.json()) as { token: string }).token)}` };
}

async function setPrices(
  request: APIRequestContext,
  admin: Record<string, string>,
  productId: string,
  prices: Map<string, number>,
): Promise<void> {
  for (const [variantId, amount] of prices) {
    const res = await request.post(`${URLS.backendLb}/admin/products/${productId}/variants/${variantId}`, {
      headers: admin,
      data: { prices: [{ amount, currency_code: "vnd" }] },
    });
    expect(res.status(), `sửa giá biến thể ${variantId}`).toBe(200);
  }
}

/** HTML PDP do storefront dựng (cache dữ liệu catalog của Next phía server). */
async function pdpHtml(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${URLS.storefront}/san-pham/${HANDLE}`);
  expect(res.status()).toBe(200);
  return res.text();
}

/** Thời gian (ms) tới khi PDP chứa `text`; quá hạn → ném lỗi. */
async function msUntilPdpShows(request: APIRequestContext, text: string, budgetMs: number): Promise<number> {
  const start = Date.now();
  for (;;) {
    if ((await pdpHtml(request)).includes(text)) return Date.now() - start;
    if (Date.now() - start > budgetMs) throw new Error(`PDP chưa hiện "${text}" sau ${budgetMs} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

test.describe("vô hiệu hoá cache catalog theo sự kiện (T-142)", () => {
  test("sửa giá ở Admin → PDP storefront hiện giá mới sau vài giây, không chờ TTL 60 s", async ({
    request,
  }, info) => {
    test.skip(info.project.name !== "desktop", "luồng API + HTML, không phụ thuộc viewport");
    const admin = await adminAuth(request);
    const pdp = await request.get(`${URLS.backendLb}/store/x/products/${HANDLE}`, {
      headers: { "x-publishable-api-key": publishableKey() },
    });
    const productId = ((await pdp.json()) as { product_id: string }).product_id;
    const detail = await request.get(
      `${URLS.backendLb}/admin/products/${productId}?fields=id,*variants,*variants.prices`,
      { headers: admin },
    );
    expect(detail.status()).toBe(200);
    const variants = ((await detail.json()) as { product: { variants: Variant[] } }).product.variants;
    const original = new Map(
      variants.map((v) => [v.id, v.prices.find((p) => p.currency_code === "vnd")!.amount] as const),
    );
    expect(original.size).toBeGreaterThan(0);

    // Nạp PDP vào cache dữ liệu của Next (hai lần: lần sau chắc chắn là bản đã cache).
    const before = await pdpHtml(request);
    await pdpHtml(request);
    expect(before).not.toContain(vnd(NEW_PRICE));

    try {
      await setPrices(request, admin, productId, new Map([...original.keys()].map((id) => [id, NEW_PRICE])));
      const ms = await msUntilPdpShows(request, vnd(NEW_PRICE), FRESH_WITHIN_MS);
      test.info().annotations.push({ type: "fresh-after-ms", description: String(ms) });
      expect(ms).toBeLessThan(FRESH_WITHIN_MS);
    } finally {
      // Trả giá cũ (cũng đi qua webhook) để spec sau thấy dữ liệu demo như cũ.
      await setPrices(request, admin, productId, original);
      const oldPrice = Math.min(...original.values());
      await msUntilPdpShows(request, vnd(oldPrice), FRESH_WITHIN_MS);
    }
  });
});
