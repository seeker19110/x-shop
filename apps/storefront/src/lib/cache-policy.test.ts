// @vitest-environment node
import { EMPTY_FILTER } from "@x-shop/domain";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as countRoute } from "../app/api/catalog/count/route";
import { GET as suggestRoute } from "../app/api/catalog/suggest/route";
import {
  ADDRESS_API_CACHE_CONTROL,
  ADDRESS_API_MAX_AGE_S,
  ADDRESS_API_S_MAXAGE_S,
  ADDRESS_API_SWR_S,
  ADDRESS_REVALIDATE_S,
  CATALOG_API_CACHE_CONTROL,
  CATALOG_API_S_MAXAGE_S,
  CATALOG_API_SWR_S,
  CATALOG_REVALIDATE_S,
  maxStalenessS,
  parseCacheControl,
} from "./cache-policy";
import { getProductFresh, listProducts } from "./catalog/client";
import { getWards } from "./checkout/address";
import { resetEnvCacheForTests } from "./env";

/**
 * BE-CACHE-007: chiến lược vô hiệu hoá của từng loại cache (docs/ops/CACHE.md) + test "cập nhật nguồn → đọc sau đó
 * không nhận bản cũ quá ngưỡng". Bộ nhớ đệm dữ liệu của Next không chạy được dưới vitest nên dùng một mô hình TTL tối
 * thiểu đặt SAU `fetch` (đúng ngữ nghĩa `next.revalidate` / `cache: "no-store"` mà mã thật truyền vào).
 */
const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(join(process.cwd(), "src/lib/catalog/__fixtures__/backend", `${name}.json`), "utf8"),
  ) as T;

interface ListBody {
  items: Array<{ title: string }>;
  total: number;
}

/**
 * Mô hình cache dữ liệu của Next 16 (theo `next/dist/server/lib/patch-fetch.js`, nhánh `entry.isStale`):
 *  - chưa có mục → gọi nguồn (chặn), lỗi thì báo lỗi;
 *  - mục còn hạn (`next.revalidate = N` giây) → dùng lại;
 *  - mục HẾT hạn → TRẢ NGAY BẢN CŨ rồi làm mới nền (stale-while-revalidate); làm mới lỗi (không phải 200) thì giữ bản
 *    cũ và thử lại ở request sau;
 *  - `cache: "no-store"` → luôn gọi nguồn.
 */
function nextDataCacheOver(source: (url: string) => Response) {
  const store = new Map<string, { at: number; res: Response }>();
  const origin = vi.fn((url: string) => source(url));
  const cached = vi.fn(
    async (input: string | URL, init?: RequestInit & { next?: { revalidate?: number } }) => {
      const url = String(input);
      const ttlS = init?.cache === "no-store" ? 0 : (init?.next?.revalidate ?? 0);
      const hit = store.get(url);
      if (ttlS > 0 && hit !== undefined) {
        if (Date.now() - hit.at < ttlS * 1000) return hit.res.clone();
        const fresh = origin(url); // làm mới nền: người đọc hiện tại vẫn nhận bản cũ
        if (fresh.ok) store.set(url, { at: Date.now(), res: fresh.clone() });
        return hit.res.clone();
      }
      const res = origin(url);
      if (ttlS > 0 && res.ok) store.set(url, { at: Date.now(), res: res.clone() });
      return res;
    },
  );
  return { cached, origin };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T03:00:00Z"));
  process.env.XS_DATA_SOURCE = "backend";
  process.env.MEDUSA_BACKEND_URL = "http://backend.test:9000";
  process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = "pk_test_123";
  resetEnvCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  process.env = { ...saved };
  resetEnvCacheForTests();
});

describe("cache dữ liệu catalog (next.revalidate): cập nhật nguồn → đọc lại", () => {
  function setup() {
    let title = "Tên cũ";
    const { cached, origin } = nextDataCacheOver(() => {
      const body = fixture<ListBody>("list");
      body.items[0]!.title = title;
      return json(body);
    });
    vi.stubGlobal("fetch", cached);
    return {
      origin,
      rename: (t: string) => {
        title = t;
      },
      read: async () => (await listProducts(EMPTY_FILTER)).items[0]!.title,
    };
  }

  it("trong TTL còn bản cũ; hết TTL lần đọc ĐẦU vẫn trả bản cũ (SWR) và làm mới nền; lần kế tiếp thấy bản mới", async () => {
    const t = setup();
    expect(await t.read()).toBe("Tên cũ");
    t.rename("Tên mới");
    vi.advanceTimersByTime((CATALOG_REVALIDATE_S - 1) * 1000);
    expect(await t.read()).toBe("Tên cũ"); // còn 1 giây trước khi hết hạn
    expect(t.origin).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); // đúng TTL: mục hết hạn
    expect(await t.read()).toBe("Tên cũ"); // SWR: vẫn phát bản cũ…
    expect(t.origin).toHaveBeenCalledTimes(2); // …nhưng đã kích làm mới nền
    expect(await t.read()).toBe("Tên mới");
    expect(t.origin).toHaveBeenCalledTimes(2);
  });

  it("khoá ít người xem: không ai đọc 1 giờ → lần đọc đầu vẫn là bản cũ tuổi 3600 giây (trần là TTL + khoảng giữa hai request)", async () => {
    const t = setup();
    await t.read();
    t.rename("Tên mới");
    vi.advanceTimersByTime(3600 * 1000);
    expect(3600).toBeGreaterThan(CATALOG_REVALIDATE_S);
    expect(await t.read()).toBe("Tên cũ");
    expect(await t.read()).toBe("Tên mới");
  });

  it("đường giá/tồn hiện hành (getProductFresh, no-store) thấy ngay bản mới, không chờ TTL", async () => {
    let price = 100;
    const { cached, origin } = nextDataCacheOver(() => {
      const p = fixture<{ variants: Array<{ price: number }> }>("product");
      p.variants[0]!.price = price;
      return json(p);
    });
    vi.stubGlobal("fetch", cached);
    const read = async () => (await getProductFresh("ao-so-mi"))?.variants[0]?.price;
    const first = await read();
    price = 250_000;
    const second = await read();
    expect(second).not.toBe(first);
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it("nguồn lỗi sau khi hết hạn → vẫn phát bản cũ (không báo lỗi); nguồn hồi lại thì lần kế tiếp thấy bản mới", async () => {
    let fail = false;
    let title = "Tên cũ";
    const { cached } = nextDataCacheOver(() => {
      if (fail) return new Response("x", { status: 502 });
      const body = fixture<ListBody>("list");
      body.items[0]!.title = title;
      return json(body);
    });
    vi.stubGlobal("fetch", cached);
    const read = async () => (await listProducts(EMPTY_FILTER)).items[0]!.title;
    expect(await read()).toBe("Tên cũ");
    fail = true;
    vi.advanceTimersByTime(CATALOG_REVALIDATE_S * 1000);
    expect(await read()).toBe("Tên cũ");
    expect(await read()).toBe("Tên cũ"); // làm mới lỗi: giữ bản cũ
    fail = false;
    title = "Tên mới";
    expect(await read()).toBe("Tên cũ"); // lần này kích làm mới thành công
    expect(await read()).toBe("Tên mới");
  });

  it("chưa có bản nào trong cache mà nguồn lỗi → báo lỗi", async () => {
    const { cached } = nextDataCacheOver(() => new Response("x", { status: 502 }));
    vi.stubGlobal("fetch", cached);
    await expect(listProducts(EMPTY_FILTER)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("cache danh mục tỉnh/phường (TTL dài)", () => {
  const first = async () => {
    const r = await getWards("01");
    return r.status === "ok" ? r.wards[0]?.name : r.status;
  };

  it("cập nhật nguồn: cũ trước 24 giờ; hết hạn lần đọc đầu vẫn cũ (SWR), lần sau mới", async () => {
    let name = "Phường cũ";
    const { cached } = nextDataCacheOver(() => json({ wards: [{ code: "00001", name }] }));
    vi.stubGlobal("fetch", cached);
    expect(await first()).toBe("Phường cũ");
    name = "Phường mới";
    vi.advanceTimersByTime((ADDRESS_REVALIDATE_S - 1) * 1000);
    expect(await first()).toBe("Phường cũ");
    vi.advanceTimersByTime(1000);
    expect(await first()).toBe("Phường cũ");
    expect(await first()).toBe("Phường mới");
  });

  it("mã tỉnh sai không chạm nguồn; nguồn lỗi → unavailable (503, retry được); backend 404 → not_found", async () => {
    const { cached, origin } = nextDataCacheOver(() => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", cached);
    expect(await getWards("../x")).toEqual({ status: "not_found" });
    expect(await getWards("")).toEqual({ status: "not_found" });
    expect(origin).not.toHaveBeenCalled();
    expect(await getWards("01")).toEqual({ status: "unavailable" });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    expect(await getWards("99")).toEqual({ status: "not_found" });
  });
});

describe("parseCacheControl / maxStalenessS", () => {
  it("đọc chỉ thị, không phân biệt hoa thường; giá trị sai → null; rỗng → mặc định", () => {
    expect(parseCacheControl("Public, S-MaxAge=60, stale-while-revalidate=300")).toEqual({
      maxAge: null,
      sMaxAge: 60,
      staleWhileRevalidate: 300,
      noStore: false,
      isPrivate: false,
    });
    expect(parseCacheControl("max-age=abc, s-maxage=-1, s-maxage").sMaxAge).toBeNull();
    expect(parseCacheControl("private, no-store")).toMatchObject({ noStore: true, isPrivate: true });
    expect(parseCacheControl("")).toEqual({
      maxAge: null,
      sMaxAge: null,
      staleWhileRevalidate: null,
      noStore: false,
      isPrivate: false,
    });
  });

  it("trần cũ = tuổi origin + s-maxage + stale-while-revalidate; private/no-store chỉ còn tuổi origin", () => {
    expect(maxStalenessS(CATALOG_API_CACHE_CONTROL, CATALOG_REVALIDATE_S)).toBe(60 + 60 + 300);
    expect(maxStalenessS("private, no-store", 0)).toBe(0);
    expect(maxStalenessS("public, max-age=30", 10)).toBe(40);
    expect(maxStalenessS("", 5)).toBe(5);
  });
});

describe("API công khai dùng đúng hằng số Cache-Control", () => {
  beforeEach(() => {
    process.env.XS_DATA_SOURCE = "fixtures";
    delete process.env.MEDUSA_BACKEND_URL;
    resetEnvCacheForTests();
  });

  it("/api/catalog/suggest (kể cả trả rỗng cho truy vấn quá ngắn) và /api/catalog/count", async () => {
    const short = await suggestRoute(new Request("http://x/api/catalog/suggest?q=a"));
    expect(short.headers.get("cache-control")).toBe(CATALOG_API_CACHE_CONTROL);
    const ok = await suggestRoute(new Request("http://x/api/catalog/suggest?q=ao"));
    expect(ok.headers.get("cache-control")).toBe(CATALOG_API_CACHE_CONTROL);
    const count = await countRoute(new Request("http://x/api/catalog/count"));
    expect(count.headers.get("cache-control")).toBe(CATALOG_API_CACHE_CONTROL);
  });

  it("tham số sai (422) không mang Cache-Control công khai để khỏi cache lỗi dùng chung", async () => {
    const bad = await countRoute(new Request("http://x/api/catalog/count?price_min=9&price_max=1"));
    expect(bad.status).toBe(422);
    expect(bad.headers.get("cache-control") ?? "").not.toContain("s-maxage");
  });
});

describe("docs/ops/CACHE.md khớp mã", () => {
  const doc = readFileSync(join(process.cwd(), "../../docs/ops/CACHE.md"), "utf8");

  it("nêu đủ từng loại cache và chiến lược vô hiệu hoá (TTL / sự kiện / phiên bản)", () => {
    for (const heading of [
      "Dữ liệu catalog (fetch phía server)",
      "Trang chủ (ISR)",
      "API công khai của storefront",
      "Danh mục tỉnh/phường",
      "Service worker",
      "Tài nguyên tĩnh",
      "Ảnh sản phẩm",
      "Dữ liệu riêng tư",
      "Retry phía client",
    ]) {
      expect(doc, `thiếu mục "${heading}"`).toContain(heading);
    }
    for (const kind of ["TTL", "Sự kiện", "Phiên bản"]) expect(doc).toContain(kind);
  });

  it("ghi đúng các số trong cache-policy.ts", () => {
    expect(doc).toContain(`\`${CATALOG_API_CACHE_CONTROL}\``);
    expect(doc).toContain(`\`${ADDRESS_API_CACHE_CONTROL}\``);
    expect(doc).toContain(`${CATALOG_REVALIDATE_S} giây`);
    expect(doc).toContain(`${ADDRESS_REVALIDATE_S} giây`);
    expect(doc).toContain(`${maxStalenessS(CATALOG_API_CACHE_CONTROL, CATALOG_REVALIDATE_S)} giây`);
    expect(ADDRESS_API_MAX_AGE_S).toBe(3600);
    expect(ADDRESS_API_S_MAXAGE_S).toBe(ADDRESS_REVALIDATE_S);
    expect(ADDRESS_API_SWR_S).toBeGreaterThan(ADDRESS_API_S_MAXAGE_S);
    expect(CATALOG_API_S_MAXAGE_S).toBe(CATALOG_REVALIDATE_S);
    expect(CATALOG_API_SWR_S).toBeGreaterThan(CATALOG_API_S_MAXAGE_S);
  });

  it("trang chủ revalidate (literal tĩnh) bằng CATALOG_REVALIDATE_S", () => {
    const page = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");
    const m = /export const revalidate = (\d+);/.exec(page);
    expect(m, "app/page.tsx mất `export const revalidate`").not.toBeNull();
    expect(Number(m![1])).toBe(CATALOG_REVALIDATE_S);
  });

  it("CACHE_VERSION của service worker trong tài liệu khớp public/sw.js", () => {
    const sw = readFileSync(join(process.cwd(), "public/sw.js"), "utf8");
    const v = /var CACHE_VERSION = "([^"]+)"/.exec(sw)?.[1];
    expect(v).toBeDefined();
    expect(doc).toContain(`CACHE_VERSION = "${v!}"`);
  });
});
