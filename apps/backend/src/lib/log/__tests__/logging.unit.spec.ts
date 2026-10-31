import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { parseEnv } from "../../env";
import { appLoggerFromEnv, SERVICE_NAME, serviceVersion } from "../app-logger";
import { installAccessLogServerHook, MAX_PATH, pathOf, requestLogContext, trackRawRequest } from "../http";
import {
  AppLogger,
  createLogger,
  currentLogContext,
  escapeLine,
  exceptionFields,
  runWithLogContext,
  SEVERITY_NUMBER,
} from "../logger";
import { REDACTED } from "../redact";

/**
 * T-090 — logger JSON một dòng/stdout (BASE-ERR-005/006), che bí mật + PII (BASE-ERR-007, SEC-SECRET-007, CMP-PRIV-008),
 * chống log injection (BASE-ERR-008), ngoại lệ theo OTel kèm chuỗi cause (BASE-ERR-009), ngữ cảnh trace theo request.
 */

const RFC3339_MS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function capture(opts: Partial<ConstructorParameters<typeof AppLogger>[0]> = {}) {
  const raw: string[] = [];
  const exits: number[] = [];
  const logger = createLogger({
    service: "svc",
    version: "1.2.3",
    env: "test",
    write: (l) => raw.push(l),
    exit: (c) => {
      exits.push(c);
    },
    ...opts,
  });
  const records = () => raw.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, raw, records, exits };
}

describe("bản ghi JSON một dòng (BASE-ERR-005/006)", () => {
  it("trường tối thiểu: timestamp RFC 3339 UTC ms, level + severity_number OTel, message, service, version, env", () => {
    const { logger, raw, records } = capture({ now: () => new Date("2026-10-26T10:00:00.123+07:00") });
    logger.info("khởi động");
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toContain("\n");
    const r = records()[0]!;
    expect(r).toEqual({
      timestamp: "2026-10-26T03:00:00.123Z",
      level: "info",
      severity_number: 9,
      message: "khởi động",
      service: "svc",
      version: "1.2.3",
      env: "test",
    });
    expect(String(r.timestamp)).toMatch(RFC3339_MS_UTC);
  });

  it("mức Medusa → mức/số OTel", () => {
    const { logger, records } = capture({ level: "silly" });
    logger.silly("a");
    logger.debug("b");
    logger.verbose("c");
    logger.http("d");
    logger.info("e");
    logger.warn("f");
    logger.error("g");
    expect(records().map((r) => [r.level, r.severity_number])).toEqual([
      ["trace", 1],
      ["debug", 5],
      ["debug", 5],
      ["debug", 5],
      ["info", 9],
      ["warn", 13],
      ["error", 17],
    ]);
    expect(SEVERITY_NUMBER.fatal).toBe(21);
  });

  it("ngưỡng: mặc định info bỏ debug; setLogLevel/unsetLogLevel; shouldLog('http') luôn false (tắt morgan của Medusa)", () => {
    const { logger, records } = capture();
    logger.debug("ẩn");
    expect(records()).toHaveLength(0);
    expect(logger.shouldLog("info")).toBe(true);
    expect(logger.shouldLog("debug")).toBe(false);
    expect(logger.shouldLog("http")).toBe(false);
    expect(logger.shouldLog("khong-co")).toBe(false);
    logger.setLogLevel("debug");
    logger.debug("hiện");
    logger.setLogLevel("khong-hop-le");
    expect(logger.shouldLog("debug")).toBe(true);
    logger.unsetLogLevel();
    logger.debug("ẩn lại");
    expect(records().map((r) => r.message)).toEqual(["hiện"]);
    expect(logger.shouldLog("http")).toBe(false);
  });

  it("trường bổ sung không đè được trường lõi (timestamp/service/level…)", () => {
    const { logger, records } = capture();
    logger.emit("info", "x", { service: "giả", timestamp: "giả", level: "fatal", order_id: "XS-1" });
    expect(records()[0]).toMatchObject({ service: "svc", level: "info", order_id: "XS-1" });
    expect(records()[0]!.timestamp).not.toBe("giả");
  });

  it("writer ném lỗi → logger không ném (không làm hỏng nghiệp vụ)", () => {
    const logger = createLogger({
      service: "s",
      version: "v",
      env: "e",
      write: () => {
        throw new Error("EPIPE");
      },
    });
    expect(() => logger.info("x")).not.toThrow();
  });

  it("phương thức tách rời vẫn chạy (`const { info } = logger`)", () => {
    const { logger, records } = capture();
    const { info, warn } = logger;
    info("a");
    warn("b");
    expect(records().map((r) => r.level)).toEqual(["info", "warn"]);
  });
});

describe("che bí mật + PII trong log (BASE-ERR-007, SEC-SECRET-007, CMP-PRIV-008)", () => {
  it("object chứa password/token/cookie/email/SĐT → [REDACTED]; thông điệp có SĐT/email/CCCD bị che", () => {
    const { logger, raw, records } = capture();
    logger.emit("info", "Khách 0912345678 / a@example.test / CCCD 099099012345", {
      password: "hunter2",
      nested: { token: "tok", authorization: "Bearer abc", cookie: "sid=1" },
      customer: { email: "a@example.test", phone: "0912345678" },
      order_id: "XS-ABC123",
    });
    const r = records()[0]!;
    expect(r.message).toBe("Khách [PHONE] / [EMAIL] / CCCD [CCCD]");
    expect(r).toMatchObject({
      password: REDACTED,
      nested: { token: REDACTED, authorization: REDACTED, cookie: REDACTED },
      customer: { email: REDACTED, phone: REDACTED },
      order_id: "XS-ABC123",
    });
    expect(raw[0]).not.toMatch(/hunter2|tok"|0912345678|a@b\.vn|099099012345/);
  });
});

describe("chống log injection (BASE-ERR-008)", () => {
  it.each([
    ["CR/LF", "user\n[ERROR] fake\r\nmore"],
    ["NEL U+0085", "a\u0085[ERROR] fake"],
    ["U+2028/U+2029", "a\u2028b\u2029c"],
    ["bidi U+202E/U+2066", "x\u202egnp.exe\u2066"],
    ["C0 + DEL", "a\u0000b\u001bc\u007f"],
  ])("%s → đúng một dòng, ký tự nằm trong trường (thoát), không render được", (_label, input) => {
    const { logger, raw, records } = capture();
    logger.emit("warn", input, { field: input });
    expect(raw).toHaveLength(1);
    const forbidden = [0x0d, 0x0a, 0x85, 0x2028, 0x2029, 0x202e, 0x2066, 0x00, 0x1b, 0x7f];
    expect([...raw[0]!].filter((c) => forbidden.includes(c.charCodeAt(0)))).toEqual([]);
    const r = records()[0]!;
    expect(r.message).toBe(input);
    expect(r.field).toBe(input);
  });

  it("escapeLine giữ JSON hợp lệ", () => {
    const line = escapeLine(JSON.stringify({ m: "a\u2028\u0085b" }));
    expect(JSON.parse(line)).toEqual({ m: "a\u2028\u0085b" });
  });
});

describe("ngoại lệ theo OTel kèm chuỗi nguyên nhân (BASE-ERR-009)", () => {
  it("Error bọc Error bọc giá trị thô → exception.type/message/stacktrace đủ chuỗi Caused by", () => {
    const root = new TypeError("ECONNREFUSED 10.0.0.5:5432");
    const mid = new Error("truy vấn thất bại", { cause: root });
    const top = new Error("đặt hàng thất bại", { cause: mid });
    (root as Error & { cause?: unknown }).cause = { code: "57P01" };
    const { logger, records } = capture();
    logger.error("[checkout] POST /store/x/checkout/submit", top);
    const r = records()[0]!;
    expect(r["exception.type"]).toBe("Error");
    expect(r["exception.message"]).toBe("đặt hàng thất bại");
    const st = String(r["exception.stacktrace"]);
    expect(st).toContain("Error: đặt hàng thất bại");
    expect(st).toContain("Caused by: Error: truy vấn thất bại");
    expect(st).toContain("Caused by: TypeError: ECONNREFUSED 10.0.0.5:5432");
    expect(st).toContain('Caused by: {"code":"57P01"}');
    expect(st.indexOf("đặt hàng")).toBeLessThan(st.indexOf("truy vấn"));
  });

  it("AggregateError liệt kê từng lỗi con; vòng cause → [Circular]", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as Error & { cause?: unknown }).cause = b;
    const agg = new AggregateError([new RangeError("r1"), b], "nhiều lỗi");
    const f = exceptionFields(agg);
    expect(f["exception.type"]).toBe("AggregateError");
    expect(f["exception.stacktrace"]).toContain("[errors 0] RangeError: r1");
    expect(f["exception.stacktrace"]).toContain("[errors 1] Error: b");
    expect(f["exception.stacktrace"]).toContain("[Circular]");
  });

  it("ném giá trị không phải Error", () => {
    expect(exceptionFields("boom")).toEqual({ "exception.type": "string", "exception.message": "boom" });
    expect(exceptionFields(null)).toEqual({ "exception.type": "null", "exception.message": "null" });
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(exceptionFields(circ)["exception.type"]).toBe("object");
  });

  /**
   * T-151 review (🟢6): `describeNonError` tự che TRƯỚC khi JSON.stringify — gọi `exceptionFields` trực tiếp (không qua
   * logger, vốn che lại lần nữa) nên bỏ `redactLog` trong describeNonError là test này đỏ.
   */
  it("giá trị không phải Error (trực tiếp và trong chuỗi cause) có PII → exceptionFields đã che", () => {
    const raw = {
      email: "khach.hang@example.test",
      phone: "0912345678",
      shipping: { line: "12 Lê Lợi, Phường Bến Nghé, Quận 1" },
      message: `insert into "fashion_model_measurement" ("height_cm", "hip_cm") values (173, 99) - boom`,
    };
    const leak = /khach\.hang|0912345678|Lê Lợi|Bến Nghé|173|\b99\b/;
    const direct = exceptionFields(raw)["exception.message"];
    const chained = String(
      exceptionFields(new Error("ghi DB thất bại", { cause: raw }))["exception.stacktrace"],
    );
    for (const text of [direct, chained]) {
      expect(text).not.toMatch(leak);
      expect(text).toContain(`"email":"${REDACTED}"`);
      expect(text).toContain(`"phone":"${REDACTED}"`);
      expect(text).toContain(`insert into \\"fashion_model_measurement\\" ${REDACTED} - boom`);
    }
    expect(chained).toContain('Caused by: {"email"');
  });

  it("thông điệp/stack ngoại lệ cũng qua bộ che", () => {
    const { logger, records } = capture();
    logger.error(new Error("gửi SMS tới 0912345678 thất bại"));
    const r = records()[0]!;
    expect(r["exception.message"]).toBe("gửi SMS tới [PHONE] thất bại");
    expect(String(r["exception.stacktrace"])).not.toContain("0912345678");
    expect(r.message).toBe("gửi SMS tới [PHONE] thất bại");
  });
});

describe("interface Logger của Medusa", () => {
  it("activity/progress/success/failure mang activity_id + duration_ms", () => {
    const { logger, records } = capture();
    const id = logger.activity("Đang dựng", { x: 1 });
    logger.progress(id, "50%");
    expect(logger.success(id, "xong")).toMatchObject({ activity: id });
    const id2 = logger.activity("lần 2");
    expect(logger.failure(id2, "hỏng")).toMatchObject({ activity: id2 });
    expect(logger.success("khong-ton-tai", "x")).toEqual({ activity: "khong-ton-tai" });
    const rs = records();
    expect(rs[0]).toMatchObject({ message: "Đang dựng", activity_id: id, activity_config: { x: 1 } });
    expect(rs[2]).toMatchObject({ message: "xong", activity_id: id });
    expect(typeof rs[2]!.duration_ms).toBe("number");
    expect(rs[4]).toMatchObject({ level: "error", message: "hỏng" });
  });

  it("log(...args) định dạng như console; Error trong args → trường exception", () => {
    const { logger, records } = capture();
    logger.log("redisUrl %s", "không có", new Error("e"));
    expect(records()[0]).toMatchObject({ message: "redisUrl không có", "exception.message": "e" });
  });

  it("panic → bản ghi fatal + thoát mã 1", () => {
    const { logger, records, exits } = capture();
    logger.panic({ id: "10111", context: { rootPath: "/x" } });
    expect(records()[0]).toMatchObject({ level: "fatal", severity_number: 21, panic_id: "10111" });
    expect(exits).toEqual([1]);
  });
});

describe("ngữ cảnh trace theo request", () => {
  it("runWithLogContext → mọi bản ghi trong ngữ cảnh có trace_id/span_id; ngoài ngữ cảnh thì không", () => {
    const { logger, records } = capture();
    runWithLogContext({ trace_id: "t-1", span_id: "00f067aa0ba902b7" }, () => logger.info("trong"));
    logger.info("ngoài");
    expect(records()[0]).toMatchObject({ trace_id: "t-1", span_id: "00f067aa0ba902b7" });
    expect(records()[1]).not.toHaveProperty("trace_id");
  });

  it("đồng thời: 20 request xen kẽ qua await → mỗi bản ghi đúng trace_id của request đó", async () => {
    const { logger, records } = capture();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runWithLogContext({ trace_id: `t-${i}` }, async () => {
          await new Promise((r) => setTimeout(r, (i * 7) % 5));
          logger.emit("info", "bước 1", { i });
          await Promise.resolve();
          logger.emit("info", "bước 2", { i });
        }),
      ),
    );
    const rs = records();
    expect(rs).toHaveLength(40);
    for (const r of rs) expect(r.trace_id).toBe(`t-${r.i as number}`);
  });
});

describe("middleware requestLogContext", () => {
  function fakeReqRes(url: string, logger: unknown, requestId: unknown = "req-1") {
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
    const req = {
      method: "GET",
      originalUrl: url,
      url,
      requestId,
      scope: { resolve: () => logger },
    };
    return { req, res };
  }
  const call = (req: unknown, res: unknown, next: () => void) =>
    requestLogContext(
      req as MedusaRequest,
      res as unknown as MedusaResponse,
      next as unknown as MedusaNextFunction,
    );

  it("log trong request mang trace_id = request id, span_id 16 hex; log truy cập: đường dẫn KHÔNG query, status, thời gian", () => {
    const { logger, records } = capture();
    const { req, res } = fakeReqRes("/store/x/search?q=0912345678&token=abc", logger);
    let inside: ReturnType<typeof currentLogContext>;
    call(req, res, () => {
      inside = currentLogContext();
      logger.info("trong route");
    });
    expect(inside!.trace_id).toBe("req-1");
    expect(inside!.span_id).toMatch(/^[0-9a-f]{16}$/);
    res.statusCode = 201;
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");
    const rs = records();
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ message: "trong route", trace_id: "req-1", span_id: inside!.span_id });
    expect(rs[1]).toMatchObject({
      level: "info",
      message: "http.server.request",
      trace_id: "req-1",
      span_id: inside!.span_id,
      "http.request.method": "GET",
      "url.path": "/store/x/search",
      "http.response.status_code": 201,
    });
    expect(typeof rs[1]!.duration_ms).toBe("number");
    expect(JSON.stringify(rs)).not.toMatch(/0912345678|token=abc/);
  });

  it("5xx → mức error; kết nối đóng trước khi xong → http.aborted", () => {
    const { logger, records } = capture();
    const a = fakeReqRes("/admin/x/orders", logger);
    call(a.req, a.res, () => undefined);
    a.res.statusCode = 500;
    a.res.emit("finish");
    const b = fakeReqRes("/admin/x/orders", logger, "req-2");
    call(b.req, b.res, () => undefined);
    b.res.emit("close");
    expect(records()[0]).toMatchObject({ level: "error", "http.response.status_code": 500 });
    expect(records()[1]).toMatchObject({ trace_id: "req-2", "http.aborted": true });
  });

  it("probe sức khoẻ không ghi log truy cập; logger không phải AppLogger → không log truy cập, vẫn next()", () => {
    const { logger, records } = capture();
    const h = fakeReqRes("/x/readyz", logger);
    const next = jest.fn();
    call(h.req, h.res, next);
    h.res.emit("finish");
    expect(records()).toHaveLength(0);
    const other = fakeReqRes("/store/x/products", { info: jest.fn() });
    call(other.req, other.res, next);
    other.res.emit("finish");
    expect(next).toHaveBeenCalledTimes(2);
    const broken = {
      ...fakeReqRes("/a", logger).req,
      scope: {
        resolve: () => {
          throw new Error("no");
        },
      },
    };
    call(broken, fakeReqRes("/a", logger).res, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("x-request-id xấu (có CR/LF) → trace_id UUID mới", () => {
    const { logger } = capture();
    const { req, res } = fakeReqRes("/a", logger, "bad\nid");
    let ctx: ReturnType<typeof currentLogContext>;
    call(req, res, () => (ctx = currentLogContext()));
    expect(ctx!.trace_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("hook server (installAccessLogServerHook): request bị chặn trước middleware vẫn được ghi đúng 1 lần; middleware không ghi trùng, cùng span", () => {
    const { logger, records } = capture();
    const mod = { createServer: (() => new EventEmitter()) as (...a: never[]) => unknown };
    expect(installAccessLogServerHook(logger, mod)).toBe(true);
    expect(installAccessLogServerHook(logger, mod)).toBe(false);
    const server = mod.createServer() as EventEmitter;
    // (1) 401 admin: Medusa chặn trước middleware dự án — chỉ hook server thấy request.
    const a = fakeReqRes("/admin/products", logger, "req-401");
    delete (a.req as { originalUrl?: string }).originalUrl;
    Object.assign(a.req, { url: "/admin/products" });
    server.emit("request", a.req, a.res);
    a.res.statusCode = 401;
    a.res.emit("finish");
    // (2) route thường: hook + middleware → vẫn 1 bản ghi, middleware dùng span của hook.
    const b = fakeReqRes("/store/x/products", logger, "req-ok");
    server.emit("request", b.req, b.res);
    let ctx: ReturnType<typeof currentLogContext>;
    call(b.req, b.res, () => (ctx = currentLogContext()));
    b.res.emit("finish");
    b.res.emit("close");
    const rs = records();
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({
      "url.path": "/admin/products",
      "http.response.status_code": 401,
      trace_id: "req-401",
    });
    expect(rs[1]).toMatchObject({
      "url.path": "/store/x/products",
      trace_id: "req-ok",
      span_id: ctx!.span_id,
    });
  });

  it("hook server không bao giờ ném: server không có prependListener; req/res lạ", () => {
    const { logger } = capture();
    const mod = { createServer: (() => ({})) as (...a: never[]) => unknown };
    installAccessLogServerHook(logger, mod);
    expect(() => mod.createServer()).not.toThrow();
    const mod2 = { createServer: (() => new EventEmitter()) as (...a: never[]) => unknown };
    installAccessLogServerHook(logger, mod2);
    const server = mod2.createServer() as EventEmitter;
    expect(() => server.emit("request", null, null)).not.toThrow();
    expect(() => trackRawRequest(Object.freeze({}), {}, logger)).not.toThrow();
  });

  it("pathOf", () => {
    expect(pathOf({ originalUrl: "/a/b?x=1" })).toBe("/a/b");
    expect(pathOf({ url: "/c" })).toBe("/c");
    expect(pathOf({})).toBe("/");
    // Đường dẫn dài (đối nghịch) bị cắt trước khi vào log/bộ che.
    const long = pathOf({ originalUrl: `/${"a".repeat(50_000)}?q=1` });
    expect(long.length).toBeLessThan(MAX_PATH + 20);
  });
});

describe("logger của ứng dụng (medusa-config) + LOG_LEVEL", () => {
  it("service/version/env từ cấu hình; version đọc package.json của backend", () => {
    const raw: string[] = [];
    const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      raw.push(String(chunk));
      return true;
    });
    try {
      appLoggerFromEnv({ NODE_ENV: "production", LOG_LEVEL: "info" }).info("x");
    } finally {
      spy.mockRestore();
    }
    expect(raw).toHaveLength(1);
    expect(raw[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw[0]!)).toMatchObject({ service: SERVICE_NAME, version: "0.1.0", env: "production" });
  });

  it("serviceVersion: package.json xấu/thiếu → biến npm hoặc unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "xs-ver-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0\n[ERROR]" }));
    const prev = process.env.npm_package_version;
    try {
      delete process.env.npm_package_version;
      expect(serviceVersion(dir)).toBe("unknown");
      process.env.npm_package_version = "2.0.0";
      expect(serviceVersion(join(dir, "khong-co"))).toBe("2.0.0");
    } finally {
      if (prev === undefined) delete process.env.npm_package_version;
      else process.env.npm_package_version = prev;
    }
  });

  it.each([
    [undefined, "info"],
    ["", "info"],
    ["debug", "debug"],
    ["http", "http"],
  ])("LOG_LEVEL=%j → %s", (v, expected) => {
    const r = parseEnv({ DATABASE_URL: "postgres://u:p@h:5432/d", ...(v !== undefined && { LOG_LEVEL: v }) });
    expect(r.ok && r.env.LOG_LEVEL).toBe(expected);
  });

  it("LOG_LEVEL sai → lỗi nêu tên biến", () => {
    const r = parseEnv({ DATABASE_URL: "postgres://u:p@h:5432/d", LOG_LEVEL: "loud" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.map((p) => p.variable)).toContain("LOG_LEVEL");
  });
});
