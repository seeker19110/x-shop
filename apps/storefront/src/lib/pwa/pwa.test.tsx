import { act, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import nextConfig, { PRIVATE_SOURCES, SW_SOURCES } from "../../../next.config";
import manifest from "../../app/manifest";
import OfflinePage, { metadata as offlineMetadata } from "../../app/offline/page";
import { OfflineBanner } from "../../components/pwa/OfflineBanner";
import { registerServiceWorker } from "../../components/pwa/ServiceWorkerRegister";
import { loadSw } from "./sw-harness";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PUBLIC = resolve(ROOT, "public");

// S-507 (SPEC-storefront): manifest, icon, trang /offline, nhãn dữ liệu cũ (các describe PWA bên dưới).
describe("web app manifest", () => {
  const m = manifest();

  it("có đủ trường bắt buộc, tiếng Việt, cài được dạng standalone", () => {
    expect(m.name).toMatch(/X-Shop/);
    expect(m.name).toContain("Thời trang");
    expect(m.short_name).toBe("X-Shop");
    expect(m.short_name!.length).toBeLessThanOrEqual(12);
    expect(m.lang).toBe("vi");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.description).toBeTruthy();
  });

  it("màu theme/background lấy từ token --background và khớp viewport themeColor", () => {
    const tokens = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
    const bg = /--background:\s*(#[0-9a-fA-F]{6})/.exec(tokens)![1]!.toLowerCase();
    expect(m.background_color).toBe(bg);
    expect(m.theme_color).toBe(bg);
    const layout = readFileSync(resolve(ROOT, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain(`themeColor: "${bg}"`);
  });

  it("icon: có 192 và 512 (any) + maskable 512, tệp tồn tại là PNG đúng kích thước", () => {
    const icons = m.icons!;
    const find = (sizes: string, purpose: string) =>
      icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    expect(find("192x192", "any")).toBeDefined();
    expect(find("512x512", "any")).toBeDefined();
    expect(find("512x512", "maskable")).toBeDefined();
    for (const icon of icons) {
      expect(icon.src.startsWith("/"), icon.src).toBe(true); // tự host, không URL ngoài
      const file = resolve(PUBLIC, icon.src.slice(1));
      expect(existsSync(file), icon.src).toBe(true);
      const buf = readFileSync(file);
      if (icon.type === "image/png") {
        expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        const [w, h] = icon.sizes!.split("x").map(Number);
        expect(buf.readUInt32BE(16)).toBe(w);
        expect(buf.readUInt32BE(20)).toBe(h);
      } else {
        expect(buf.toString("utf8")).toContain("<svg");
      }
    }
    expect(existsSync(resolve(PUBLIC, "icons/apple-touch-icon.png"))).toBe(true);
  });
});

describe("header Cache-Control", () => {
  it("route riêng tư (giỏ, thanh toán, đơn, tra cứu) có private, no-store", async () => {
    const rules = await nextConfig.headers!();
    for (const source of [
      "/gio-hang",
      "/thanh-toan",
      "/don-hang/:path*",
      "/tra-cuu-don",
      "/tra-cuu-don/:path*",
    ]) {
      expect(PRIVATE_SOURCES).toContain(source);
      const rule = rules.find((r) => r.source === source);
      expect(rule?.headers, source).toContainEqual({ key: "Cache-Control", value: "private, no-store" });
    }
  });

  it("sw.js và manifest luôn revalidate; sw.js được phép scope gốc", async () => {
    const rules = await nextConfig.headers!();
    for (const source of SW_SOURCES) {
      const rule = rules.find((r) => r.source === source);
      expect(rule?.headers, source).toContainEqual({
        key: "Cache-Control",
        value: "public, max-age=0, must-revalidate",
      });
    }
    const sw = rules.find((r) => r.source === "/sw.js")!;
    expect(sw.headers).toContainEqual({ key: "Service-Worker-Allowed", value: "/" });
  });

  it("không có middleware.ts (dành cho task bảo mật)", () => {
    expect(existsSync(resolve(ROOT, "src/middleware.ts"))).toBe(false);
  });
});

describe("service worker (nạp public/sw.js thật)", () => {
  const html = (h: Record<string, string> = {}) =>
    new Response("<html>", { status: 200, headers: { "content-type": "text/html", ...h } });
  const offlineUrl = "https://shop.example/offline";

  it("tài nguyên tĩnh công khai: lấy từ mạng rồi lưu, lần sau phục vụ từ cache", async () => {
    const sw = loadSw({
      network: () => new Response("js", { headers: { "cache-control": "public, immutable" } }),
    });
    const url = "https://shop.example/_next/static/a.js";
    expect(await (await sw.fetch(url))!.text()).toBe("js");
    expect(sw.store.has(url)).toBe(true);
    expect(await (await sw.fetch(url))!.text()).toBe("js");
    expect(sw.fetchCalls).toHaveLength(1);
  });

  it("đường riêng tư/API/POST: SW không respondWith và không lưu gì", async () => {
    const sw = loadSw({ network: () => html() });
    for (const p of [
      "/gio-hang",
      "/thanh-toan/ket-qua",
      "/don-hang/1",
      "/tra-cuu-don",
      "/api/cart/count",
      "/api/x",
    ]) {
      expect(await sw.fetch(p), p).toBeUndefined();
    }
    expect(await sw.fetch("/_next/static/a.js", { method: "POST" })).toBeUndefined();
    expect(await sw.fetch("/danh-muc/ao", { method: "POST", mode: "navigate" })).toBeUndefined();
    expect(sw.store.size).toBe(0);
    expect(sw.fetchCalls).toHaveLength(0);
  });

  it("điều hướng riêng tư: đi mạng, không lưu; mất mạng → /offline (không phát lại, không dùng bản cũ)", async () => {
    let online = true;
    const sw = loadSw({
      network: (u) => {
        if (!online) throw new TypeError("offline");
        return u.endsWith("/offline") ? html() : html({ "cache-control": "public, max-age=60" }); // cố tình thiếu no-store
      },
      preset: { "https://shop.example/gio-hang": html(), [offlineUrl]: new Response("OFFLINE") },
    });
    const ok = await sw.fetch("/gio-hang", { mode: "navigate" });
    expect(ok!.status).toBe(200);
    expect(sw.store.get("https://shop.example/gio-hang")).toBeDefined(); // bản preset cố tình, SW không ghi thêm
    online = false;
    const fallback = await sw.fetch("/gio-hang", { mode: "navigate" });
    expect(await fallback!.text()).toBe("OFFLINE");
  });

  it("điều hướng riêng tư không bao giờ được ghi vào cache dù response trông công khai", async () => {
    const sw = loadSw({ network: () => html({ "cache-control": "public, max-age=60" }) });
    for (const p of ["/gio-hang", "/thanh-toan", "/don-hang/XS1", "/tra-cuu-don"]) {
      await sw.fetch(p, { mode: "navigate" });
    }
    expect(sw.store.size).toBe(0);
  });

  it("trang công khai: lưu khi hợp lệ, mất mạng dùng bản đã lưu, không có bản → /offline", async () => {
    let online = true;
    const sw = loadSw({
      network: () => {
        if (!online) throw new TypeError("offline");
        return html({ "cache-control": "public, max-age=60" });
      },
      preset: { [offlineUrl]: new Response("OFFLINE") },
    });
    await sw.fetch("/danh-muc/ao", { mode: "navigate" });
    expect(sw.store.has("https://shop.example/danh-muc/ao")).toBe(true);
    online = false;
    expect(await (await sw.fetch("/danh-muc/ao", { mode: "navigate" }))!.text()).toBe("<html>");
    expect(await (await sw.fetch("/san-pham/chua-xem", { mode: "navigate" }))!.text()).toBe("OFFLINE");
  });

  it("trang công khai trả no-store/private/Set-Cookie: không lưu và xoá bản cũ", async () => {
    for (const h of [
      { "cache-control": "private, no-store" },
      { "set-cookie": "sid=1" },
      { vary: "Cookie" },
    ] as Record<string, string>[]) {
      const url = "https://shop.example/san-pham/ao";
      const sw = loadSw({ network: () => html(h), preset: { [url]: html() } });
      await sw.fetch("/san-pham/ao", { mode: "navigate" });
      expect(sw.store.has(url), JSON.stringify(h)).toBe(false);
    }
  });

  it("asset trả Set-Cookie hoặc 404 không được lưu", async () => {
    const sw = loadSw({
      network: (u) =>
        u.includes("bad") ? new Response("x", { status: 404 }) : html({ "set-cookie": "a=1" }),
    });
    await sw.fetch("/_next/static/cookie.js");
    await sw.fetch("/_next/static/bad.js");
    expect(sw.store.size).toBe(0);
  });

  it("install precache /offline; activate dọn cache cũ và mục không còn hợp lệ", async () => {
    const sw = loadSw({
      network: (u) =>
        u.endsWith("/offline") ? html() : new Response("a", { headers: { "cache-control": "public" } }),
      preset: {
        "https://shop.example/gio-hang": html(), // lỡ có từ bản cũ
        "https://shop.example/api/cart/count": html(),
        "https://shop.example/_next/static/ok.js": html(),
      },
    });
    await sw.runLifecycle("install");
    expect(sw.store.has(offlineUrl)).toBe(true);
    expect(sw.store.has("https://shop.example/icons/icon-192.png")).toBe(true);
    await sw.runLifecycle("activate");
    expect(sw.store.has("https://shop.example/gio-hang")).toBe(false);
    expect(sw.store.has("https://shop.example/api/cart/count")).toBe(false);
    expect(sw.store.has("https://shop.example/_next/static/ok.js")).toBe(true);
  });

  it("install thất bại nếu /offline không lấy được (không cài SW thiếu fallback)", async () => {
    const sw = loadSw({ network: () => new Response("x", { status: 500 }) });
    await expect(sw.runLifecycle("install")).rejects.toThrow();
  });

  it("không skipWaiting/clients.claim: không ép đổi bản giữa lúc thanh toán", () => {
    const src = readFileSync(resolve(PUBLIC, "sw.js"), "utf8");
    expect(src).not.toMatch(/skipWaiting\(|clients\.claim\(/);
  });
});

describe("đăng ký service worker", () => {
  it("gọi register('/sw.js') với scope gốc, nuốt lỗi", async () => {
    const register = vi.fn().mockResolvedValue({ scope: "/" });
    await registerServiceWorker({ serviceWorker: { register } } as unknown as Navigator);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    const failing = vi.fn().mockRejectedValue(new Error("blocked"));
    await expect(
      registerServiceWorker({ serviceWorker: { register: failing } } as unknown as Navigator),
    ).resolves.toBeNull();
  });

  it("trình duyệt không hỗ trợ → không làm gì", async () => {
    await expect(registerServiceWorker({} as Navigator)).resolves.toBeNull();
    await expect(registerServiceWorker(undefined)).resolves.toBeNull();
  });
});

describe("trang /offline", () => {
  it("render tiếng Việt, nêu rõ không đặt hàng/thanh toán được, có đường thử lại, noindex", () => {
    render(<OfflinePage />);
    expect(screen.getByRole("heading", { level: 1, name: "Bạn đang ngoại tuyến" })).toBeInTheDocument();
    expect(screen.getByText("Không có kết nối mạng")).toBeInTheDocument();
    expect(screen.getByText(/đặt hàng hoặc thanh toán/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Thử lại" })).toHaveAttribute("href", "/");
    expect(offlineMetadata.robots).toEqual({ index: false, follow: false });
  });

  it("render server không lỗi và không chứa dữ liệu riêng tư", () => {
    const out = renderToStaticMarkup(<OfflinePage />);
    expect(out).toContain("Không có kết nối mạng");
    expect(out).not.toMatch(/gio-hang|don-hang/);
  });
});

describe("OfflineBanner", () => {
  const setOnline = (v: boolean) =>
    Object.defineProperty(window.navigator, "onLine", { value: v, configurable: true });
  afterEach(() => setOnline(true));

  it("ẩn khi có mạng, hiện nhãn dữ liệu cũ khi mất mạng và ẩn lại khi có mạng", () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("dữ liệu có thể đã cũ");
    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
