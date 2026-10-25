/* global self, caches, fetch, URL */
/* Service worker X-Shop (S-505, S-507, đặc tả §12.2, AT22/AT24).
 *
 * Nguyên tắc: CHỈ cache tài nguyên công khai theo danh sách cho phép (allowlist). Mọi thứ khác — giỏ, thanh toán,
 * đơn hàng, tra cứu, /api, quản trị, phản hồi no-store/private/Set-Cookie, phương thức khác GET — đi thẳng ra mạng.
 * Mất mạng khi điều hướng: trang công khai đã lưu (nếu có) hoặc /offline. Không bao giờ phát lại request ghi.
 *
 * Tệp tĩnh, không qua bước build: logic quyết định nằm trong `self.XSPolicy` (hàm thuần) để test nạp và kiểm trực tiếp
 * (src/lib/pwa/cache-policy.test.ts). Đổi CACHE_VERSION khi đổi chiến lược để dọn cache cũ.
 */
(function (self) {
  "use strict";

  var CACHE_PREFIX = "xshop-public-";
  var CACHE_VERSION = "v1";
  var CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
  var OFFLINE_URL = "/offline";
  var PRECACHE = [OFFLINE_URL, "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

  /** Đường riêng tư/nội bộ — khớp theo đoạn đường dẫn, sau khi chuẩn hoá và bỏ dấu. */
  var PRIVATE_PREFIXES = [
    "/gio-hang",
    "/thanh-toan",
    "/don-hang",
    "/tra-cuu-don",
    "/api",
    "/admin",
    "/app",
    "/sw.js",
  ];
  /** Tiền tố tài nguyên tĩnh công khai. */
  var ASSET_PREFIXES = ["/_next/static/", "/demo/", "/icons/", "/fonts/"];
  var ASSET_EXACT = ["/manifest.webmanifest", "/favicon.ico", "/offline", "/_next/image"];
  /** Trang công khai được lưu để xem lại khi mất mạng (không kèm query string). */
  var PAGE_EXACT = ["/", "/bao-mat", "/giao-hang", "/doi-tra-hoan-tien"];
  var PAGE_PREFIXES = ["/danh-muc/", "/san-pham/"];

  /** Chuẩn hoá đường dẫn để so khớp; trả null nếu không giải mã được (coi là không an toàn → không cache). */
  function normalizePath(pathname) {
    var p = String(pathname == null ? "" : pathname);
    try {
      for (var i = 0; i < 3 && p.indexOf("%") !== -1; i++) p = decodeURIComponent(p);
    } catch {
      return null;
    }
    if (p.indexOf("%") !== -1) return null; // còn mã hoá sau 3 lần giải: đáng ngờ
    p = p.normalize("NFC").replace(/\\/g, "/").toLowerCase();
    var out = [];
    p.split("/").forEach(function (seg) {
      if (seg === "" || seg === ".") return;
      if (seg === "..") out.pop();
      else out.push(seg);
    });
    return "/" + out.join("/");
  }

  /** Bỏ dấu tiếng Việt để bắt cả biến thể như `/tra-cứu-đơn`. */
  function fold(p) {
    return p.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");
  }

  function matchesPrefix(p, prefix) {
    return p === prefix || p.indexOf(prefix + "/") === 0;
  }

  /** Đường dẫn riêng tư? Không chuẩn hoá được → coi là riêng tư (an toàn). */
  function isPrivatePath(pathname) {
    var n = normalizePath(pathname);
    if (n === null) return true;
    var f = fold(n);
    return PRIVATE_PREFIXES.some(function (pre) {
      return matchesPrefix(n, pre) || matchesPrefix(f, pre);
    });
  }

  function isAssetPath(n) {
    return (
      ASSET_EXACT.indexOf(n) !== -1 ||
      ASSET_PREFIXES.some(function (pre) {
        return n.indexOf(pre) === 0;
      })
    );
  }

  function isPublicPagePath(n) {
    return (
      PAGE_EXACT.indexOf(n) !== -1 ||
      PAGE_PREFIXES.some(function (pre) {
        return n.indexOf(pre) === 0 && n.length > pre.length;
      })
    );
  }

  /**
   * Request có được phép vào cache không? `req` = { method, url, origin, hasAuthorization? }.
   * Kiểu trả về: "asset" | "page" | null.
   */
  function classifyRequest(req) {
    if (!req || String(req.method).toUpperCase() !== "GET") return null;
    if (req.hasAuthorization) return null;
    var u;
    try {
      u = new URL(req.url, req.origin);
    } catch {
      return null;
    }
    if (u.origin !== req.origin) return null;
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (isPrivatePath(u.pathname)) return null;
    var n = normalizePath(u.pathname);
    if (n === null) return null;
    if (isAssetPath(n)) {
      // /_next/image cần query (url, w, q); tài nguyên khác cho phép query kiểu ?v=
      return "asset";
    }
    if (isPublicPagePath(n) && u.search === "") return "page";
    return null;
  }

  function hasToken(value, token) {
    return String(value || "")
      .toLowerCase()
      .split(",")
      .some(function (d) {
        return d.trim().split("=")[0] === token;
      });
  }

  /** Response có được lưu không? `res` = { status, type, headers: { get(name) } }. */
  function shouldCacheResponse(res) {
    if (!res || res.status !== 200) return false;
    if (res.type && res.type !== "basic" && res.type !== "default") return false; // opaque/cors/redirect
    if (res.redirected) return false;
    var h = res.headers;
    if (!h || typeof h.get !== "function") return false;
    if (h.get("set-cookie") !== null && h.get("set-cookie") !== undefined) return false;
    var cc = h.get("cache-control");
    if (hasToken(cc, "no-store") || hasToken(cc, "private")) return false;
    var vary = String(h.get("vary") || "").toLowerCase();
    if (vary.indexOf("*") !== -1 || vary.indexOf("cookie") !== -1 || vary.indexOf("authorization") !== -1)
      return false;
    return true;
  }

  /** Gộp hai bước: request được phép VÀ response đạt yêu cầu. */
  function shouldCache(req, res) {
    return classifyRequest(req) !== null && shouldCacheResponse(res);
  }

  self.XSPolicy = {
    CACHE_PREFIX: CACHE_PREFIX,
    CACHE_NAME: CACHE_NAME,
    OFFLINE_URL: OFFLINE_URL,
    normalizePath: normalizePath,
    isPrivatePath: isPrivatePath,
    classifyRequest: classifyRequest,
    shouldCacheResponse: shouldCacheResponse,
    shouldCache: shouldCache,
  };

  if (typeof self.addEventListener !== "function") return;

  function describe(request) {
    return {
      method: request.method,
      url: request.url,
      origin: self.location.origin,
      hasAuthorization: request.headers.has("authorization"),
    };
  }

  self.addEventListener("install", function (event) {
    // Không skipWaiting: bản mới chỉ nhận quản lý khi các tab cũ đóng — không đổi giữa lúc khách đang thanh toán.
    event.waitUntil(
      caches.open(CACHE_NAME).then(function (cache) {
        return Promise.all(
          PRECACHE.map(function (url) {
            return fetch(url, { credentials: "omit", cache: "reload" }).then(function (res) {
              if (res.ok && shouldCacheResponse(res)) return cache.put(url, res);
              if (url === OFFLINE_URL) throw new Error("offline fallback không lưu được");
              return undefined;
            });
          }),
        );
      }),
    );
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches
        .keys()
        .then(function (keys) {
          return Promise.all(
            keys
              .filter(function (k) {
                return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME;
              })
              .map(function (k) {
                return caches.delete(k);
              }),
          );
        })
        .then(function () {
          // Dọn mục không còn hợp lệ theo chính sách hiện hành (phòng bản trước lỡ lưu đường riêng tư).
          return caches.open(CACHE_NAME).then(function (cache) {
            return cache.keys().then(function (reqs) {
              return Promise.all(
                reqs.map(function (r) {
                  var ok =
                    classifyRequest({ method: "GET", url: r.url, origin: self.location.origin }) !== null;
                  return ok ? undefined : cache.delete(r);
                }),
              );
            });
          });
        }),
    );
  });

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (request.method !== "GET") return; // không chen vào request ghi (không phát lại thanh toán)
    var kind = classifyRequest(describe(request));

    if (request.mode === "navigate") {
      event.respondWith(
        fetch(request)
          .then(function (res) {
            if (kind === "page" && shouldCacheResponse(res)) {
              var copy = res.clone();
              caches.open(CACHE_NAME).then(function (c) {
                return c.put(request, copy);
              });
            } else if (kind === "page") {
              caches.open(CACHE_NAME).then(function (c) {
                return c.delete(request);
              });
            }
            return res;
          })
          .catch(function () {
            return (kind === "page" ? caches.match(request) : Promise.resolve(undefined)).then(
              function (hit) {
                return hit || caches.match(OFFLINE_URL);
              },
            );
          }),
      );
      return;
    }

    if (kind !== "asset") return; // mọi thứ khác: trình duyệt tự xử lý, SW không đụng

    event.respondWith(
      caches.match(request).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (res) {
          if (shouldCacheResponse(res)) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (c) {
              return c.put(request, copy);
            });
          }
          return res;
        });
      }),
    );
  });
})(self);
