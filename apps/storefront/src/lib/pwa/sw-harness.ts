import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

/** Dùng cho test: nạp NGUYÊN public/sw.js (không bản sao) vào một "self" giả để kiểm logic quyết định và sự kiện. */
export const SW_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../public/sw.js");
const ORIGIN = "https://shop.example";

export interface Policy {
  CACHE_NAME: string;
  OFFLINE_URL: string;
  normalizePath(p: string): string | null;
  isPrivatePath(p: string): boolean;
  classifyRequest(r: {
    method: string;
    url: string;
    origin: string;
    hasAuthorization?: boolean;
  }): "asset" | "page" | null;
  shouldCacheResponse(r: {
    status: number;
    type?: string;
    redirected?: boolean;
    headers: { get(n: string): string | null };
  }): boolean;
  shouldCache(
    req: { method: string; url: string; origin: string },
    res: { status: number; type?: string; headers: { get(n: string): string | null } },
  ): boolean;
}

type Handler = (event: unknown) => void;

export interface Harness {
  policy: Policy;
  handlers: Record<string, Handler>;
  store: Map<string, Response>;
  fetchCalls: string[];
  /** Phát sự kiện fetch; trả `undefined` nếu SW không respondWith (để trình duyệt xử lý). */
  fetch(
    url: string,
    init?: { method?: string; mode?: string; headers?: Record<string, string> },
  ): Promise<Response | undefined>;
  runLifecycle(name: "install" | "activate"): Promise<void>;
}

export function loadSw(opts: {
  network: (url: string) => Response | Promise<Response>;
  preset?: Record<string, Response>;
}): Harness {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, Response>(Object.entries(opts.preset ?? {}));
  const fetchCalls: string[] = [];
  const key = (r: string | { url: string }) => {
    const u = typeof r === "string" ? r : r.url;
    return new URL(u, ORIGIN).toString();
  };
  const cache = {
    put: async (r: string | { url: string }, res: Response) => void store.set(key(r), res),
    delete: async (r: string | { url: string }) => store.delete(key(r)),
    keys: async () => [...store.keys()].map((url) => ({ url })),
    match: async (r: string | { url: string }) => store.get(key(r))?.clone(),
  };
  const sandbox: Record<string, unknown> = {
    URL,
    Promise,
    Error,
    caches: {
      open: async () => cache,
      match: (r: string | { url: string }) => cache.match(r),
      keys: async () => ["xshop-public-v0", "xshop-public-v1", "khac-ben-thu-ba"],
      delete: async () => true,
    },
    fetch: async (r: string | { url: string }) => {
      const url = key(r);
      fetchCalls.push(url);
      return opts.network(url);
    },
  };
  const self: Record<string, unknown> = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, fn: Handler) => void (handlers[name] = fn),
  };
  sandbox.self = self;
  runInNewContext(readFileSync(SW_PATH, "utf8"), sandbox, { filename: "sw.js" });

  const waitFor = async (name: string) => {
    let p: Promise<unknown> = Promise.resolve();
    handlers[name]!({ waitUntil: (x: Promise<unknown>) => void (p = x) });
    await p;
  };

  return {
    policy: self.XSPolicy as Policy,
    handlers,
    store,
    fetchCalls,
    runLifecycle: (name) => waitFor(name),
    async fetch(url, init = {}) {
      let responded: Promise<Response> | undefined;
      const hdrs = new Headers(init.headers);
      handlers.fetch!({
        request: {
          method: init.method ?? "GET",
          url: new URL(url, ORIGIN).toString(),
          mode: init.mode ?? "no-cors",
          headers: hdrs,
        },
        respondWith: (p: Promise<Response>) => void (responded = p),
      });
      if (!responded) return undefined;
      // Ghi cache chạy nền trong SW: đợi một nhịp để mô phỏng đã xong.
      const res = await responded;
      await new Promise((r) => setTimeout(r, 0));
      return res;
    },
  };
}

export const ORIGIN_FOR_TEST = ORIGIN;
