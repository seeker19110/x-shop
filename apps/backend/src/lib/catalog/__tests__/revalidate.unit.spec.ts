import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { catalogRevalidate as protocol } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { OutboxClaim } from "../../../modules/checkout/service";
import { DEFAULT_OUTBOX_HANDLERS } from "../../checkout/jobs";
import { parseEnv, SECRET_ENV_KEYS } from "../../env";
import { resetShutdownStateForTest, shutdownState } from "../../lifecycle/shutdown";
import { validateOutboxPayload } from "../../outbox/payload";
import { retryInfoOf } from "../../outbox/retry";
import {
  CATALOG_REVALIDATE_EVENT,
  CATALOG_REVALIDATE_POLICY,
  catalogRevalidateHandler,
  enqueueCatalogRevalidation,
  flushRevalidationWindow,
  notifyCatalogChanged,
  planWindow,
  resetRevalidateStateForTests,
  revalidateEventKey,
  RevalidateHttpError,
  sendRevalidation,
  tagsForProducts,
  windowStartMs,
  type RevalidateConfig,
} from "../revalidate";

/**
 * T-142 (D-070, BE-CACHE-007): webhook vô hiệu hoá cache catalog của storefront — gộp theo cửa sổ + trần, ký HMAC, phân
 * loại lỗi cho outbox, lỗi không bao giờ ném ra người gọi (ghi backend không bị chặn).
 */

const SECRET = "khoa-revalidate-thu-nghiem-0123456789abcdef";
const CONFIG: RevalidateConfig = { secret: SECRET, urls: ["http://sf-a.test/api/revalidate"] };
const T0 = new Date("2026-10-27T03:00:00.250Z");
const W = CATALOG_REVALIDATE_POLICY.windowMs;
const START = windowStartMs(T0.getTime());

interface Inserted {
  key: string;
  aggregate: string;
  type: string;
  payload: Record<string, unknown>;
  dueAt: Date | null;
}

function setup(opts: { handles?: Record<string, string>; insertFails?: (key: string) => boolean } = {}) {
  const rows = new Map<string, Inserted>();
  const inserts: string[] = [];
  const sent: string[] = [];
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const handles = opts.handles ?? {};
  const outbox = {
    insertOutbox: jest.fn(
      async (
        key: string,
        aggregate: string,
        type: string,
        payload: Record<string, unknown>,
        _em: unknown,
        dueAt: Date | null,
      ) => {
        // Nhường lượt như truy vấn thật → hai lời gọi đồng thời xen kẽ nhau.
        await new Promise((r) => setImmediate(r));
        if (opts.insertFails?.(key) === true) throw new Error("DB mất kết nối");
        inserts.push(key);
        if (!rows.has(key)) rows.set(key, { key, aggregate, type, payload, dueAt }); // ON CONFLICT DO NOTHING
      },
    ),
    markOutboxSentByKey: jest.fn(async (key: string) => {
      sent.push(key);
    }),
  };
  const product = {
    listProducts: jest.fn(async (filter: { id: string[] }) =>
      filter.id.flatMap((id) => (handles[id] === undefined ? [] : [{ id, handle: handles[id] }])),
    ),
  };
  const container = {
    resolve: (key: string) =>
      key === CHECKOUT_MODULE
        ? outbox
        : key === Modules.PRODUCT
          ? product
          : key === ContainerRegistrationKeys.LOGGER
            ? logger
            : null,
  } as unknown as MedusaContainer;
  return { container, rows, inserts, sent, logger, outbox, product };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(statusFor: (url: string, n: number) => number | Error = () => 200, retryAfter?: string) {
  const calls: Captured[] = [];
  const fn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, headers: init?.headers as Record<string, string>, body: String(init?.body) });
    const status = statusFor(u, calls.length);
    if (status instanceof Error) throw status;
    return new Response("{}", {
      status,
      headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
    });
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const verify = (c: Captured, nowMs = T0.getTime()) =>
  protocol.verifyRevalidate(
    SECRET,
    {
      timestamp: c.headers[protocol.REVALIDATE_HEADERS.timestamp] ?? null,
      nonce: c.headers[protocol.REVALIDATE_HEADERS.nonce] ?? null,
      signature: c.headers[protocol.REVALIDATE_HEADERS.signature] ?? null,
    },
    c.body,
    nowMs,
  );

const ids = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `prod_${String(from + i).padStart(4, "0")}`);

beforeEach(() => resetRevalidateStateForTests());
afterAll(() => resetRevalidateStateForTests());

describe("planWindow — gộp + trần mỗi cửa sổ", () => {
  const empty = () => ({ productIds: new Set<string>(), all: false });

  it("sản phẩm mới → từng sản phẩm; trùng/rỗng bị bỏ", () => {
    expect(planWindow(empty(), { productIds: ["a", "a", "", "b"] })).toEqual({
      all: false,
      productIds: ["a", "b"],
    });
    expect(planWindow({ productIds: new Set(["a"]), all: false }, { productIds: ["a"] })).toEqual({
      all: false,
      productIds: [],
    });
    expect(planWindow(empty(), { productIds: [] })).toEqual({ all: false, productIds: [] });
  });

  it("vượt trần (tính cả sản phẩm đã có trong cửa sổ) → một dòng cả catalog; đúng trần vẫn từng sản phẩm", () => {
    const max = CATALOG_REVALIDATE_POLICY.maxProductsPerWindow;
    expect(planWindow(empty(), { productIds: ids(max) }).productIds).toHaveLength(max);
    expect(planWindow(empty(), { productIds: ids(max + 1) })).toEqual({ all: true, productIds: [] });
    const half = { productIds: new Set(ids(max - 1)), all: false };
    expect(planWindow(half, { productIds: ids(2, max - 1) })).toEqual({ all: true, productIds: [] });
  });

  it("đã có dòng cả catalog → không cần gì thêm; yêu cầu cả catalog → một dòng", () => {
    expect(planWindow({ productIds: new Set(), all: true }, { productIds: ["x"] })).toEqual({
      all: false,
      productIds: [],
    });
    expect(planWindow(empty(), { all: true })).toEqual({ all: true, productIds: [] });
  });
});

describe("enqueueCatalogRevalidation — outbox", () => {
  it("webhook tắt (không có khoá) → không ghi gì", async () => {
    const s = setup();
    expect(
      await enqueueCatalogRevalidation(s.container, { productIds: ["prod_1"] }, { config: null }),
    ).toEqual([]);
    expect(s.outbox.insertOutbox).not.toHaveBeenCalled();
  });

  it("mỗi sản phẩm một dòng/cửa sổ, đến hạn cho dispatcher sau cuối cửa sổ + grace; payload qua schema outbox", async () => {
    const s = setup();
    const keys = await enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_A", "prod_B"] },
      { config: CONFIG, now: T0, schedule: false },
    );
    expect(keys).toEqual([revalidateEventKey(START, "prod_A"), revalidateEventKey(START, "prod_B")]);
    for (const row of s.rows.values()) {
      expect(row.type).toBe(CATALOG_REVALIDATE_EVENT);
      expect(row.dueAt?.getTime()).toBe(START + W + CATALOG_REVALIDATE_POLICY.dispatchGraceMs);
      expect(validateOutboxPayload(row.type, row.payload)).toEqual({ ok: true });
    }
    expect(s.rows.get(revalidateEventKey(START, "prod_A"))).toMatchObject({
      aggregate: "prod_A",
      payload: { scope: "product", product_id: "prod_A" },
    });
  });

  it("gộp: 50 thay đổi liên tiếp của cùng sản phẩm trong một cửa sổ → MỘT dòng; cửa sổ sau → dòng mới", async () => {
    const s = setup();
    for (let i = 0; i < 50; i++) {
      await enqueueCatalogRevalidation(
        s.container,
        { productIds: ["prod_A"] },
        { config: CONFIG, now: new Date(T0.getTime() + (i % 7) * 100), schedule: false },
      );
    }
    expect(s.inserts).toEqual([revalidateEventKey(START, "prod_A")]);
    await enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_A"] },
      { config: CONFIG, now: new Date(START + W), schedule: false },
    );
    expect(s.inserts).toEqual([revalidateEventKey(START, "prod_A"), revalidateEventKey(START + W, "prod_A")]);
  });

  it("trần tần suất: nhiều lô sản phẩm khác nhau trong một cửa sổ → tối đa trần + 1 dòng", async () => {
    const s = setup();
    for (let b = 0; b < 10; b++) {
      await enqueueCatalogRevalidation(
        s.container,
        { productIds: ids(7, b * 7) },
        { config: CONFIG, now: T0, schedule: false },
      );
    }
    expect(s.rows.size).toBeLessThanOrEqual(CATALOG_REVALIDATE_POLICY.maxProductsPerWindow + 1);
    expect(s.rows.has(revalidateEventKey(START, null))).toBe(true);
    expect(s.rows.get(revalidateEventKey(START, null))?.payload).toEqual({ scope: "all" });
  });

  it("đồng thời: 10 lượt xả cùng lúc cho cùng sản phẩm → một dòng trong DB, lượt gửi gộp một webhook", async () => {
    const s = setup({ handles: { prod_A: "ao-a" } });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        enqueueCatalogRevalidation(
          s.container,
          { productIds: ["prod_A"] },
          { config: CONFIG, now: T0, schedule: false },
        ),
      ),
    );
    expect(s.rows.size).toBe(1);
    const f = fakeFetch();
    expect(
      await flushRevalidationWindow(s.container, START, { config: CONFIG, fetch: f.fetch, now: T0 }),
    ).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(s.sent).toEqual([revalidateEventKey(START, "prod_A")]);
  });

  it("ghi outbox lỗi → notifyCatalogChanged KHÔNG ném (ghi backend không bị chặn), chỉ log; lần sau ghi lại được", async () => {
    let fail = true;
    const s = setup({ insertFails: () => fail });
    await expect(
      notifyCatalogChanged(
        s.container,
        { productIds: ["prod_A"] },
        { config: CONFIG, now: T0, schedule: false },
      ),
    ).resolves.toBeUndefined();
    expect(s.logger.error).toHaveBeenCalledWith(expect.stringContaining("Không ghi được outbox"));
    fail = false;
    await notifyCatalogChanged(
      s.container,
      { productIds: ["prod_A"] },
      { config: CONFIG, now: T0, schedule: false },
    );
    expect(s.inserts).toEqual([revalidateEventKey(START, "prod_A")]);
  });

  it("hẹn lượt gửi gộp ở cuối cửa sổ (timer thật, rút gọn bằng fake timers)", async () => {
    jest.useFakeTimers({ now: T0, doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    try {
      const s = setup({ handles: { prod_A: "ao-a", prod_B: "ao-b" } });
      const f = fakeFetch();
      await enqueueCatalogRevalidation(
        s.container,
        { productIds: ["prod_A"] },
        { config: CONFIG, fetch: f.fetch },
      );
      await enqueueCatalogRevalidation(
        s.container,
        { productIds: ["prod_B"] },
        { config: CONFIG, fetch: f.fetch },
      );
      expect(f.calls).toHaveLength(0);
      await jest.advanceTimersByTimeAsync(START + W - T0.getTime());
      expect(f.calls).toHaveLength(1);
      expect(JSON.parse(f.calls[0]!.body)).toEqual({
        id: `${CATALOG_REVALIDATE_EVENT}:w:${START}`,
        tags: ["catalog:list", "product:ao-a", "product:ao-b"],
      });
      expect(s.sent.sort()).toEqual([
        revalidateEventKey(START, "prod_A"),
        revalidateEventKey(START, "prod_B"),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("flushRevalidationWindow", () => {
  it("gửi lỗi → không đánh dấu sent (dispatcher lo), trả false, chỉ log", async () => {
    const s = setup({ handles: { prod_A: "ao-a" } });
    await enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_A"] },
      { config: CONFIG, now: T0, schedule: false },
    );
    const f = fakeFetch(() => 503);
    expect(
      await flushRevalidationWindow(s.container, START, { config: CONFIG, fetch: f.fetch, now: T0 }),
    ).toBe(false);
    expect(s.sent).toEqual([]);
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining("chờ outbox-dispatch"));
  });

  it("cửa sổ có dòng cả catalog → tag `catalog`", async () => {
    const s = setup();
    await enqueueCatalogRevalidation(
      s.container,
      { all: true },
      { config: CONFIG, now: T0, schedule: false },
    );
    const f = fakeFetch();
    await flushRevalidationWindow(s.container, START, { config: CONFIG, fetch: f.fetch, now: T0 });
    expect(JSON.parse(f.calls[0]!.body).tags).toEqual(["catalog"]);
  });

  it("tiến trình đang tắt → không gửi (dòng ở lại cho tiến trình khác)", async () => {
    const s = setup({ handles: { prod_A: "ao-a" } });
    await enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_A"] },
      { config: CONFIG, now: T0, schedule: false },
    );
    shutdownState().draining = true;
    try {
      const f = fakeFetch();
      expect(await flushRevalidationWindow(s.container, START, { config: CONFIG, fetch: f.fetch })).toBe(
        false,
      );
      expect(f.calls).toHaveLength(0);
    } finally {
      resetShutdownStateForTest();
    }
  });

  it("cửa sổ không có gì → false, không gọi mạng", async () => {
    const s = setup();
    const f = fakeFetch();
    expect(await flushRevalidationWindow(s.container, START, { config: CONFIG, fetch: f.fetch })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe("sendRevalidation — chữ ký + phân loại lỗi", () => {
  it("chữ ký kiểm được bằng giao thức chung; mỗi URL một nonce", async () => {
    const f = fakeFetch();
    const cfg = {
      secret: SECRET,
      urls: ["http://sf-a.test/api/revalidate", "http://sf-b.test/api/revalidate"],
    };
    await sendRevalidation(cfg, { id: "e1", tags: ["catalog"] }, { fetch: f.fetch, now: T0 });
    expect(f.calls.map((c) => c.url)).toEqual(cfg.urls);
    for (const c of f.calls) expect(verify(c)).toMatchObject({ ok: true });
    expect(new Set(f.calls.map((c) => c.headers[protocol.REVALIDATE_HEADERS.nonce])).size).toBe(2);
    // Sửa thân sau khi ký → chữ ký sai.
    expect(
      verify({ ...f.calls[0]!, body: f.calls[0]!.body.replace("catalog", "catalog:list") }),
    ).toMatchObject({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("401/409 → lỗi vĩnh viễn (outbox dead); 503 + Retry-After → tạm, hẹn theo Retry-After; lỗi mạng → tạm", async () => {
    for (const status of [400, 401, 409, 413]) {
      const e = await sendRevalidation(
        CONFIG,
        { id: "e", tags: ["catalog"] },
        { fetch: fakeFetch(() => status).fetch, now: T0 },
      ).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RevalidateHttpError);
      expect(retryInfoOf(e)).toEqual({ permanent: true, retryAfterMs: null });
    }
    const busy = await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["catalog"] },
      { fetch: fakeFetch(() => 503, "30").fetch, now: T0 },
    ).catch((x: unknown) => x);
    expect(retryInfoOf(busy)).toEqual({ permanent: false, retryAfterMs: 30_000 });
    const down = await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["catalog"] },
      { fetch: fakeFetch(() => new TypeError("fetch failed")).fetch, now: T0 },
    ).catch((x: unknown) => x);
    expect(retryInfoOf(down).permanent).toBe(false);
    expect(String(down)).toContain("sf-a.test");
  });

  it("nhiều URL: còn một URL lỗi tạm → ném lỗi tạm (retry cả lô); chỉ lỗi vĩnh viễn → vĩnh viễn", async () => {
    const cfg = { secret: SECRET, urls: ["http://sf-a.test/x", "http://sf-b.test/x"] };
    const mixed = await sendRevalidation(
      cfg,
      { id: "e", tags: ["catalog"] },
      {
        fetch: fakeFetch((u) => (u.includes("sf-a") ? 401 : 502)).fetch,
        now: T0,
      },
    ).catch((x: unknown) => x);
    expect(retryInfoOf(mixed).permanent).toBe(false);
    const perm = await sendRevalidation(
      cfg,
      { id: "e", tags: ["catalog"] },
      {
        fetch: fakeFetch((u) => (u.includes("sf-a") ? 200 : 401)).fetch,
        now: T0,
      },
    ).catch((x: unknown) => x);
    expect(retryInfoOf(perm).permanent).toBe(true);
  });
});

describe("tagsForProducts", () => {
  it("handle hiện tại (kể cả sản phẩm đã xoá) → product:<handle> + catalog:list; không tìm thấy → chỉ catalog:list", async () => {
    const s = setup({ handles: { prod_A: "áo sơ mi" } });
    expect(await tagsForProducts(s.container, ["prod_A", "prod_A"])).toEqual([
      "catalog:list",
      "product:%C3%A1o%20s%C6%A1%20mi",
    ]);
    expect(s.product.listProducts).toHaveBeenCalledWith(
      { id: ["prod_A"] },
      expect.objectContaining({ withDeleted: true }),
    );
    expect(await tagsForProducts(s.container, ["prod_khong_co"])).toEqual(["catalog:list"]);
    expect(await tagsForProducts(s.container, [])).toEqual(["catalog:list"]);
  });

  it("handle quá dài cho tag → làm mới cả catalog (không bỏ sót)", async () => {
    const s = setup({ handles: { prod_A: "a".repeat(300) } });
    expect(await tagsForProducts(s.container, ["prod_A"])).toEqual(["catalog"]);
  });
});

describe("bộ xử lý outbox catalog.revalidate (đường dự phòng)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetRevalidateStateForTests();
  });

  const event = (payload: Record<string, unknown>): OutboxClaim => ({
    id: "obx_1",
    event_key: `${CATALOG_REVALIDATE_EVENT}:p:1:prod_A`,
    aggregate_id: "prod_A",
    type: CATALOG_REVALIDATE_EVENT,
    payload,
    attempts: 0,
  });

  it("đã đăng ký trong DEFAULT_OUTBOX_HANDLERS", () => {
    expect(DEFAULT_OUTBOX_HANDLERS[CATALOG_REVALIDATE_EVENT]).toBe(catalogRevalidateHandler);
  });

  it("gửi tag của dòng tới URL cấu hình; webhook tắt → không làm gì", async () => {
    process.env.DATABASE_URL ??= "postgres://xshop:xshop@localhost:5432/xshop";
    process.env.CATALOG_REVALIDATE_SECRET = SECRET;
    process.env.CATALOG_REVALIDATE_URLS = "http://sf-a.test/api/revalidate";
    const s = setup({ handles: { prod_A: "ao-a" } });
    const f = fakeFetch();
    const realFetch = global.fetch;
    global.fetch = f.fetch;
    try {
      await catalogRevalidateHandler(s.container, event({ scope: "product", product_id: "prod_A" }), {
        now: T0,
      });
      await catalogRevalidateHandler(s.container, event({ scope: "all" }), { now: T0 });
      expect(f.calls.map((c) => JSON.parse(c.body).tags)).toEqual([
        ["catalog:list", "product:ao-a"],
        ["catalog"],
      ]);
      for (const c of f.calls) expect(verify(c)).toMatchObject({ ok: true });

      delete process.env.CATALOG_REVALIDATE_SECRET;
      delete process.env.CATALOG_REVALIDATE_URLS;
      resetRevalidateStateForTests();
      await catalogRevalidateHandler(s.container, event({ scope: "all" }), { now: T0 });
      expect(f.calls).toHaveLength(2);
    } finally {
      global.fetch = realFetch;
    }
  });

  it("payload: chỉ phạm vi + ID sản phẩm", () => {
    expect(validateOutboxPayload(CATALOG_REVALIDATE_EVENT, { scope: "all" })).toEqual({ ok: true });
    expect(
      validateOutboxPayload(CATALOG_REVALIDATE_EVENT, { scope: "product", product_id: "prod_01JABC" }),
    ).toEqual({
      ok: true,
    });
    for (const bad of [
      {},
      { scope: "product" },
      { scope: "product", product_id: "variant_1" },
      { scope: "all", product_id: "prod_1" },
      { scope: "category" },
    ]) {
      expect(validateOutboxPayload(CATALOG_REVALIDATE_EVENT, bad).ok).toBe(false);
    }
  });
});

describe("cấu hình env (backend)", () => {
  const base = { DATABASE_URL: "postgres://xshop:xshop@localhost:5432/xshop" };
  const parsed = (extra: Record<string, string>) => parseEnv({ ...base, ...extra });
  const problemVars = (extra: Record<string, string>) => {
    const r = parsed(extra);
    return r.ok ? [] : r.problems.map((p) => p.variable);
  };

  it("vắng khoá → tắt (null); khoá là bí mật đã đăng ký", () => {
    const r = parsed({});
    expect(r.ok && r.env.catalogRevalidate).toBeNull();
    expect(SECRET_ENV_KEYS).toContain("CATALOG_REVALIDATE_SECRET");
  });

  it("có khoá, vắng URLS → <STOREFRONT_URL>/api/revalidate; URLS → danh sách đã cắt khoảng trắng và / cuối", () => {
    const a = parsed({ CATALOG_REVALIDATE_SECRET: SECRET, STOREFRONT_URL: "https://shop.example.vn/" });
    expect(a.ok && a.env.catalogRevalidate?.urls).toEqual(["https://shop.example.vn/api/revalidate"]);
    const b = parsed({
      CATALOG_REVALIDATE_SECRET: SECRET,
      CATALOG_REVALIDATE_URLS: " http://sf-1:3000/api/revalidate/ , http://sf-2:3000/api/revalidate",
    });
    expect(b.ok && b.env.catalogRevalidate?.urls).toEqual([
      "http://sf-1:3000/api/revalidate",
      "http://sf-2:3000/api/revalidate",
    ]);
  });

  it("khoá ngắn, URLS không khoá, URL có thông tin đăng nhập/query/scheme lạ/quá 8 mục → từ chối", () => {
    expect(problemVars({ CATALOG_REVALIDATE_SECRET: "ngan" })).toContain("CATALOG_REVALIDATE_SECRET");
    expect(problemVars({ CATALOG_REVALIDATE_URLS: "http://sf/api/revalidate" })).toContain(
      "CATALOG_REVALIDATE_URLS",
    );
    for (const urls of [
      "http://u:p@sf/api/revalidate",
      "http://sf/api/revalidate?x=1",
      "ftp://sf/api/revalidate",
      "http://sf/a,,http://sf/b",
      Array.from({ length: 9 }, (_, i) => `http://sf-${i}/api/revalidate`).join(","),
    ]) {
      expect(problemVars({ CATALOG_REVALIDATE_SECRET: SECRET, CATALOG_REVALIDATE_URLS: urls })).toContain(
        "CATALOG_REVALIDATE_URLS",
      );
    }
  });
});
