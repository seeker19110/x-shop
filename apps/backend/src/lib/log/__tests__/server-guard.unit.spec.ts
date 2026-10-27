import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { installAccessLogServerHook, isAcceptedRequestTarget, type HttpModuleLike } from "../http";
import { createLogger } from "../logger";

/**
 * T-145 — hook server HTTP chặn request-target không phải origin-form (URL tuyệt đối…) bằng 400 TRƯỚC listener ứng dụng
 * (Express), vẫn ghi log truy cập; không vỡ pipelining/upgrade; không bao giờ ném.
 */

function capture() {
  const raw: string[] = [];
  const logger = createLogger({ service: "svc", version: "1", env: "test", write: (l) => raw.push(l) });
  return { logger, records: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** Server thật qua `createServer` đã bọc (module giả trỏ về `http.createServer` thật — không vá module dùng chung). */
async function startServer(listener: http.RequestListener, setup?: (s: http.Server) => void) {
  const { logger, records } = capture();
  const mod: HttpModuleLike = {
    createServer: http.createServer as unknown as HttpModuleLike["createServer"],
  };
  expect(installAccessLogServerHook(logger, mod)).toBe(true);
  const server = (mod.createServer as unknown as typeof http.createServer)(listener);
  setup?.(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, records, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Gửi byte thô, đọc tới khi socket đóng (hoặc hết `waitMs`). */
function rawExchange(port: number, payload: string, waitMs = 1500): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(data);
    }, waitMs);
    socket.on("data", (c: Buffer) => (data += c.toString("utf8")));
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on("error", reject);
  });
}

const statusLines = (data: string) => data.match(/HTTP\/1\.1 \d{3}/g) ?? [];

describe("hook server: request-target (T-145)", () => {
  it("isAcceptedRequestTarget: chỉ origin-form và `OPTIONS *`", () => {
    expect(isAcceptedRequestTarget("GET", "/admin/customers/1")).toBe(true);
    expect(isAcceptedRequestTarget("GET", "//x/admin")).toBe(true);
    expect(isAcceptedRequestTarget("OPTIONS", "*")).toBe(true);
    expect(isAcceptedRequestTarget("options", "*")).toBe(true);
    expect(isAcceptedRequestTarget("GET", "*")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "http://localhost:9000/admin/customers/1")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "HTTP://X/admin")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "admin/customers")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "")).toBe(false);
    // D-079: `#` và `\` không hợp lệ trong request-target.
    expect(isAcceptedRequestTarget("GET", "/admin\\customers/x#y")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "/admin\\customers/x")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "/admin/customers/x#y")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "/admin/customers/x?q=#")).toBe(false);
    expect(isAcceptedRequestTarget("GET", "/admin/customers/x?q=%23")).toBe(true);
    expect(isAcceptedRequestTarget("GET", undefined)).toBe(false);
  });

  it("URL tuyệt đối → 400 problem+json, listener gốc KHÔNG chạy, vẫn có log truy cập; origin-form và `OPTIONS *` tới listener", async () => {
    const seen: string[] = [];
    const s = await startServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.end("ok");
    });
    try {
      const bad = await rawExchange(
        s.port,
        `GET http://localhost:${s.port}/admin/customers/cus_1 HTTP/1.1\r\nHost: x\r\nX-Request-Id: rid-145\r\nConnection: close\r\n\r\n`,
      );
      expect(bad.startsWith("HTTP/1.1 400")).toBe(true);
      expect(bad).toContain("application/problem+json");
      const body = JSON.parse(bad.split("\r\n\r\n")[1] ?? "{}") as Record<string, unknown>;
      expect(body).toMatchObject({ status: 400, code: "INVALID_REQUEST_TARGET", trace_id: "rid-145" });

      const ok = await rawExchange(
        s.port,
        "GET /admin/customers/cus_1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      );
      expect(ok.startsWith("HTTP/1.1 200")).toBe(true);
      for (const target of [
        "/admin\\customers/cus_1#y",
        "/admin\\customers/cus_1",
        "/admin/customers/cus_1#y",
      ]) {
        const res = await rawExchange(
          s.port,
          `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
        );
        expect({ target, line: res.split("\r\n")[0], code: res.includes("INVALID_REQUEST_TARGET") }).toEqual({
          target,
          line: "HTTP/1.1 400 Bad Request",
          code: true,
        });
      }
      const star = await rawExchange(s.port, "OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      expect(star.startsWith("HTTP/1.1 200")).toBe(true);
      expect(seen).toEqual(["GET /admin/customers/cus_1", "OPTIONS *"]);

      const access = s.records().filter((r) => r.message === "http.server.request");
      expect(access).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            "url.path": `http://localhost:${s.port}/admin/customers/cus_1`,
            "http.response.status_code": 400,
            trace_id: "rid-145",
          }),
          expect.objectContaining({ "url.path": "/admin/customers/cus_1", "http.response.status_code": 200 }),
        ]),
      );
    } finally {
      await s.close();
    }
  });

  it("pipelining: hợp lệ → tuyệt đối → hợp lệ trên một kết nối → 200, 400, 200 đúng thứ tự; HEAD/POST tuyệt đối cũng 400", async () => {
    const seen: string[] = [];
    const s = await startServer((req, res) => {
      seen.push(String(req.url));
      req.resume();
      req.on("end", () => res.end(`ok ${req.url}`));
    });
    try {
      const out = await rawExchange(
        s.port,
        "GET /a HTTP/1.1\r\nHost: x\r\n\r\n" +
          `POST http://localhost:${s.port}/admin/x/refunds HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello` +
          "GET /b HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
      );
      expect(statusLines(out)).toEqual(["HTTP/1.1 200", "HTTP/1.1 400", "HTTP/1.1 200"]);
      expect(out.indexOf("ok /a")).toBeLessThan(out.indexOf("ok /b"));
      expect(seen).toEqual(["/a", "/b"]);
      const head = await rawExchange(
        s.port,
        `HEAD http://h/admin HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
      expect(statusLines(head)).toEqual(["HTTP/1.1 400"]);
      expect(seen).toEqual(["/a", "/b"]);
    } finally {
      await s.close();
    }
  });

  it("upgrade: có listener `upgrade` → tới listener như cũ; không có listener → đi đường request (tuyệt đối → 400)", async () => {
    const upgrades: string[] = [];
    const s = await startServer(
      (_req, res) => res.end("plain"),
      (server) =>
        server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
          upgrades.push(String(req.url));
          socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x-test\r\nConnection: Upgrade\r\n\r\n");
        }),
    );
    try {
      const up = await rawExchange(
        s.port,
        "GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: x-test\r\nConnection: Upgrade\r\n\r\n",
      );
      expect(up.startsWith("HTTP/1.1 101")).toBe(true);
      expect(upgrades).toEqual(["/ws"]);
    } finally {
      await s.close();
    }

    const plain = await startServer((_req, res) => res.end("plain"));
    try {
      const out = await rawExchange(
        plain.port,
        "GET http://h/ws HTTP/1.1\r\nHost: x\r\nUpgrade: x-test\r\nConnection: Upgrade\r\n\r\n",
      );
      expect(out.startsWith("HTTP/1.1 400")).toBe(true);
    } finally {
      await plain.close();
    }
  });

  it("Expect: 100-continue + URL tuyệt đối → 400, listener không chạy", async () => {
    const seen: string[] = [];
    const s = await startServer((req, res) => {
      seen.push(String(req.url));
      res.end("ok");
    });
    try {
      const out = await rawExchange(
        s.port,
        `POST http://h/admin/x/refunds HTTP/1.1\r\nHost: x\r\nExpect: 100-continue\r\nContent-Length: 2\r\nConnection: close\r\n\r\n`,
      );
      expect(statusLines(out)).toContain("HTTP/1.1 400");
      expect(seen).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it("không bao giờ ném: req có getter ném → không gọi listener; res không ghi được → không ném", () => {
    const { logger } = capture();
    const mod = { createServer: (() => new EventEmitter()) as (...a: never[]) => unknown };
    installAccessLogServerHook(logger, mod);
    const server = mod.createServer() as EventEmitter;
    const listener = jest.fn();
    server.on("request", listener);
    const evil = Object.defineProperty({}, "url", {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => server.emit("request", evil, {})).not.toThrow();
    expect(() => server.emit("request", { url: "http://h/admin", method: "GET" }, null)).not.toThrow();
    expect(() =>
      server.emit(
        "request",
        { url: "http://h/admin", method: "GET" },
        {
          destroy: () => {
            throw new Error("x");
          },
        },
      ),
    ).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
    server.emit(
      "request",
      { url: "/ok", method: "GET" },
      Object.assign(new EventEmitter(), { statusCode: 200 }),
    );
    expect(listener).toHaveBeenCalledTimes(1);
    // Sự kiện khác `request` đi thẳng.
    const other = jest.fn();
    server.on("connection", other);
    server.emit("connection", 1);
    expect(other).toHaveBeenCalledWith(1);
  });
});
