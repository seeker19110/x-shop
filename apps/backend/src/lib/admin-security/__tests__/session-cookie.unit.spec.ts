import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { ADMIN_SESSION_COOKIE_NAME, sessionCookieConfig } from "../session-cookie";

/**
 * BE-AUTH-004 (T-099): cookie phiên `__Host-` ở production. Phần 2 dựng express-session THẬT (bản Medusa 2.22.1 dùng,
 * nạp qua phụ thuộc của @medusajs/framework) với tuỳ chọn ghép đúng như `@medusajs/framework/dist/http/express-loader.js`
 * (`name: sessionOptions.name ?? "connect.sid"`, `cookie: { sameSite, secure, maxAge, ...cookieOptions }`, `proxy: true`)
 * để kiểm header `Set-Cookie` trình duyệt nhận.
 */
describe("sessionCookieConfig", () => {
  it("production → tên __Host-, Secure, HttpOnly, SameSite=Lax, Path=/, không Domain", () => {
    const c = sessionCookieConfig("production");
    expect(c.sessionOptions?.name).toBe(ADMIN_SESSION_COOKIE_NAME);
    expect(ADMIN_SESSION_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(c.cookieOptions).toEqual({ secure: true, httpOnly: true, sameSite: "lax", path: "/" });
    expect(c.cookieOptions).not.toHaveProperty("domain");
  });

  it.each(["development", "test"] as const)(
    "%s (http://localhost, cookie không Secure) → giữ mặc định Medusa, không dùng __Host-",
    (env) => {
      expect(sessionCookieConfig(env)).toEqual({});
    },
  );
});

describe("Set-Cookie thật từ express-session với cấu hình production", () => {
  // express/express-session không là phụ thuộc trực tiếp (không có kiểu) → khai kiểu tối thiểu dùng trong test.
  type Res = { json(v: unknown): void; clearCookie(name: string, opts?: unknown): void };
  type Req = { session: Record<string, unknown> & { destroy(cb: () => void): void } };
  type Handler = (req: Req, res: Res) => void;
  interface App {
    set(k: string, v: unknown): void;
    use(mw: unknown): void;
    post(path: string, h: Handler): void;
    delete(path: string, h: Handler): void;
    listen(port: number): import("node:http").Server;
  }
  const req = createRequire(require.resolve("@medusajs/framework/http"));
  const express = req("express") as () => App;
  const session = req("express-session") as (opts: Record<string, unknown>) => unknown;

  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const { sessionOptions, cookieOptions } = sessionCookieConfig("production");
    const app = express();
    app.set("trust proxy", 1);
    app.use(
      session({
        name: sessionOptions?.name ?? "connect.sid",
        resave: true,
        rolling: false,
        saveUninitialized: false,
        proxy: true,
        secret: "test-only-cookie-secret-0123456789abcdef",
        cookie: { sameSite: "lax", secure: true, maxAge: 10 * 60 * 60 * 1000, ...cookieOptions },
      }),
    );
    app.post("/auth/session", (r, res) => {
      r.session.auth_context = { actor_id: "user_1" };
      res.json({ ok: true });
    });
    app.delete("/auth/session", (r, res) => {
      r.session.destroy(() => {
        res.clearCookie(sessionOptions?.name ?? "connect.sid", cookieOptions);
        res.json({ success: true });
      });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await close();
  });

  const attrs = (setCookie: string) =>
    setCookie
      .split(";")
      .slice(1)
      .map((a) => a.trim().toLowerCase());

  it("đăng nhập qua HTTPS (proxy) → __Host-xshop_sid; Path=/; HttpOnly; Secure; SameSite=Lax; không Domain; ID ≥ 128 bit", async () => {
    const res = await fetch(`${base}/auth/session`, {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`)).toBe(true);
    const a = attrs(cookie);
    expect(a).toEqual(expect.arrayContaining(["path=/", "httponly", "secure", "samesite=lax"]));
    expect(a.some((x) => x.startsWith("domain="))).toBe(false);
    // Giá trị ký `s:<id>.<chữ ký>`; id base64url của uid-safe 24 byte (192 bit) — tối thiểu 22 ký tự = 128 bit.
    const value = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
    const id = value.slice(2, value.indexOf("."));
    expect(id).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });

  it("HTTP thường (không qua TLS) → KHÔNG phát cookie Secure (express-session từ chối) — không rò phiên qua http", async () => {
    const res = await fetch(`${base}/auth/session`, { method: "POST" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("đăng xuất xoá đúng cookie __Host- với cùng thuộc tính (trình duyệt mới chấp nhận xoá)", async () => {
    const login = await fetch(`${base}/auth/session`, {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    const sid = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const out = await fetch(`${base}/auth/session`, {
      method: "DELETE",
      headers: { "x-forwarded-proto": "https", cookie: sid },
    });
    const cleared = out.headers.get("set-cookie") ?? "";
    expect(cleared.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=;`)).toBe(true);
    expect(attrs(cleared)).toEqual(expect.arrayContaining(["path=/", "httponly", "secure", "samesite=lax"]));
    expect(cleared).toMatch(/expires=thu, 01 jan 1970/i);
  });
});
