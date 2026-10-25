import { randomUUID } from "node:crypto";
import http from "node:http";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import seedXShop from "../../src/scripts/seed";
import { API_CSP } from "../../src/lib/security/headers";
import { resetHttpSecurityConfigForTests } from "../../src/lib/security/config";
import { STORE_RATE_LIMITS } from "../../src/lib/security/rate-limit";
import { UPLOAD_LIMITS } from "../../src/lib/security/upload";
import { ORDER_RATE_LIMITS } from "../../src/lib/orders/rate-limit";
import { createAdmin, storeHeaders, type AdminAccount } from "../helpers/auth";

jest.setTimeout(300 * 1000);

/**
 * T-034 — bảo mật HTTP của backend (SEC01, SEC03, SEC04, SEC05, AT20): header, CORS allowlist, CSRF cho thao tác ghi dùng
 * cookie, rate limit (search, coupon, submit, lookup) theo IP + khoá nghiệp vụ, proxy tin cậy, upload kiểm magic bytes.
 */

interface RawRes {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}

const STORE_ORIGIN = "http://localhost:3000"; // DEV_CORS_DEFAULTS.STORE_CORS
const EVIL = "https://evil.example";

/** PNG 1×1 hợp lệ. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><html><body><script>alert(document.cookie)</script></body></html>");

let ipSeq = 0;
const newIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

/** Bộ đếm cửa sổ cố định theo đồng hồ: còn ít hơn `needMs` tới hết cửa sổ thì chờ sang cửa sổ mới (tránh test chập chờn). */
async function freshWindow(windowMs: number, needMs = 20_000) {
  const left = windowMs - (Date.now() % windowMs);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 50));
}

function setTrustedProxies(value: string) {
  process.env.XS_TRUSTED_PROXIES = value;
  resetHttpSecurityConfigForTests();
}

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    let store: Record<string, string>;
    let base: URL;

    /** Request thô (đặt được Origin/Cookie/Sec-Fetch-Site/Content-Length tuỳ ý). */
    function raw(
      method: string,
      path: string,
      headers: Record<string, string> = {},
      body?: string | Buffer,
      opts: { expectEarlyClose?: boolean } = {},
    ): Promise<RawRes> {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: base.hostname, port: base.port, path, method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: Record<string, unknown> = {};
            try {
              json = JSON.parse(text) as Record<string, unknown>;
            } catch {
              // không phải JSON
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
            if (opts.expectEarlyClose) req.destroy();
          });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        // Máy chủ trả lời sớm khi thân còn chưa gửi (như client đang tải lên): giữ request mở, chỉ gửi header.
        if (opts.expectEarlyClose) req.flushHeaders();
        else req.end();
      });
    }

    const json = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
      const text = JSON.stringify(body);
      return raw(method, path, { ...store, "content-type": "application/json", ...headers }, text);
    };

    const search = (ip?: string) =>
      raw("GET", "/store/x/search?q=ao", { ...store, ...(ip && { "x-forwarded-for": ip }) });

    beforeAll(async () => {
      base = new URL(String((api as unknown as { defaults: { baseURL: string } }).defaults.baseURL));
      await seedXShop({ container: getContainer() });
      store = await storeHeaders(getContainer());
    });
    afterEach(() => setTrustedProxies("loopback"));

    describe("header bảo mật (SEC05)", () => {
      const expectSecure = (res: RawRes) => {
        expect(res.headers["content-security-policy"]).toBe(API_CSP);
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["x-frame-options"]).toBe("DENY");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
        expect(res.headers["permissions-policy"]).toContain("camera=()");
        expect(res.headers["strict-transport-security"]).toBeUndefined();
        expect(res.headers["x-powered-by"]).toBeUndefined();
      };

      it("/store, /x, /admin (đã xác thực), /auth: CSP chặt, nosniff, chống nhúng khung, Referrer-Policy; không HSTS ngoài production", async () => {
        const admin = await createAdmin(api as never, getContainer());
        const store200 = await raw("GET", "/store/x/search?q=ao", store);
        expect(store200.status).toBe(200);
        expectSecure(store200);
        expectSecure(await raw("GET", "/x/health"));
        const audit = await raw("GET", "/admin/x/audit", admin.headers);
        expect(audit.status).toBe(200);
        expectSecure(audit);
        // Phản hồi lỗi do route/middleware của dự án trả cũng mang header (vd. đăng nhập sai → 401).
        const login = await raw(
          "POST",
          "/auth/user/emailpass",
          { "content-type": "application/json" },
          JSON.stringify({ email: admin.email, password: "sai-mat-khau" }),
        );
        expect(login.status).toBe(401);
        expectSecure(login);
      });
    });

    describe("CORS allowlist (SEC01)", () => {
      const preflight = (path: string, origin: string) =>
        raw("OPTIONS", path, {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-publishable-api-key",
        });

      it("origin trong STORE_CORS → được phép, kèm credentials", async () => {
        const res = await preflight("/store/x/checkout/quote", STORE_ORIGIN);
        expect(res.headers["access-control-allow-origin"]).toBe(STORE_ORIGIN);
        expect(res.headers["access-control-allow-credentials"]).toBe("true");
      });

      it.each([EVIL, "null", "http://localhost:3000.evil.example", "http://localhost:3001", ""])(
        "origin %p → không có Access-Control-Allow-Origin",
        async (origin) => {
          const res = await preflight("/store/x/checkout/quote", origin);
          expect(res.headers["access-control-allow-origin"]).toBeUndefined();
          const get = await raw("GET", "/store/x/search?q=ao", { ...store, ...(origin && { origin }) });
          expect(get.headers["access-control-allow-origin"]).toBeUndefined();
        },
      );

      it("origin của storefront không được dùng cho /admin (ADMIN_CORS riêng)", async () => {
        const res = await preflight("/admin/x/size-charts", STORE_ORIGIN);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        const ok = await preflight("/admin/x/size-charts", "http://localhost:9000");
        expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:9000");
      });
    });

    describe("CSRF cho thao tác ghi dùng cookie (SEC01)", () => {
      const cookie = "connect.sid=s%3Afake-session-for-test";
      const quote = (headers: Record<string, string>) =>
        json("POST", "/store/x/checkout/quote", { cart_id: "cart_khong_co" }, headers);

      it.each([
        ["origin lạ", { origin: EVIL }, "origin_not_allowed"],
        ['origin "null"', { origin: "null" }, "origin_null"],
        ['origin "NULL" + same-origin', { origin: "NULL", "sec-fetch-site": "same-origin" }, "origin_null"],
        ["không Origin, Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }, "cross_site"],
        ["không Origin, Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }, "cross_site"],
      ])("có cookie + %s → 403 CSRF_REJECTED", async (_label, headers, reason) => {
        const res = await quote({ cookie, ...headers });
        expect(res.status).toBe(403);
        expect(res.json).toMatchObject({ code: "CSRF_REJECTED", reason });
      });

      it.each([
        ["origin trong allowlist", { cookie, origin: STORE_ORIGIN }],
        [
          "Sec-Fetch-Site same-origin",
          { cookie, origin: "http://localhost:9000", "sec-fetch-site": "same-origin" },
        ],
        ["không Origin, không Sec-Fetch-Site (client không phải trình duyệt)", { cookie }],
        ["header Origin rỗng", { cookie, origin: "" }],
        ["không cookie (không có thẩm quyền ngầm) dù origin lạ", { origin: EVIL }],
        ["cookie rỗng", { cookie: " ", origin: EVIL }],
      ])("%s → không bị CSRF chặn", async (_label, headers) => {
        const res = await quote(headers);
        expect(res.json.code).not.toBe("CSRF_REJECTED");
        expect(res.status).not.toBe(403);
      });

      it("GET có cookie + origin lạ không bị chặn (chỉ thao tác ghi)", async () => {
        const res = await raw("GET", "/store/x/search?q=ao", { ...store, cookie, origin: EVIL });
        expect(res.status).toBe(200);
      });

      it("/admin và /auth với phiên cookie THẬT: origin lạ → 403; origin admin hợp lệ → qua; Bearer không cookie → qua", async () => {
        const admin = await createAdmin(api as never, getContainer());
        // Đổi Bearer lấy phiên cookie native (POST /auth/session) — đúng cách Admin dashboard đăng nhập.
        const created = await raw(
          "POST",
          "/auth/session",
          { ...admin.headers, origin: "http://localhost:9000" },
          "",
        );
        expect(created.status).toBe(200);
        const setCookie = created.headers["set-cookie"] ?? [];
        const session = setCookie.map((c) => c.split(";")[0] ?? "").find((c) => c.startsWith("connect.sid="));
        expect(session).toBeDefined();
        const sessionCookie = session as string;
        expect((await raw("GET", "/admin/users/me", { cookie: sessionCookie })).status).toBe(200);

        const write = (headers: Record<string, string>) =>
          raw("POST", "/admin/x/size-charts", { "content-type": "application/json", ...headers }, "{}");
        const evil = await write({ cookie: sessionCookie, origin: EVIL });
        expect(evil.status).toBe(403);
        expect(evil.json.code).toBe("CSRF_REJECTED");
        // Origin của storefront hợp lệ cho /store nhưng KHÔNG cho /admin.
        expect((await write({ cookie: sessionCookie, origin: STORE_ORIGIN })).json.code).toBe(
          "CSRF_REJECTED",
        );
        const allowed = await write({ cookie: sessionCookie, origin: "http://localhost:9000" });
        expect(allowed.json.code).not.toBe("CSRF_REJECTED");
        expect(allowed.status).not.toBe(401);
        const bearer = await write({ origin: EVIL, ...admin.headers });
        expect(bearer.json.code).not.toBe("CSRF_REJECTED");

        // Đăng xuất bằng CSRF (DELETE /auth/session từ trang lạ) bị chặn; phiên vẫn còn.
        const logout = await raw("DELETE", "/auth/session", { cookie: sessionCookie, origin: EVIL });
        expect(logout.status).toBe(403);
        expect(logout.json.code).toBe("CSRF_REJECTED");
        expect((await raw("GET", "/admin/users/me", { cookie: sessionCookie })).status).toBe(200);
      });
    });

    describe("IP khách và proxy tin cậy (SEC03)", () => {
      it("mặc định (XS_TRUSTED_PROXIES rỗng) không tin X-Forwarded-For: đổi XFF không lách được giới hạn IP", async () => {
        setTrustedProxies("");
        const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;
        await freshWindow(windowMs);
        for (let i = 0; i < limit; i++) expect((await search(newIp())).status).toBe(200);
        const res = await search(newIp());
        expect(res.status).toBe(429);
        // Không XFF cũng cùng bucket (IP socket).
        expect((await search()).status).toBe(429);
      });

      it("loopback tin cậy: IP khách lấy từ XFF; request từ chính proxy (không XFF) không tính giới hạn IP", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;
        await freshWindow(windowMs);
        const a = newIp();
        for (let i = 0; i < limit; i++) expect((await search(a)).status).toBe(200);
        expect((await search(a)).status).toBe(429);
        // XFF nhiều hop: mục phải nhất (proxy liền trước thêm) là khách; mục trái do client tự khai → bỏ qua.
        expect((await search(`${newIp()}, ${a}`)).status).toBe(429);
        expect((await search(`${a}, ${newIp()}`)).status).toBe(200);
        expect((await search()).status).toBe(200);
        // XFF rỗng / rác: không làm lỗi; rác → khách = hop tin cậy cuối, KHÔNG được miễn như nội bộ.
        expect((await search("")).status).toBe(200);
        expect((await search("not-an-ip")).status).toBe(200);
      });

      it("IPv6: gộp theo /64 (đổi địa chỉ trong dải không lách được); IPv4 ánh xạ IPv6 = IPv4", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;
        await freshWindow(windowMs);
        for (let i = 0; i < limit; i++) {
          expect((await search(`2001:db8:${ipSeq + 7}:1::${(i + 1).toString(16)}`)).status).toBe(200);
        }
        expect((await search(`2001:DB8:${ipSeq + 7}:1:ffff:ffff:ffff:fffe`)).status).toBe(429);
        expect((await search(`2001:db8:${ipSeq + 7}:2::1`)).status).toBe(200);

        const v4 = newIp();
        for (let i = 0; i < limit; i++) expect((await search(i % 2 ? v4 : `::ffff:${v4}`)).status).toBe(200);
        expect((await search(`[::ffff:${v4}]:443`)).status).toBe(429);
      });
    });

    describe("rate limit (SEC03, AT20): 429 + Retry-After", () => {
      const expect429 = (res: RawRes, windowMs: number) => {
        expect(res.status).toBe(429);
        expect(res.json).toMatchObject({ code: "RATE_LIMITED", action: "retry_later" });
        const after = Number(res.headers["retry-after"]);
        expect(Number.isInteger(after)).toBe(true);
        expect(after).toBeGreaterThanOrEqual(1);
        expect(after).toBeLessThanOrEqual(Math.ceil(windowMs / 1000));
        expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
      };

      it("search: song song vượt ngưỡng → đúng `limit` request lọt (đếm nguyên tử), IP khác không bị ảnh hưởng", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;
        await freshWindow(windowMs);
        const ip = newIp();
        const results = await Promise.all(Array.from({ length: limit + 10 }, () => search(ip)));
        expect(results.filter((r) => r.status === 200)).toHaveLength(limit);
        const limited = results.filter((r) => r.status === 429);
        expect(limited).toHaveLength(10);
        expect429(limited[0]!, windowMs);
        expect((await search(newIp())).status).toBe(200);
      });

      it("products?q=: q rỗng/chỉ khoảng trắng không đếm; có q vượt ngưỡng → 429 + Retry-After; IP khác không bị chặn", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;
        await freshWindow(windowMs);
        const ip = newIp();
        const list = (qs: string, who = ip) =>
          raw("GET", `/store/x/products${qs}`, { ...store, "x-forwarded-for": who });
        for (const qs of ["", "?q=", "?q=%20%20", "?color=den"]) {
          for (let i = 0; i < limit + 2; i++) expect((await list(qs)).status).toBe(200);
        }
        for (let i = 0; i < limit; i++) expect((await list(`?q=ao${i}`)).status).toBe(200);
        expect429(await list("?q=ao"), windowMs);
        expect((await list("")).status).toBe(200); // không có q vẫn duyệt được
        expect((await list("?q=ao", newIp())).status).toBe(200);
      });

      it("coupon: đếm mã KHÁC NHAU theo giỏ — báo giá lại cùng mã không tốn lượt; vượt → 429 kể cả mã đã thử", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.couponCart;
        await freshWindow(windowMs);
        const cart = `cart_${randomUUID()}`;
        const quote = (code: string, ip = newIp()) =>
          json(
            "POST",
            "/store/x/checkout/quote",
            { cart_id: cart, discount_code: code },
            { "x-forwarded-for": ip },
          );
        for (let i = 0; i < 5; i++) expect((await quote("GIAM10")).status).not.toBe(429);
        // Chuẩn hoá: khoảng trắng/chữ thường là cùng mã.
        expect((await quote("  giam10 ")).status).not.toBe(429);
        for (let i = 1; i < limit; i++) expect((await quote(`DO${i}`)).status).not.toBe(429);
        expect429(await quote("DO-VUOT"), windowMs);
        expect429(await quote("GIAM10"), windowMs);
        // Giỏ khác không bị ảnh hưởng; quote không mã không đụng giới hạn coupon.
        const other = await json(
          "POST",
          "/store/x/checkout/quote",
          { cart_id: `cart_${randomUUID()}`, discount_code: "DO-VUOT" },
          { "x-forwarded-for": newIp() },
        );
        expect(other.status).not.toBe(429);
        const noCode = await json(
          "POST",
          "/store/x/checkout/quote",
          { cart_id: cart, discount_code: "" },
          { "x-forwarded-for": newIp() },
        );
        expect(noCode.status).not.toBe(429);
      });

      it("coupon theo IP: mã khác nhau trên nhiều giỏ từ một IP → 429 ở ngưỡng IP", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.couponIp;
        await freshWindow(windowMs);
        const ip = newIp();
        const quote = (i: number) =>
          json(
            "POST",
            "/store/x/checkout/quote",
            { cart_id: `cart_${randomUUID()}`, discount_code: `MA${i}` },
            { "x-forwarded-for": ip },
          );
        for (let i = 0; i < limit; i++) expect((await quote(i)).status).not.toBe(429);
        expect429(await quote(limit), windowMs);
      });

      it("submit: Idempotency-Key KHÁC NHAU theo giỏ — gửi lại cùng khoá không tốn lượt; song song → đúng ngưỡng", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.submitCart;
        await freshWindow(windowMs);
        const cart = `cart_${randomUUID()}`;
        const submit = (key: string) =>
          json(
            "POST",
            "/store/x/checkout/submit",
            { cart_id: cart },
            { "idempotency-key": key, "x-forwarded-for": newIp() },
          );
        const same = `k-${randomUUID()}`;
        for (let i = 0; i < 4; i++) expect((await submit(same)).status).not.toBe(429);
        const keys = Array.from({ length: limit + 4 }, () => `k-${randomUUID()}`);
        const results = await Promise.all(keys.map((k) => submit(k)));
        expect(results.filter((r) => r.status !== 429)).toHaveLength(limit - 1);
        expect429(
          results.find((r) => r.status === 429)!,
          windowMs,
        );
        // Đã vượt: mọi request của giỏ bị chặn tới hết cửa sổ, kể cả khoá đã thấy.
        expect429(await submit(same), windowMs);
      });

      it("submit theo IP: nhiều giỏ từ một IP → 429 ở ngưỡng IP; thiếu Idempotency-Key vẫn bị tính", async () => {
        const { limit, windowMs } = STORE_RATE_LIMITS.submitIp;
        await freshWindow(windowMs);
        const ip = newIp();
        const submit = (headers: Record<string, string>) =>
          json(
            "POST",
            "/store/x/checkout/submit",
            { cart_id: `cart_${randomUUID()}` },
            { "x-forwarded-for": ip, ...headers },
          );
        expect((await submit({})).status).toBe(422); // thiếu khoá: route trả 422, vẫn tính một lượt
        for (let i = 1; i < limit; i++)
          expect((await submit({ "idempotency-key": `k-${randomUUID()}` })).status).not.toBe(429);
        expect429(await submit({ "idempotency-key": `k-${randomUUID()}` }), windowMs);
        expect(
          (await submit({ "idempotency-key": `k-${randomUUID()}`, "x-forwarded-for": newIp() })).status,
        ).not.toBe(429);
      });

      it("tra cứu đơn: vượt ngưỡng IP → 429 + Retry-After, không lộ đơn có tồn tại (AT20)", async () => {
        const { limit, windowMs } = ORDER_RATE_LIMITS.lookupIp;
        await freshWindow(windowMs);
        const ip = newIp();
        const lookup = (i: number) =>
          json(
            "POST",
            "/store/x/orders/lookup",
            { display_ref: `XS-T${String(i).padStart(4, "0")}`, phone: `0912${String(100000 + i)}` },
            { "x-forwarded-for": ip },
          );
        for (let i = 0; i < limit; i++) {
          const res = await lookup(i);
          expect(res.status).toBe(202);
        }
        const res = await lookup(limit);
        expect(res.status).toBe(429);
        expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(res.body).not.toMatch(/XS-T/);
      });
    });

    describe("upload ảnh admin (SEC04)", () => {
      let owner: AdminAccount;
      beforeEach(async () => {
        owner = await createAdmin(api as never, getContainer());
      });

      async function upload(
        files: Array<{ name: string; type: string; data: Buffer }>,
        headers: Record<string, string> = owner.headers,
      ) {
        const form = new FormData();
        for (const f of files)
          form.append("files", new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
        const res = await fetch(new URL("/admin/uploads", base), { method: "POST", body: form, headers });
        const text = await res.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // không phải JSON
        }
        return { status: res.status, body };
      }

      it("PNG thật, đúng đuôi → 200, mimetype lấy từ magic bytes; xoá được", async () => {
        const res = await upload([{ name: "ao-thun.png", type: "application/octet-stream", data: PNG }]);
        expect(res.status).toBe(200);
        const files = res.body.files as Array<{ id: string; url: string }>;
        expect(files).toHaveLength(1);
        expect(files[0]!.url).toMatch(/\.png$/);
        const del = await fetch(new URL(`/admin/uploads/${encodeURIComponent(files[0]!.id)}`, base), {
          method: "DELETE",
          headers: owner.headers,
        });
        expect(del.status).toBe(200);
      });

      it.each([
        ["SVG có script", "logo.svg", "image/svg+xml", SVG],
        ["SVG giả PNG", "logo.png", "image/png", SVG],
        ["HTML giả JPEG", "anh.jpg", "image/jpeg", HTML],
        ["PNG đặt đuôi .html", "trang.html", "image/png", PNG],
        ["JPEG đặt đuôi .png", "anh.png", "image/png", Buffer.concat([JPEG_HEAD, Buffer.alloc(64)])],
        ["không đuôi", "anh", "image/png", PNG],
        ["file rỗng", "rong.png", "image/png", Buffer.alloc(0)],
      ])("%s → 415", async (_label, name, type, data) => {
        const res = await upload([{ name, type, data }]);
        expect(res.status).toBe(415);
        expect(res.body.code).toBe("UNSUPPORTED_MEDIA_TYPE");
      });

      it("một file xấu trong lô → từ chối cả lô", async () => {
        const res = await upload([
          { name: "a.png", type: "image/png", data: PNG },
          { name: "b.png", type: "image/png", data: HTML },
        ]);
        expect(res.status).toBe(415);
        expect(res.body.errors).toEqual([expect.objectContaining({ param: "files[1]" })]);
      });

      it("file vượt dung lượng → 413; quá số file → 413", async () => {
        const big = Buffer.concat([PNG, Buffer.alloc(UPLOAD_LIMITS.maxFileBytes)]);
        const res = await upload([{ name: "lon.png", type: "image/png", data: big }]);
        expect(res.status).toBe(413);
        expect(res.body.code).toBe("FILE_TOO_LARGE");
        const many = Array.from({ length: UPLOAD_LIMITS.maxFiles + 1 }, (_, i) => ({
          name: `a${i}.png`,
          type: "image/png",
          data: PNG,
        }));
        expect((await upload(many)).status).toBe(413);
      });

      describe("trước multer", () => {
        const boundary = "----xshop";
        const multipart = `multipart/form-data; boundary=${boundary}`;

        it.each(["/admin/uploads", "/ADMIN/Uploads/"])(
          "%s: Content-Length vượt trần → 413 (Express không phân biệt hoa thường → bước kiểm cũng vậy)",
          async (path) => {
            const over = await raw(
              "POST",
              path,
              {
                ...owner.headers,
                "content-type": multipart,
                "content-length": String(UPLOAD_LIMITS.maxRequestBytes + 1),
              },
              undefined,
              { expectEarlyClose: true },
            );
            expect(over.status).toBe(413);
            expect(over.json.code).toBe("PAYLOAD_TOO_LARGE");
          },
        );

        it("thiếu Content-Length (chunked) → 411", async () => {
          const chunked = await raw(
            "POST",
            "/admin/uploads",
            { ...owner.headers, "content-type": multipart, "transfer-encoding": "chunked" },
            `--${boundary}--\r\n`,
          );
          expect(chunked.status).toBe(411);
        });

        it("không phải multipart → 415", async () => {
          const notMultipart = await raw(
            "POST",
            "/admin/uploads",
            { ...owner.headers, "content-type": "application/json" },
            "{}",
          );
          expect(notMultipart.status).toBe(415);
        });
      });

      it("URL ký trước (client tải thẳng, không kiểm được nội dung) bị tắt → 403", async () => {
        const res = await raw(
          "POST",
          "/admin/uploads/presigned-urls",
          { ...owner.headers, "content-type": "application/json" },
          JSON.stringify({ originalname: "a.png", size: 10, mime_type: "image/png", access: "public" }),
        );
        expect(res.status).toBe(403);
        expect(res.json.code).toBe("UPLOAD_METHOD_DISABLED");
      });

      it("phân quyền: chưa đăng nhập → 401; vai trò không có catalog.write → 403; owner → 200", async () => {
        expect((await upload([{ name: "a.png", type: "image/png", data: PNG }], {})).status).toBe(401);
        const warehouse = await createAdmin(api as never, getContainer(), { roles: ["warehouse"] });
        expect(
          (await upload([{ name: "a.png", type: "image/png", data: PNG }], warehouse.headers)).status,
        ).toBe(403);
        const ok = await upload([{ name: "a.png", type: "image/png", data: PNG }]);
        expect(ok.status).toBe(200);
        const id = (ok.body.files as Array<{ id: string }>)[0]!.id;
        await fetch(new URL(`/admin/uploads/${encodeURIComponent(id)}`, base), {
          method: "DELETE",
          headers: owner.headers,
        });
      });
    });
  },
});
