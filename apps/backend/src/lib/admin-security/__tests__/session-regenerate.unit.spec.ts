import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { POST } from "../../../api/auth/session/route";
import { ADMIN_SESSION_COOKIE_NAME, sessionCookieConfig } from "../session-cookie";
import { establishAdminSession, regenerateSession, type RegenerableSession } from "../session-regenerate";

/**
 * BE-AUTH-004 / D-059 (T-133): session ID đổi sau đăng nhập. Dựng express-session THẬT (bản Medusa 2.22.1 dùng, nạp qua
 * phụ thuộc của @medusajs/framework) với tuỳ chọn ghép như `@medusajs/framework/dist/http/express-loader.js` và gắn ĐÚNG
 * handler `POST` của route ghi đè (`src/api/auth/session/route.ts`).
 */

// express/express-session không là phụ thuộc trực tiếp (không có kiểu) → khai kiểu tối thiểu dùng trong test.
type Res = { status(c: number): Res; json(v: unknown): void };
type Req = {
  session: RegenerableSession;
  auth_context?: unknown;
  headers: Record<string, string | undefined>;
};
type Next = (err?: unknown) => void;
type Handler = (req: Req, res: Res, next: Next) => void;
interface Store {
  get(sid: string, cb: (err: unknown, s?: Record<string, unknown> | null) => void): void;
  destroy(sid: string, cb: (err?: unknown) => void): void;
}
interface App {
  set(k: string, v: unknown): void;
  use(mw: unknown): void;
  get(path: string, h: Handler): void;
  post(path: string, ...h: Handler[]): void;
  listen(port: number): import("node:http").Server;
}
const load = createRequire(require.resolve("@medusajs/framework/http"));
const express = load("express") as () => App;
const session = load("express-session") as ((opts: Record<string, unknown>) => unknown) & {
  MemoryStore: new () => Store;
};

const SECRET = "test-only-cookie-secret-0123456789abcdef";

async function startApp(nodeEnv: "production" | "test", store: Store) {
  const { sessionOptions, cookieOptions } = sessionCookieConfig(nodeEnv);
  const prod = nodeEnv === "production";
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    session({
      name: sessionOptions?.name ?? "connect.sid",
      resave: true,
      rolling: false,
      saveUninitialized: false,
      proxy: true,
      secret: SECRET,
      store,
      cookie: { sameSite: prod ? "lax" : false, secure: prod, maxAge: 10 * 60 * 60 * 1000, ...cookieOptions },
    }),
  );
  // Phiên "cấy" (kẻ tấn công tạo trước, chưa có quyền) — mô phỏng cookie bị fixation.
  app.get("/plant", (r, res) => {
    r.session.planted = true;
    res.json({ id: r.session.id });
  });
  app.get("/whoami", (r, res) => {
    res.json({ id: r.session.id, auth_context: r.session.auth_context ?? null });
  });
  // Middleware giả lập `authenticate("*", "bearer")` native: chỉ Bearer hợp lệ mới tới route; thiếu → 401.
  const bearer: Handler = (r, res, next) => {
    const h = r.headers.authorization ?? "";
    if (!h.startsWith("Bearer ")) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    r.auth_context = { actor_id: h.slice(7), actor_type: "user", auth_identity_id: `authid_${h.slice(7)}` };
    next();
  };
  app.post("/auth/session", bearer, (r, res, next) => {
    POST(r as never, res as never).catch(next);
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const cookiePair = (setCookie: string | null) => (setCookie ?? "").split(";")[0] ?? "";
/** Giá trị ký `s:<id>.<chữ ký>` → id. */
const sidOf = (pair: string) => {
  const value = decodeURIComponent(pair.slice(pair.indexOf("=") + 1));
  return value.slice(2, value.indexOf("."));
};
const storeGet = (store: Store, sid: string) =>
  new Promise<Record<string, unknown> | null>((resolve, reject) =>
    store.get(sid, (err, s) => (err === undefined || err === null ? resolve(s ?? null) : reject(err))),
  );

describe("POST /auth/session ghi đè — express-session thật, cấu hình production (__Host-)", () => {
  const store = new session.MemoryStore();
  let app: Awaited<ReturnType<typeof startApp>>;
  const https = { "x-forwarded-proto": "https" };

  beforeAll(async () => {
    app = await startApp("production", store);
  });
  afterAll(async () => {
    await app.close();
  });

  const plant = async () => {
    const res = await fetch(`${app.base}/plant`, { headers: https });
    const pair = cookiePair(res.headers.get("set-cookie"));
    expect(pair.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`)).toBe(true);
    return pair;
  };
  const login = (cookie: string | undefined, who = "user_1") =>
    fetch(`${app.base}/auth/session`, {
      method: "POST",
      headers: { ...https, authorization: `Bearer ${who}`, ...(cookie === undefined ? {} : { cookie }) },
    });

  it("cookie cấy sẵn → đăng nhập phát ID MỚI (≠ ID cũ), ID cũ bị xoá khỏi store và không mang quyền", async () => {
    const planted = await plant();
    const oldId = sidOf(planted);
    expect(await storeGet(store, oldId)).not.toBeNull();

    const res = await login(planted);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { actor_id: "user_1", actor_type: "user", auth_identity_id: "authid_user_1" },
    });
    const fresh = cookiePair(res.headers.get("set-cookie"));
    const newId = sidOf(fresh);
    expect(newId).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(newId).not.toBe(oldId);
    // Phiên cũ đã huỷ ở server; cookie cũ dùng lại = phiên rỗng (không auth_context).
    expect(await storeGet(store, oldId)).toBeNull();
    const reuse = await fetch(`${app.base}/whoami`, { headers: { ...https, cookie: planted } });
    expect(((await reuse.json()) as { auth_context: unknown }).auth_context).toBeNull();
    // Phiên mới mang quyền và KHÔNG mang dữ liệu của phiên cấy.
    const stored = await storeGet(store, newId);
    expect(stored?.auth_context).toEqual({
      actor_id: "user_1",
      actor_type: "user",
      auth_identity_id: "authid_user_1",
    });
    expect(stored?.planted).toBeUndefined();
  });

  it("Set-Cookie của phiên mới giữ __Host-xshop_sid; Path=/; HttpOnly; Secure; SameSite=Lax; không Domain", async () => {
    const res = await login(await plant());
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`)).toBe(true);
    const attrs = raw
      .split(";")
      .slice(1)
      .map((a) => a.trim().toLowerCase());
    expect(attrs).toEqual(expect.arrayContaining(["path=/", "httponly", "secure", "samesite=lax"]));
    expect(attrs.some((a) => a.startsWith("domain="))).toBe(false);
  });

  it("không có cookie trước → vẫn phát phiên mới có quyền", async () => {
    const res = await login(undefined);
    expect(res.status).toBe(200);
    const id = sidOf(cookiePair(res.headers.get("set-cookie")));
    expect((await storeGet(store, id))?.auth_context).toMatchObject({ actor_id: "user_1" });
  });

  it("đăng nhập lại (đổi đặc quyền, vd sau MFA) trên phiên ĐÃ đăng nhập → ID lại đổi, phiên trước bị huỷ", async () => {
    const first = cookiePair((await login(undefined, "user_2")).headers.get("set-cookie"));
    const second = cookiePair((await login(first, "user_2")).headers.get("set-cookie"));
    expect(sidOf(second)).not.toBe(sidOf(first));
    expect(await storeGet(store, sidOf(first))).toBeNull();
  });

  it("bị từ chối: không Bearer (chỉ cookie cấy) → 401, không phát cookie, phiên cấy không được gắn quyền", async () => {
    const planted = await plant();
    const res = await fetch(`${app.base}/auth/session`, {
      method: "POST",
      headers: { ...https, cookie: planted },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const stored = await storeGet(store, sidOf(planted));
    expect(stored?.auth_context).toBeUndefined();
  });

  it("đồng thời: 5 lần đăng nhập song song cùng cookie cấy → 5 ID mới đôi một khác nhau, không ID nào là ID cũ", async () => {
    const planted = await plant();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => login(planted, `user_c${i}`)));
    const ids = results.map((r) => {
      expect(r.status).toBe(200);
      return sidOf(cookiePair(r.headers.get("set-cookie")));
    });
    expect(new Set(ids).size).toBe(5);
    expect(ids).not.toContain(sidOf(planted));
    // Mỗi phiên mới mang đúng danh tính của request của nó (không lẫn chéo).
    for (const [i, id] of ids.entries())
      expect((await storeGet(store, id))?.auth_context).toMatchObject({ actor_id: `user_c${i}` });
  });
});

describe("dev/test (connect.sid, http) — vẫn đổi ID", () => {
  it("ID trước ≠ sau đăng nhập", async () => {
    const store = new session.MemoryStore();
    const app = await startApp("test", store);
    try {
      const planted = cookiePair((await fetch(`${app.base}/plant`)).headers.get("set-cookie"));
      expect(planted.startsWith("connect.sid=")).toBe(true);
      const res = await fetch(`${app.base}/auth/session`, {
        method: "POST",
        headers: { authorization: "Bearer user_d", cookie: planted },
      });
      const fresh = cookiePair(res.headers.get("set-cookie"));
      expect(fresh.startsWith("connect.sid=")).toBe(true);
      expect(sidOf(fresh)).not.toBe(sidOf(planted));
    } finally {
      await app.close();
    }
  });
});

describe("regenerateSession / establishAdminSession — lỗi (fail-closed)", () => {
  it("store lỗi khi huỷ phiên cũ → reject, KHÔNG gắn auth_context lên phiên cũ", async () => {
    const old: RegenerableSession = {
      id: "old",
      regenerate: (cb) => cb(new Error("redis down")),
    };
    const req = { session: old, auth_context: { actor_id: "user_1" } };
    await expect(establishAdminSession(req)).rejects.toThrow("redis down");
    expect(req.session.auth_context).toBeUndefined();
  });

  it("lỗi không phải Error vẫn thành Error", async () => {
    const req = { session: { regenerate: (cb: (e?: unknown) => void) => cb("boom") } };
    await expect(regenerateSession(req)).rejects.toThrow("boom");
  });

  it("không có express-session (req.session undefined) → reject", async () => {
    await expect(regenerateSession({})).rejects.toThrow(/express-session/);
  });

  it("regenerate không gắn phiên mới → reject", async () => {
    const req: { session?: RegenerableSession } = {
      session: {
        regenerate: (cb) => {
          delete req.session;
          cb();
        },
      },
    };
    await expect(establishAdminSession(req)).rejects.toThrow(/phiên mới/);
  });
});
