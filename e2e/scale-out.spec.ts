import type { APIRequestContext, APIResponse } from "@playwright/test";
import { countOrdersFor } from "./cleanup.mjs";
import { storeFixture } from "./db.mjs";
import { PORTS, URLS } from "./env.mjs";
import { expect, test } from "./fixtures";
import { guestJourneyToFilledCheckout, placeCodOrder } from "./helpers";

/**
 * T-095 (ARC-RES-005, ARC-STYLE-004): HAI tiến trình backend chạy song song (9100, 9101), cùng DB + Redis DB 7, không
 * sticky session. Chứng minh tiến trình phục vụ không giữ trạng thái giữa request:
 *  1. bộ cân bằng tải (e2e/lb.mjs) rải từng request luân phiên qua hai bản;
 *  2. luồng chính qua Store API với từng bước cố ý gửi sang bản KHÁC bản trước (giỏ → báo giá → đặt → gửi lại);
 *  3. luồng UI mua COD qua storefront → bộ cân bằng tải: cả hai bản đều phục vụ, không lỗi upstream;
 *  4. giới hạn callback GHN (300 / 10 s / IP) là TỔNG CHUNG của hai bản, không phải 300 mỗi bản.
 * Gọi thẳng từng bản qua 127.0.0.1 để cả hai thấy cùng một IP khách.
 */
const REPLICA = {
  a: `http://127.0.0.1:${PORTS.backend}`,
  b: `http://127.0.0.1:${PORTS.backendB}`,
} as const;
const HANOI_ADDRESS = { province_code: "01", ward_code: "00004", line: "12 Phố Điện Biên Phủ" };
/** Hạn mức callback GHN (apps/backend/src/lib/http/webhook-rate-limit.ts). */
const GHN_LIMIT = 300;
const GHN_WINDOW_MS = 10_000;

const publishableKey = () => {
  const key = process.env.E2E_PUBLISHABLE_KEY;
  if (!key) throw new Error("Thiếu E2E_PUBLISHABLE_KEY — chạy bằng `pnpm e2e`");
  return key;
};

interface LbStats {
  a: number;
  b: number;
  errors: number;
}
const lbStats = async (request: APIRequestContext): Promise<LbStats> =>
  (await (await request.get(`${URLS.backendLb}/__lb/stats`)).json()) as LbStats;

async function okJson<T>(res: APIResponse, step: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as T;
  expect(res.status(), `${step}: ${JSON.stringify(body)}`).toBe(200);
  return body;
}

test.describe("T-095 — hai bản sao backend, không sticky session", () => {
  test("bộ cân bằng tải rải request qua cả hai bản sao (không sticky)", async ({ request }) => {
    // Không đòi luân phiên tuyệt đối: request nền của storefront (ISR, revalidate) có thể chen qua bộ cân bằng tải giữa
    // hai request của test. Chỉ đòi cả hai bản đều phục vụ request của test và bộ đếm của LB tăng ít nhất bằng số đã gửi.
    const s0 = await lbStats(request);
    const replicas: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request.get(`${URLS.backendLb}/health`);
      expect(res.status()).toBe(200);
      replicas.push(res.headers()["x-e2e-replica"] ?? "?");
    }
    const s1 = await lbStats(request);
    expect(new Set(replicas)).toEqual(new Set(["a", "b"]));
    expect(s1.a - s0.a + (s1.b - s0.b)).toBeGreaterThanOrEqual(replicas.length);
    expect(s1.errors - s0.errors).toBe(0);
  });

  test("Store API: mỗi bước sang bản khác — giỏ (A) → báo giá (B) → đặt (A) → gửi lại cùng khoá (B) ra đúng một đơn", async ({
    request,
    buyer,
    trackCart,
  }) => {
    const { regionId, variantId } = await storeFixture();
    const headers = { "x-publishable-api-key": publishableKey() };
    expect(await countOrdersFor(buyer.email)).toBe(0);

    const cart = await okJson<{ cart: { id: string } }>(
      await request.post(`${REPLICA.a}/store/carts`, {
        headers,
        data: { region_id: regionId, items: [{ variant_id: variantId, quantity: 1 }] },
      }),
      "tạo giỏ ở A",
    );
    const quoted = await okJson<{
      quote: { id: string; cart_id: string; cart_version: number; total: number };
    }>(
      await request.post(`${REPLICA.b}/store/x/checkout/quote`, {
        headers,
        data: { cart_id: cart.cart.id, payment_method: "cod", address: HANOI_ADDRESS },
      }),
      "báo giá ở B",
    );
    trackCart(cart.cart.id);
    expect(quoted.quote.cart_id).toBe(cart.cart.id);
    expect(Number.isSafeInteger(quoted.quote.total) && quoted.quote.total > 0).toBe(true);

    const submitBody = {
      cart_id: quoted.quote.cart_id,
      cart_version: quoted.quote.cart_version,
      quote_id: quoted.quote.id,
      payment_method: "cod",
      contact: { name: buyer.name, phone: buyer.phone, email: buyer.email },
      address: HANOI_ADDRESS,
    };
    const key = `scale-out-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const submitOn = (base: string) =>
      request.post(`${base}/store/x/checkout/submit`, {
        headers: { ...headers, "Idempotency-Key": key },
        data: submitBody,
      });
    const placed = await okJson<{ order: { id: string; display_ref: string; total: number } }>(
      await submitOn(REPLICA.a),
      "đặt hàng ở A",
    );
    expect(placed.order.total).toBe(quoted.quote.total);
    // Gửi lại (thử lại mạng) sang bản B: khoá idempotency nằm ở DB chung → cùng đơn, không đơn thứ hai.
    const replay = await okJson<{ order: { id: string; display_ref: string } }>(
      await submitOn(REPLICA.b),
      "gửi lại ở B",
    );
    expect(replay.order.id).toBe(placed.order.id);
    expect(replay.order.display_ref).toBe(placed.order.display_ref);
    expect(await countOrdersFor(buyer.email)).toBe(1);
  });

  test("luồng UI mua COD qua bộ cân bằng tải: cả hai bản sao phục vụ, không lỗi upstream, đúng một đơn", async ({
    page,
    request,
    buyer,
  }) => {
    expect(await countOrdersFor(buyer.email)).toBe(0);
    const s0 = await lbStats(request);
    await guestJourneyToFilledCheckout(page, "cod", buyer);
    const ref = await placeCodOrder(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(ref);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(ref);
    const s1 = await lbStats(request);
    expect(s1.errors - s0.errors).toBe(0);
    expect(s1.a - s0.a, "bản A không nhận request nào của luồng").toBeGreaterThanOrEqual(3);
    expect(s1.b - s0.b, "bản B không nhận request nào của luồng").toBeGreaterThanOrEqual(3);
    expect(await countOrdersFor(buyer.email)).toBe(1);
  });

  test("giới hạn callback GHN là tổng chung của hai bản sao: 600 callback chia đều → chỉ 300 lượt qua", async ({
    request,
  }) => {
    // Cửa sổ 10 s theo đồng hồ: bắt đầu ở đầu một cửa sổ để cả đợt (vài giây) nằm trong một cửa sổ → phép đếm chính xác.
    const elapsed = Date.now() % GHN_WINDOW_MS;
    if (elapsed > 1_000) await new Promise((r) => setTimeout(r, GHN_WINDOW_MS - elapsed + 50));
    const startedAt = Date.now();

    const results: Array<{ replica: "a" | "b"; status: number; retryAfter: string | undefined }> = [];
    for (let batch = 0; batch < 10; batch += 1) {
      const sent = await Promise.all(
        Array.from({ length: 60 }, async (_, i) => {
          const replica = i % 2 === 0 ? "a" : "b";
          const res = await request.post(`${REPLICA[replica]}/x/webhooks/shipping/ghn`, {
            data: { OrderCode: "scale-out" },
          });
          return { replica, status: res.status(), retryAfter: res.headers()["retry-after"] } as const;
        }),
      );
      results.push(...sent);
    }
    const finishedAt = Date.now();

    const passed = results.filter((r) => r.status !== 429);
    const limited = results.filter((r) => r.status === 429);
    expect(passed.every((r) => r.status === 400)).toBe(true); // tới handler: payload lạ → INVALID_CALLBACK
    // Bộ đếm theo tiến trình sẽ cho mỗi bản 300 → cả 600 qua. Bộ đếm chung: đúng 300 trong một cửa sổ; nếu đợt vắt qua
    // ranh giới (máy chậm) cửa sổ trượt chỉ nhả thêm phần tỉ lệ thời gian đã trôi.
    const sameWindow = Math.floor(startedAt / GHN_WINDOW_MS) === Math.floor(finishedAt / GHN_WINDOW_MS);
    const slack = sameWindow ? 0 : Math.ceil((GHN_LIMIT * (finishedAt - startedAt)) / GHN_WINDOW_MS);
    expect(passed.length).toBeGreaterThanOrEqual(sameWindow ? GHN_LIMIT : 1);
    expect(passed.length).toBeLessThanOrEqual(GHN_LIMIT + slack);
    // Cả hai bản đều chặn (không phải một bản hết hạn mức riêng), và mọi 429 kèm Retry-After hợp lệ.
    expect(limited.filter((r) => r.replica === "a").length).toBeGreaterThan(0);
    expect(limited.filter((r) => r.replica === "b").length).toBeGreaterThan(0);
    for (const r of limited) {
      const after = Number(r.retryAfter);
      expect(Number.isInteger(after), `Retry-After của bản ${r.replica}: ${r.retryAfter}`).toBe(true);
      expect(after).toBeGreaterThanOrEqual(1);
      expect(after).toBeLessThanOrEqual((2 * GHN_WINDOW_MS) / 1000);
    }
  });
});
