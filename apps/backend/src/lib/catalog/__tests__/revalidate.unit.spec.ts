import { createServer, type Server, type Socket } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { catalogRevalidate as protocol } from "@x-shop/domain";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { OutboxClaim } from "../../../modules/checkout/service";
import { DEFAULT_OUTBOX_HANDLERS, dispatchOutbox } from "../../checkout/jobs";
import { envWarnings, loadEnvOrExit, parseEnv, SECRET_ENV_KEYS, type ExitHooks } from "../../env";
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
  RevalidateUnavailableError,
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
    resetRevalidateStateForTests(); // 502 vừa mở ngắt sf-b — ca dưới xét phân loại, không xét ngắt
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

/* ------------------------------------------------------------------ review T-142 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Container giả với INSERT/POST có độ trễ thật (ms) — để lượt xả và lượt gửi gộp xen kẽ nhau. */
function racySetup(handles: Record<string, string>, insertMs: number) {
  const sent: string[] = [];
  const outbox = {
    insertOutbox: jest.fn(async () => {
      await sleep(insertMs);
    }),
    markOutboxSentByKey: jest.fn(async (key: string) => {
      sent.push(key);
    }),
  };
  const product = {
    listProducts: jest.fn(async (f: { id: string[] }) =>
      f.id.flatMap((id) => (handles[id] === undefined ? [] : [{ id, handle: handles[id] }])),
    ),
  };
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
  const container = {
    resolve: (k: string) =>
      k === CHECKOUT_MODULE
        ? outbox
        : k === Modules.PRODUCT
          ? product
          : k === ContainerRegistrationKeys.LOGGER
            ? logger
            : null,
  } as unknown as MedusaContainer;
  return { container, sent };
}

function slowFetch(ms: number) {
  const tags: string[][] = [];
  const fn = (async (_u: string, init: RequestInit) => {
    await sleep(ms);
    tags.push((JSON.parse(String(init.body)) as { tags: string[] }).tags);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { tags, fn };
}

describe("race lượt gửi gộp ↔ lượt xả đang ghi outbox (review T-142 🔴1)", () => {
  const T = new Date("2026-10-27T03:00:01.990Z");
  const S = windowStartMs(T.getTime());

  it("dòng ghi xong GIỮA lượt gửi gộp không bị đánh dấu sent bởi webhook thiếu tag của nó; lượt gửi riêng mang tag", async () => {
    const s = racySetup({ prod_A: "ao-a", prod_B: "ao-b" }, 1);
    const f = slowFetch(10);
    await enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_A"] },
      { config: CONFIG, now: T, schedule: false },
    );
    const late = enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_B"] },
      { config: CONFIG, now: new Date(T.getTime() + 5), schedule: false },
    );
    expect(await flushRevalidationWindow(s.container, S, { config: CONFIG, fetch: f.fn })).toBe(true);
    await late;
    expect(f.tags).toEqual([["catalog:list", "product:ao-a"]]);
    expect(s.sent).toEqual([revalidateEventKey(S, "prod_A")]); // prod_B chưa được gửi → chưa sent
    // Dòng đến muộn nằm ở cửa sổ mới cùng mốc → lượt gửi riêng mang đúng tag rồi mới sent.
    expect(await flushRevalidationWindow(s.container, S, { config: CONFIG, fetch: f.fn })).toBe(true);
    expect(f.tags[1]).toEqual(["catalog:list", "product:ao-b"]);
    expect(s.sent).toEqual([revalidateEventKey(S, "prod_A"), revalidateEventKey(S, "prod_B")]);
  });

  it("lô > trần ghi xong giữa lượt gửi: dòng `cả catalog` chỉ sent sau webhook mang tag `catalog`", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `prod_M${i}`);
    const s = racySetup({ prod_A: "ao-a" }, 1);
    const f = slowFetch(10);
    await enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_A"] },
      { config: CONFIG, now: T, schedule: false },
    );
    const late = enqueueCatalogRevalidation(
      s.container,
      { productIds: many },
      { config: CONFIG, now: new Date(T.getTime() + 5), schedule: false },
    );
    await flushRevalidationWindow(s.container, S, { config: CONFIG, fetch: f.fn });
    await late;
    expect(s.sent).not.toContain(revalidateEventKey(S, null));
    await flushRevalidationWindow(s.container, S, { config: CONFIG, fetch: f.fn });
    expect(f.tags[1]).toEqual(["catalog"]);
    expect(s.sent).toContain(revalidateEventKey(S, null));
  });

  it("có hẹn giờ: dòng đến muộn tự được gửi bằng lượt riêng ngay sau đó (không đợi dispatcher)", async () => {
    const s = racySetup({ prod_A: "ao-a", prod_B: "ao-b" }, 1);
    const f = slowFetch(10);
    await enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_A"] },
      { config: CONFIG, now: T, schedule: false },
    );
    const late = enqueueCatalogRevalidation(
      s.container,
      { productIds: ["prod_B"] },
      { config: CONFIG, now: new Date(T.getTime() + 5), fetch: f.fn },
    );
    await flushRevalidationWindow(s.container, S, { config: CONFIG, fetch: f.fn });
    await late;
    await sleep(60); // mốc cửa sổ đã qua → hẹn 0 ms
    expect(f.tags).toEqual([
      ["catalog:list", "product:ao-a"],
      ["catalog:list", "product:ao-b"],
    ]);
    expect(s.sent).toEqual([revalidateEventKey(S, "prod_A"), revalidateEventKey(S, "prod_B")]);
  });
});

describe("storefront treo không chặn khe outbox-dispatch dùng chung (review T-142 🔴2, D-081)", () => {
  const saved = { ...process.env };
  let server: Server;
  const sockets: Socket[] = [];
  let port = 0;
  beforeAll(async () => {
    server = createServer((sock) => sockets.push(sock)); // nhận kết nối rồi im lặng
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const sock of sockets) sock.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  afterEach(() => {
    process.env = { ...saved };
    resetRevalidateStateForTests();
  });

  const claim = (i: number): OutboxClaim => ({
    id: `obx_${i}`,
    event_key: `${CATALOG_REVALIDATE_EVENT}:p:1:prod_${i}`,
    aggregate_id: `prod_${i}`,
    type: CATALOG_REVALIDATE_EVENT,
    payload: { scope: "product", product_id: `prod_${i}` },
    attempts: 0,
  });

  it("3 dòng catalog trước 1 sự kiện khác: sự kiện khác chạy sau ≤ một timeout, không phải 3 × timeout", async () => {
    process.env.DATABASE_URL ??= "postgres://xshop:xshop@localhost:5432/xshop";
    process.env.CATALOG_REVALIDATE_SECRET = SECRET;
    process.env.CATALOG_REVALIDATE_URLS = `http://127.0.0.1:${port}/api/revalidate`;
    resetRevalidateStateForTests();
    const queue: OutboxClaim[] = [
      claim(1),
      claim(2),
      claim(3),
      {
        id: "obx_9",
        event_key: "other:1",
        aggregate_id: "x_1",
        type: "review.other",
        payload: {},
        attempts: 0,
      },
    ];
    const svc = {
      claimDueOutbox: jest.fn(async () => queue.shift() ?? null),
      markOutboxSent: jest.fn(async () => undefined),
      markOutboxFailed: jest.fn(async () => undefined),
      openOpsException: jest.fn(async () => true),
      openOpsExceptionIfNoneActive: jest.fn(async () => true),
    };
    const s = setup({ handles: { prod_1: "a", prod_2: "b", prod_3: "c" } });
    const container = {
      resolve: (k: string) => (k === CHECKOUT_MODULE ? svc : s.container.resolve(k)),
    } as unknown as MedusaContainer;
    const t0 = Date.now();
    let otherAt = -1;
    const summary = await dispatchOutbox(container, {
      handlers: {
        "review.other": async () => {
          otherAt = Date.now() - t0;
        },
      },
    });
    expect(otherAt).toBeGreaterThanOrEqual(0);
    expect(otherAt).toBeLessThan(CATALOG_REVALIDATE_POLICY.requestTimeoutMs + 1_000);
    expect(summary.retried).toHaveLength(3); // tạm thời → hẹn lại, không dead
    expect(summary.sent).toEqual(["other:1"]);
    expect(sockets).toHaveLength(1); // chỉ dòng đầu chạm mạng; hai dòng sau bị ngắt ngay
    // Dòng bị ngắt hẹn lại ít nhất phần ngắt còn lại (không thử lại dồn dập).
    const delays = (svc.markOutboxFailed.mock.calls as unknown as [string, string, Date][])
      .slice(1)
      .map(([, , at]) => at.getTime() - Date.now());
    expect(delays).toHaveLength(2);
    for (const d of delays) expect(d).toBeGreaterThan(CATALOG_REVALIDATE_POLICY.unavailableCooldownMs / 2);
  }, 30_000);
});

describe("ngắt theo URL khi storefront lỗi tạm/chậm (review T-142 vòng 2)", () => {
  const body = (c: { body: string }) => JSON.parse(c.body) as { tags: string[] };
  const at = (ms: number) => new Date(T0.getTime() + ms);
  const COOL = CATALOG_REVALIDATE_POLICY.unavailableCooldownMs;

  it("lỗi mạng, 5xx, 408, 429 mở ngắt (lần sau lỗi tạm ngay, không gọi mạng); 4xx khác không mở", async () => {
    for (const failure of [() => new TypeError("fetch failed"), () => 503, () => 502, () => 408, () => 429]) {
      resetRevalidateStateForTests();
      await sendRevalidation(
        CONFIG,
        { id: "e", tags: ["catalog"] },
        { fetch: fakeFetch(failure).fetch, now: T0 },
      ).catch(() => undefined);
      const next = fakeFetch();
      const e = await sendRevalidation(
        CONFIG,
        { id: "e", tags: ["catalog"] },
        { fetch: next.fetch, now: at(1000) },
      ).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RevalidateUnavailableError);
      expect(String(e)).toContain("sf-a.test");
      expect(retryInfoOf(e)).toEqual({ permanent: false, retryAfterMs: COOL - 1000 });
      expect(next.calls).toHaveLength(0);
    }
    for (const status of [400, 401, 409, 413]) {
      resetRevalidateStateForTests();
      await sendRevalidation(
        CONFIG,
        { id: "e", tags: ["catalog"] },
        { fetch: fakeFetch(() => status).fetch, now: T0 },
      ).catch(() => undefined);
      const ok = fakeFetch();
      await sendRevalidation(CONFIG, { id: "e", tags: ["catalog:list"] }, { fetch: ok.fetch, now: at(1000) });
      expect(ok.calls.map(body)).toEqual([{ id: "e", tags: ["catalog:list"] }]);
    }
  });

  it("Retry-After dài hơn thời gian ngắt → ngắt theo Retry-After", async () => {
    await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["catalog"] },
      { fetch: fakeFetch(() => 503, "120").fetch, now: T0 },
    ).catch(() => undefined);
    const e = await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["catalog"] },
      { fetch: fakeFetch().fetch, now: at(COOL + 1) },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RevalidateUnavailableError);
  });

  it("hết ngắt, gửi thành công đầu tiên mang tag `catalog` (gửi bù dòng đã dead lúc sập); lần sau về tag thường", async () => {
    await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["catalog:list"] },
      { fetch: fakeFetch(() => 503).fetch, now: T0 },
    ).catch(() => undefined);
    const probe = fakeFetch();
    await sendRevalidation(
      CONFIG,
      { id: "e1", tags: ["catalog:list", "product:a"] },
      { fetch: probe.fetch, now: at(COOL + 1) },
    );
    expect(probe.calls.map(body)).toEqual([{ id: "e1", tags: ["catalog"] }]);
    for (const c of probe.calls) expect(verify(c, at(COOL + 1).getTime())).toMatchObject({ ok: true });
    const after = fakeFetch();
    await sendRevalidation(
      CONFIG,
      { id: "e2", tags: ["product:a"] },
      { fetch: after.fetch, now: at(COOL + 2) },
    );
    expect(after.calls.map(body)).toEqual([{ id: "e2", tags: ["product:a"] }]);
  });

  it("lần thăm dò hỏng lại → vẫn giữ cờ gửi bù cho lần thành công sau", async () => {
    await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["x"] },
      { fetch: fakeFetch(() => 503).fetch, now: T0 },
    ).catch(() => undefined);
    await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["x"] },
      { fetch: fakeFetch(() => 500).fetch, now: at(COOL + 1) },
    ).catch(() => undefined);
    const ok = fakeFetch();
    await sendRevalidation(
      CONFIG,
      { id: "e3", tags: ["product:a"] },
      { fetch: ok.fetch, now: at(2 * COOL + 2) },
    );
    expect(ok.calls.map(body)).toEqual([{ id: "e3", tags: ["catalog"] }]);
  });

  it("phản hồi chậm hơn ngưỡng (kể cả 2xx) mở ngắt; 2xx chậm không cần gửi bù", async () => {
    const slow = (async () => {
      await new Promise((r) => setTimeout(r, CATALOG_REVALIDATE_POLICY.slowResponseMs + 100));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await sendRevalidation(CONFIG, { id: "e", tags: ["x"] }, { fetch: slow, now: T0 });
    const next = fakeFetch();
    const e = await sendRevalidation(
      CONFIG,
      { id: "e", tags: ["x"] },
      { fetch: next.fetch, now: at(10) },
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RevalidateUnavailableError);
    expect(next.calls).toHaveLength(0);
    // Dòng bị từ chối trong lúc ngắt → lần thành công sau gửi bù `catalog`.
    const ok = fakeFetch();
    await sendRevalidation(
      CONFIG,
      { id: "e4", tags: ["product:a"] },
      { fetch: ok.fetch, now: at(COOL + 20) },
    );
    expect(ok.calls.map(body)).toEqual([{ id: "e4", tags: ["catalog"] }]);
  });

  it("theo từng URL: một bản chết không chặn bản khoẻ (bản khoẻ vẫn nhận mỗi lần, lỗi chung vẫn là tạm)", async () => {
    const cfg = { secret: SECRET, urls: ["http://sf-a.test/x", "http://sf-b.test/x"] };
    await sendRevalidation(
      cfg,
      { id: "e", tags: ["x"] },
      {
        fetch: fakeFetch((u) => (u.includes("sf-a") ? new TypeError("down") : 200)).fetch,
        now: T0,
      },
    ).catch(() => undefined);
    for (let i = 1; i <= 3; i++) {
      const f = fakeFetch();
      const e = await sendRevalidation(
        cfg,
        { id: `e${i}`, tags: ["product:a"] },
        { fetch: f.fetch, now: at(i * 1000) },
      ).catch((x: unknown) => x);
      expect(f.calls.map((c) => c.url)).toEqual(["http://sf-b.test/x"]);
      expect(f.calls.map(body)).toEqual([{ id: `e${i}`, tags: ["product:a"] }]);
      expect(e).toBeInstanceOf(RevalidateUnavailableError);
      expect(retryInfoOf(e).permanent).toBe(false);
    }
  });
});

describe("trần gọi mạng mỗi lượt dispatch (review T-142 vòng 2 🟠)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetRevalidateStateForTests();
  });
  const rows = (n: number): OutboxClaim[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `obx_${i}`,
      event_key: `${CATALOG_REVALIDATE_EVENT}:p:1:prod_${i}`,
      aggregate_id: `prod_${i}`,
      type: CATALOG_REVALIDATE_EVENT,
      payload: { scope: "product", product_id: `prod_${i}` },
      attempts: 0,
    }));

  async function run(queue: OutboxClaim[], fetchImpl: typeof fetch, handles: Record<string, string>) {
    process.env.DATABASE_URL ??= "postgres://xshop:xshop@localhost:5432/xshop";
    process.env.CATALOG_REVALIDATE_SECRET = SECRET;
    process.env.CATALOG_REVALIDATE_URLS = "http://sf-a.test/api/revalidate";
    resetRevalidateStateForTests();
    const svc = {
      claimDueOutbox: jest.fn(async () => queue.shift() ?? null),
      markOutboxSent: jest.fn(async () => undefined),
      markOutboxFailed: jest.fn(async () => undefined),
      openOpsException: jest.fn(async () => true),
      openOpsExceptionIfNoneActive: jest.fn(async () => true),
    };
    const s = setup({ handles });
    const container = {
      resolve: (k: string) => (k === CHECKOUT_MODULE ? svc : s.container.resolve(k)),
    } as unknown as MedusaContainer;
    const realFetch = global.fetch;
    global.fetch = fetchImpl;
    try {
      return await dispatchOutbox(container, {});
    } finally {
      global.fetch = realFetch;
    }
  }

  it("8 dòng, storefront khoẻ: 3 dòng gửi tag riêng, dòng 4 gửi MỘT `catalog` phủ phần còn lại; 4 lần gọi mạng, cả 8 sent", async () => {
    const f = fakeFetch();
    const handles = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`prod_${i}`, `h${i}`]));
    const summary = await run(rows(8), f.fetch, handles);
    expect(summary.sent).toHaveLength(8);
    expect(f.calls.map((c) => JSON.parse(c.body).tags)).toEqual([
      ["catalog:list", "product:h0"],
      ["catalog:list", "product:h1"],
      ["catalog:list", "product:h2"],
      ["catalog"],
    ]);
  });

  it("webhook `catalog` của lượt hỏng (4xx) → phần còn lại của lượt lỗi tạm ngay, không gọi mạng thêm", async () => {
    let n = 0;
    const f = fakeFetch(() => (++n <= 3 ? 200 : 401));
    const summary = await run(rows(7), f.fetch, {});
    expect(f.calls).toHaveLength(4);
    expect(summary.sent).toHaveLength(3);
    expect(summary.dead).toHaveLength(1); // dòng gửi `catalog` nhận 401
    expect(summary.retried).toHaveLength(3); // phần dư: tạm, hẹn lại
  });
});

describe("S2: storefront trả 5xx CHẬM không chặn khe dispatcher (review T-142 vòng 2)", () => {
  const saved = { ...process.env };
  let server: HttpServer;
  let port = 0;
  beforeAll(async () => {
    server = createHttpServer((_q, res) => {
      setTimeout(() => {
        res.writeHead(503);
        res.end();
      }, 1_900);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  afterEach(() => {
    process.env = { ...saved };
    resetRevalidateStateForTests();
  });

  it("5 dòng catalog (503 sau 1,9 s) trước 1 sự kiện khác: sự kiện khác chạy sau ≤ một lần chờ, không phải 5 lần", async () => {
    process.env.DATABASE_URL ??= "postgres://xshop:xshop@localhost:5432/xshop";
    process.env.CATALOG_REVALIDATE_SECRET = SECRET;
    process.env.CATALOG_REVALIDATE_URLS = `http://127.0.0.1:${port}/api/revalidate`;
    resetRevalidateStateForTests();
    const queue: OutboxClaim[] = [
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `obx_${i}`,
        event_key: `${CATALOG_REVALIDATE_EVENT}:p:1:prod_${i}`,
        aggregate_id: `prod_${i}`,
        type: CATALOG_REVALIDATE_EVENT,
        payload: { scope: "product", product_id: `prod_${i}` },
        attempts: 0,
      })),
      {
        id: "obx_9",
        event_key: "other:1",
        aggregate_id: "x_1",
        type: "review.other",
        payload: {},
        attempts: 0,
      },
    ];
    const svc = {
      claimDueOutbox: jest.fn(async () => queue.shift() ?? null),
      markOutboxSent: jest.fn(async () => undefined),
      markOutboxFailed: jest.fn(async () => undefined),
      openOpsException: jest.fn(async () => true),
      openOpsExceptionIfNoneActive: jest.fn(async () => true),
    };
    const s = setup({ handles: {} });
    const container = {
      resolve: (k: string) => (k === CHECKOUT_MODULE ? svc : s.container.resolve(k)),
    } as unknown as MedusaContainer;
    const t0 = Date.now();
    let otherAt = -1;
    const summary = await dispatchOutbox(container, {
      handlers: {
        "review.other": async () => {
          otherAt = Date.now() - t0;
        },
      },
    });
    expect(otherAt).toBeGreaterThanOrEqual(1_900);
    expect(otherAt).toBeLessThan(CATALOG_REVALIDATE_POLICY.requestTimeoutMs + 1_000);
    expect(summary.retried).toHaveLength(5);
    expect(summary.sent).toEqual(["other:1"]);
  }, 30_000);
});

describe("dòng catalog.revalidate chết → MỘT ngoại lệ đang mở, ưu tiên thường (review T-142 🟠2)", () => {
  it("catalog: openOpsExceptionIfNoneActive(scope type, normal); loại khác giữ openOpsException mỗi sự kiện, high", async () => {
    const queue: OutboxClaim[] = [
      {
        id: "obx_1",
        event_key: `${CATALOG_REVALIDATE_EVENT}:p:1:prod_1`,
        aggregate_id: "prod_1",
        type: CATALOG_REVALIDATE_EVENT,
        payload: { scope: "product", product_id: "prod_1" },
        attempts: 0,
      },
      {
        id: "obx_2",
        event_key: "other:1",
        aggregate_id: "x_1",
        type: "review.other",
        payload: {},
        attempts: 0,
      },
    ];
    const svc = {
      claimDueOutbox: jest.fn(async () => queue.shift() ?? null),
      markOutboxSent: jest.fn(async () => undefined),
      markOutboxFailed: jest.fn(async () => undefined),
      openOpsException: jest.fn(async () => true),
      openOpsExceptionIfNoneActive: jest.fn(async () => true),
    };
    const container = {
      resolve: (k: string) => (k === CHECKOUT_MODULE ? svc : null),
    } as unknown as MedusaContainer;
    const perm = async () => {
      throw new RevalidateHttpError("401", 401, null);
    };
    const summary = await dispatchOutbox(container, {
      handlers: { [CATALOG_REVALIDATE_EVENT]: perm, "review.other": perm },
    });
    expect(summary.dead).toEqual([`${CATALOG_REVALIDATE_EVENT}:p:1:prod_1`, "other:1"]);
    expect(svc.openOpsExceptionIfNoneActive).toHaveBeenCalledTimes(1);
    expect(svc.openOpsExceptionIfNoneActive).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "outbox_dead",
        priority: "normal",
        active_scope: ["type"],
        detail: expect.objectContaining({ type: CATALOG_REVALIDATE_EVENT, dead_reason: "permanent_error" }),
      }),
    );
    expect(svc.openOpsException).toHaveBeenCalledTimes(1);
    expect(svc.openOpsException).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "outbox_dead",
        priority: "high",
        detail: expect.objectContaining({ type: "review.other" }),
      }),
    );
  });
});

describe("cấu hình env production (review T-142 🟠3)", () => {
  const prod: Record<string, string> = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://u:p@db.example.vn:5432/xshop",
    REDIS_URL: "rediss://default:p@cache.example.vn:6380",
    JWT_SECRET: "jwt-0123456789abcdef0123456789abcdef",
    COOKIE_SECRET: "cookie-0123456789abcdef0123456789abcd",
    AUTH_MFA_ENCRYPTION_KEY: "mfa-0123456789abcdef0123456789abcdef0",
    ORDER_LOOKUP_SECRET: "order-0123456789abcdef0123456789abcd",
    XS_TRUSTED_PROXIES: "10.0.0.0/8",
    STOREFRONT_URL: "https://shop.example.vn",
    PRIVATE_UPLOAD_DIR: "/var/lib/xshop/private-uploads",
    STORE_CORS: "https://shop.example.vn",
    ADMIN_CORS: "https://admin.example.vn",
    AUTH_CORS: "https://admin.example.vn",
    VNPAY_ENABLED: "false",
    GHN_MODE: "live",
    GHN_BASE_URL: "https://ghn.example.vn/shiip/public-api",
    GHN_TOKEN: "ghn-token-0123456789abcdef",
    GHN_SHOP_ID: "123456",
  };
  const problemsOf = (extra: Record<string, string>) => {
    const r = parseEnv({ ...prod, ...extra });
    return r.ok ? [] : r.problems;
  };

  it("thiếu khoá → lỗi khởi động nêu tên biến + cách tắt tường minh", () => {
    const p = problemsOf({});
    expect(p.map((x) => x.variable)).toEqual(["CATALOG_REVALIDATE_SECRET"]);
    expect(p[0]!.reason).toContain("CATALOG_REVALIDATE_ENABLED=false");
  });

  it("có khoá → bật, URL mặc định https từ STOREFRONT_URL; không cảnh báo", () => {
    const r = parseEnv({ ...prod, CATALOG_REVALIDATE_SECRET: SECRET });
    expect(r.ok && r.env.catalogRevalidate?.urls).toEqual(["https://shop.example.vn/api/revalidate"]);
    expect(r.ok && envWarnings(r.env)).toEqual([]);
  });

  it("URLS không https ở production → từ chối; toàn https → nhận", () => {
    const bad = problemsOf({
      CATALOG_REVALIDATE_SECRET: SECRET,
      CATALOG_REVALIDATE_URLS: "https://a/x,http://b/x",
    });
    expect(bad.map((x) => x.variable)).toEqual(["CATALOG_REVALIDATE_URLS"]);
    const good = problemsOf({
      CATALOG_REVALIDATE_SECRET: SECRET,
      CATALOG_REVALIDATE_URLS: "https://a/x,https://b/x",
    });
    expect(good).toEqual([]);
  });

  it("tắt tường minh → khởi động được, catalogRevalidate null, cảnh báo lúc khởi động không chứa bí mật", () => {
    const writes: string[] = [];
    const hooks: ExitHooks = {
      writeError: (m) => {
        writes.push(m);
      },
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    };
    const env = loadEnvOrExit(
      { ...prod, CATALOG_REVALIDATE_ENABLED: "false", CATALOG_REVALIDATE_SECRET: SECRET },
      hooks,
    );
    expect(env.catalogRevalidate).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("CATALOG_REVALIDATE_ENABLED=false");
    expect(writes[0]).not.toContain(SECRET);
  });

  it("giá trị ENABLED lạ → lỗi; dev/test vắng khoá vẫn tắt, không cảnh báo", () => {
    expect(problemsOf({ CATALOG_REVALIDATE_ENABLED: "no" }).map((x) => x.variable)).toContain(
      "CATALOG_REVALIDATE_ENABLED",
    );
    const dev = parseEnv({ DATABASE_URL: prod.DATABASE_URL! });
    expect(dev.ok && dev.env.catalogRevalidate).toBeNull();
    expect(dev.ok && envWarnings(dev.env)).toEqual([]);
  });
});
