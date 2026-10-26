// @vitest-environment node
import { loadSw, ORIGIN_FOR_TEST as ORIGIN } from "./sw-harness";

/** Chính sách cache của service worker (S-505, AT22): nạp thẳng public/sw.js. */
const { policy } = loadSw({ network: () => new Response("x") });

const req = (path: string, extra: Partial<{ method: string; hasAuthorization: boolean }> = {}) => ({
  method: "GET",
  url: ORIGIN + path,
  origin: ORIGIN,
  ...extra,
});
const res = (headers: Record<string, string> = {}, init: { status?: number; type?: string } = {}) => ({
  status: init.status ?? 200,
  type: init.type ?? "basic",
  headers: new Headers(headers),
});

describe("classifyRequest: đường riêng tư không bao giờ vào cache", () => {
  const PRIVATE = [
    "/gio-hang",
    "/gio-hang/",
    "/thanh-toan",
    "/thanh-toan/ket-qua",
    "/don-hang/XS-123",
    "/don-hang",
    "/tra-cuu-don",
    "/tra-cuu-don/xac-thuc",
    "/api/cart/count",
    "/api/checkout/submit",
    "/api/catalog/suggest",
    "/api",
    "/admin",
    "/sw.js",
  ];
  it.each(PRIVATE)("từ chối %s", (p) => {
    expect(policy.classifyRequest(req(p))).toBeNull();
    expect(policy.isPrivatePath(p)).toBe(true);
  });

  it("từ chối cả khi có query string, trailing slash, hoa/thường", () => {
    for (const p of [
      "/gio-hang?x=1",
      "/GIO-HANG",
      "/Thanh-Toan/",
      "/don-hang/abc/?token=1#f",
      "/api/cart/count?_=1",
    ]) {
      expect(policy.classifyRequest(req(p)), p).toBeNull();
    }
  });

  it("từ chối biến thể mã hoá / dấu / đường vòng", () => {
    for (const p of [
      "/gio%2Dhang", // %2D = '-'
      "/%67io-hang", // %67 = 'g'
      "/gio-hang%2F",
      "/%2567io-hang", // mã hoá hai lần
      "/danh-muc/../gio-hang",
      "/danh-muc/%2e%2e/thanh-toan",
      "//gio-hang",
      "/./don-hang/1",
      "/\\gio-hang",
      "/api//cart/count",
      "/tra-cứu-đơn",
      "/tra-c%E1%BB%A9u-%C4%91%C6%A1n", // tra-cứu-đơn mã hoá UTF-8
      "/TRA-CỨU-ĐƠN/xac-thuc",
    ]) {
      expect(policy.classifyRequest(req(p)), p).toBeNull();
    }
  });

  it("đường không giải mã được → coi là riêng tư", () => {
    expect(policy.normalizePath("/%E0%A4%A")).toBeNull();
    expect(policy.isPrivatePath("/%E0%A4%A")).toBe(true);
    expect(policy.classifyRequest(req("/san-pham/%E0%A4%A"))).toBeNull();
    expect(policy.classifyRequest(req("/%25252567io-hang"))).toBeNull(); // mã hoá nhiều tầng
  });

  it("không nhầm tiền tố: /gio-hang-mau không phải /gio-hang, nhưng cũng không nằm allowlist", () => {
    expect(policy.isPrivatePath("/gio-hang-mau")).toBe(false);
    expect(policy.classifyRequest(req("/gio-hang-mau"))).toBeNull();
  });
});

describe("classifyRequest: ngoài allowlist hoặc không phải GET", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "từ chối %s kể cả tài nguyên công khai",
    (method) => {
      expect(policy.classifyRequest(req("/_next/static/a.js", { method }))).toBeNull();
      expect(policy.classifyRequest(req("/", { method }))).toBeNull();
    },
  );

  it("chấp nhận get chữ thường (chuẩn hoá phương thức)", () => {
    expect(policy.classifyRequest(req("/", { method: "get" }))).toBe("page");
  });

  it("từ chối request có Authorization và khác origin", () => {
    expect(policy.classifyRequest(req("/_next/static/a.js", { hasAuthorization: true }))).toBeNull();
    expect(
      policy.classifyRequest({
        method: "GET",
        url: "https://evil.example/_next/static/a.js",
        origin: ORIGIN,
      }),
    ).toBeNull();
    expect(
      policy.classifyRequest({ method: "GET", url: "https://u:p@shop.example/", origin: ORIGIN }),
    ).toBeNull();
  });

  it("từ chối đường lạ, trang tìm kiếm, URL hỏng", () => {
    for (const p of ["/tim-kiem", "/tim-kiem?q=ao", "/khong-co", "/san-pham", "/san-pham/", "/danh-muc"]) {
      expect(policy.classifyRequest(req(p)), p).toBeNull();
    }
    expect(policy.classifyRequest({ method: "GET", url: "http://[::bad", origin: ORIGIN })).toBeNull();
    expect(policy.classifyRequest(null as never)).toBeNull();
  });

  it("trang công khai kèm query string không được cache (khoá cache theo URL có thể rò tham số)", () => {
    expect(policy.classifyRequest(req("/danh-muc/ao?mau=do"))).toBeNull();
    expect(policy.classifyRequest(req("/?utm=1"))).toBeNull();
  });
});

describe("classifyRequest: chấp nhận tài nguyên công khai", () => {
  it.each([
    ["/_next/static/chunks/app-1a2b.js", "asset"],
    ["/_next/static/media/font.woff2", "asset"],
    ["/demo/top-den-front.svg", "asset"],
    ["/icons/icon-192.png", "asset"],
    ["/icons/icon-192.png?v=2", "asset"],
    ["/manifest.webmanifest", "asset"],
    ["/offline", "asset"],
    ["/_next/image?url=%2Fdemo%2Fcat-ao.svg&w=640&q=75", "asset"],
    ["/", "page"],
    ["/danh-muc/ao", "page"],
    ["/danh-muc/ao/", "page"],
    ["/san-pham/ao-so-mi-lanh", "page"],
    ["/san-pham/%C3%A1o-d%C3%A0i", "page"], // slug có dấu (đã mã hoá)
    ["/bao-mat", "page"],
    ["/giao-hang", "page"],
    ["/doi-tra-hoan-tien/", "page"],
  ] as const)("%s → %s", (p, kind) => {
    expect(policy.classifyRequest(req(p))).toBe(kind);
  });

  it("dấu chấm trong slug và đường dẫn rỗng không làm lệch phân loại", () => {
    expect(policy.classifyRequest(req("/san-pham/ao.v2"))).toBe("page");
    expect(policy.classifyRequest({ method: "GET", url: "", origin: ORIGIN })).toBe("page"); // rỗng = gốc site
    expect(policy.classifyRequest({ method: "GET", url: "/", origin: "không-phải-url" })).toBeNull();
  });
});

describe("shouldCacheResponse: phản hồi không được lưu", () => {
  it("chấp nhận 200 công khai", () => {
    expect(policy.shouldCacheResponse(res())).toBe(true);
    expect(policy.shouldCacheResponse(res({ "cache-control": "public, max-age=31536000, immutable" }))).toBe(
      true,
    );
    expect(policy.shouldCacheResponse(res({ "cache-control": "s-maxage=60, stale-while-revalidate" }))).toBe(
      true,
    );
  });

  it.each([
    "no-store",
    "private, no-store",
    "NO-STORE",
    "public, no-store",
    "private",
    "Private, max-age=0",
    "private, no-cache, no-store, max-age=0, must-revalidate",
    "max-age=60, no-store",
  ])("từ chối Cache-Control: %s", (cc) => {
    expect(policy.shouldCacheResponse(res({ "cache-control": cc }))).toBe(false);
  });

  it("từ chối có Set-Cookie (kể cả rỗng)", () => {
    expect(policy.shouldCacheResponse(res({ "set-cookie": "sid=1; HttpOnly" }))).toBe(false);
    expect(policy.shouldCacheResponse(res({ "set-cookie": "" }))).toBe(false);
  });

  it("từ chối Vary theo Cookie/Authorization/*", () => {
    for (const v of ["Cookie", "Accept-Encoding, Cookie", "authorization", "*"]) {
      expect(policy.shouldCacheResponse(res({ vary: v })), v).toBe(false);
    }
    expect(policy.shouldCacheResponse(res({ vary: "Accept-Encoding" }))).toBe(true);
  });

  it("từ chối trạng thái khác 200, opaque/cors, redirect, null", () => {
    for (const status of [0, 201, 204, 206, 301, 304, 401, 403, 404, 500]) {
      expect(policy.shouldCacheResponse(res({}, { status })), String(status)).toBe(false);
    }
    expect(policy.shouldCacheResponse(res({}, { type: "opaque" }))).toBe(false);
    expect(policy.shouldCacheResponse(res({}, { type: "cors" }))).toBe(false);
    expect(policy.shouldCacheResponse({ ...res(), redirected: true })).toBe(false);
    expect(policy.shouldCacheResponse(null as never)).toBe(false);
    expect(policy.shouldCacheResponse({ status: 200, headers: null as never })).toBe(false);
  });

  it("shouldCache cần cả request lẫn response đạt", () => {
    expect(policy.shouldCache(req("/_next/static/a.js"), res())).toBe(true);
    expect(policy.shouldCache(req("/gio-hang"), res())).toBe(false);
    expect(policy.shouldCache(req("/_next/static/a.js"), res({ "cache-control": "private" }))).toBe(false);
    expect(policy.shouldCache(req("/_next/static/a.js", { method: "POST" }), res())).toBe(false);
  });
});
