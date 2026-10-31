// @vitest-environment node
import { catalogRevalidate as protocol, EMPTY_FILTER } from "@x-shop/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG_REVALIDATE_S } from "../cache-policy";
import { resetEnvCacheForTests } from "../env";
import { getProduct, getProductFresh, listProducts } from "./client";

/**
 * T-142 (D-070, BE-CACHE-007) — "sửa giá rồi đọc PDP ngay thấy giá mới": fetch catalog gắn tag, webhook đã ký của
 * backend tới `/api/revalidate` → `revalidateTag(tag, { expire: 0 })` → lần đọc KẾ TIẾP nạp lại nguồn. Bộ nhớ đệm dữ liệu
 * của Next không chạy dưới vitest → mô hình tối thiểu đặt SAU `fetch` theo đúng ngữ nghĩa Next 16:
 *  - `next.revalidate` TTL + stale-while-revalidate (như cache-policy.test.ts);
 *  - `next.tags` gắn vào mục; `revalidateTag(tag, { expire: 0 })` → mục hết hạn NGAY (lần đọc sau chặn chờ nguồn —
 *    `tags-manifest.external.js`, nhánh `isImmediatelyExpired`); `revalidateTag(tag, "max")` → mục chỉ thành CŨ (lần đọc
 *    sau vẫn nhận bản cũ rồi làm mới nền).
 */

type NextInit = RequestInit & { next?: { revalidate?: number; tags?: string[] } };

const model = vi.hoisted(() => {
  const store = new Map<
    string,
    { at: number; body: string; status: number; tags: string[]; stale: boolean }
  >();
  const inits: Array<{ url: string; init: NextInit | undefined }> = [];
  return {
    store,
    inits,
    revalidateTag(tag: string, profile: string | { expire?: number }) {
      for (const [k, e] of store) {
        if (!e.tags.includes(tag)) continue;
        if (typeof profile === "object" && profile.expire === 0) store.delete(k);
        else e.stale = true;
      }
    },
  };
});
vi.mock("next/cache", () => ({ revalidateTag: vi.fn(model.revalidateTag) }));

const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(join(process.cwd(), "src/lib/catalog/__fixtures__/backend", `${name}.json`), "utf8"),
  ) as T;

function nextDataCache(source: (url: string) => Response) {
  const origin = vi.fn((url: string) => source(url));
  const fetchFn = vi.fn(async (input: string | URL, init?: NextInit) => {
    const url = String(input);
    model.inits.push({ url, init });
    const ttlS = init?.cache === "no-store" ? 0 : (init?.next?.revalidate ?? 0);
    const hit = model.store.get(url);
    const toResponse = (e: { body: string; status: number }) =>
      new Response(e.body, { status: e.status, headers: { "content-type": "application/json" } });
    if (ttlS > 0 && hit !== undefined) {
      if (!hit.stale && Date.now() - hit.at < ttlS * 1000) return toResponse(hit);
      const fresh = origin(url); // làm mới nền: người đọc hiện tại vẫn nhận bản cũ
      if (fresh.ok) {
        model.store.set(url, { ...hit, at: Date.now(), body: await fresh.text(), stale: false });
      }
      return toResponse(hit);
    }
    const res = origin(url);
    if (ttlS > 0 && res.ok) {
      const body = await res.clone().text();
      model.store.set(url, {
        at: Date.now(),
        body,
        status: res.status,
        tags: init?.next?.tags ?? [],
        stale: false,
      });
    }
    return res;
  });
  return { fetchFn, origin };
}

const SECRET = "khoa-revalidate-thu-nghiem-0123456789abcdef";
let seq = 0;

/** Webhook backend gửi (cùng hàm ký `@x-shop/domain` mà backend dùng — lib/catalog/revalidate.ts của backend). */
function webhook(tags: string[], opts: { secret?: string } = {}): Request {
  const body = JSON.stringify({ id: `catalog.revalidate:w:${++seq}`, tags });
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = `nonce-model-${String(seq).padStart(12, "0")}`;
  return new Request("http://sf.test/api/revalidate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [protocol.REVALIDATE_HEADERS.timestamp]: ts,
      [protocol.REVALIDATE_HEADERS.nonce]: nonce,
      [protocol.REVALIDATE_HEADERS.signature]: protocol.signRevalidate(
        opts.secret ?? SECRET,
        ts,
        nonce,
        body,
      ),
    },
    body,
  });
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

interface ProductBody {
  handle: string;
  variants: Array<{ price: number }>;
}
interface ListBody {
  items: Array<{ title: string; handle: string }>;
}

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-27T03:00:00Z"));
  process.env.XS_DATA_SOURCE = "backend";
  process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
  process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = "pk_test_123";
  process.env.CATALOG_REVALIDATE_SECRET = SECRET;
  resetEnvCacheForTests();
  model.store.clear();
  model.inits.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...saved };
  resetEnvCacheForTests();
});

/** Nguồn backend: giá PDP + tên sản phẩm đầu danh sách thay được giữa chừng. */
function backend() {
  const state = { price: 300_000, title: "Tên cũ" };
  const { fetchFn, origin } = nextDataCache((url) => {
    if (url.includes("/store/x/products/")) {
      const p = fixture<ProductBody>("product");
      for (const v of p.variants) v.price = state.price;
      return json(p);
    }
    const l = fixture<ListBody>("list");
    l.items[0]!.title = state.title;
    return json(l);
  });
  vi.stubGlobal("fetch", fetchFn);
  const handle = fixture<ProductBody>("product").handle;
  return {
    state,
    origin,
    handle,
    pdpPrice: async () => (await getProduct(handle))?.variants[0]?.price,
    listTitle: async () => (await listProducts(EMPTY_FILTER)).items[0]!.title,
  };
}

describe("sửa giá rồi đọc PDP ngay thấy giá mới (webhook → revalidateTag)", () => {
  it("không webhook: trong TTL vẫn giá cũ (đối chứng); có webhook: lần đọc NGAY SAU thấy giá mới", async () => {
    const { POST } = await import("../../app/api/revalidate/route");
    const b = backend();
    expect(await b.pdpPrice()).toBe(300_000);
    b.state.price = 250_000; // admin sửa giá ở backend
    vi.advanceTimersByTime(1000);
    expect(await b.pdpPrice()).toBe(300_000); // cache TTL 60 s: chưa có sự kiện thì còn giá cũ
    const res = await POST(webhook(["catalog:list", `product:${b.handle}`]));
    expect(res.status).toBe(200);
    expect(await b.pdpPrice()).toBe(250_000); // không phải chờ hết TTL, không một lần đọc cũ nào nữa
    expect(CATALOG_REVALIDATE_S).toBeGreaterThan(1);
  });

  it("chỉ làm mới đúng tag: webhook PDP không nạp lại danh sách; webhook catalog:list nạp lại danh sách", async () => {
    const { POST } = await import("../../app/api/revalidate/route");
    const b = backend();
    await b.pdpPrice();
    expect(await b.listTitle()).toBe("Tên cũ");
    const listCalls = () => b.origin.mock.calls.filter(([u]) => !u.includes("/store/x/products/")).length;
    b.state.title = "Tên mới";
    await POST(webhook([`product:${b.handle}`]));
    expect(await b.listTitle()).toBe("Tên cũ");
    expect(listCalls()).toBe(1);
    await POST(webhook(["catalog:list"]));
    expect(await b.listTitle()).toBe("Tên mới");
  });

  it("tag `catalog` (vượt trần gộp ở backend) làm mới cả PDP lẫn danh sách", async () => {
    const { POST } = await import("../../app/api/revalidate/route");
    const b = backend();
    await b.pdpPrice();
    await b.listTitle();
    b.state.price = 199_000;
    b.state.title = "Tên mới";
    await POST(webhook(["catalog"]));
    expect(await b.pdpPrice()).toBe(199_000);
    expect(await b.listTitle()).toBe("Tên mới");
  });

  it("webhook chữ ký sai → 401, cache giữ nguyên (vẫn giá cũ tới TTL)", async () => {
    const { POST } = await import("../../app/api/revalidate/route");
    const b = backend();
    await b.pdpPrice();
    b.state.price = 1;
    const res = await POST(webhook([`product:${b.handle}`], { secret: `${SECRET}-gia` }));
    expect(res.status).toBe(401);
    expect(await b.pdpPrice()).toBe(300_000);
  });

  it('đối chứng ngữ nghĩa: revalidateTag kiểu SWR ("max") vẫn phát giá cũ MỘT lần — vì vậy route dùng { expire: 0 }', async () => {
    const b = backend();
    await b.pdpPrice();
    b.state.price = 250_000;
    model.revalidateTag(`product:${b.handle}`, "max");
    expect(await b.pdpPrice()).toBe(300_000);
    expect(await b.pdpPrice()).toBe(250_000);
  });
});

describe("fetch catalog gắn tag (next.tags)", () => {
  it("PDP: catalog + product:<handle>; danh sách: catalog + catalog:list; đường giá hiện hành no-store không tag", async () => {
    const b = backend();
    await b.pdpPrice();
    await b.listTitle();
    await getProductFresh(b.handle);
    const [pdp, list, fresh] = model.inits;
    expect(pdp!.init?.next).toEqual({
      revalidate: CATALOG_REVALIDATE_S,
      tags: ["catalog", `product:${b.handle}`],
    });
    expect(list!.init?.next).toEqual({ revalidate: CATALOG_REVALIDATE_S, tags: ["catalog", "catalog:list"] });
    expect(fresh!.init?.cache).toBe("no-store");
    expect(fresh!.init?.next).toBeUndefined();
  });

  it("handle Unicode được encode trong tag (khớp tag backend dựng)", async () => {
    backend();
    await getProduct("áo sơ mi");
    expect(model.inits[0]!.init?.next?.tags).toEqual(["catalog", protocol.productTag("áo sơ mi")]);
  });
});
