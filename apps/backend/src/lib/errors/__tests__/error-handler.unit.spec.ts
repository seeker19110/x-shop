import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { z } from "zod";
import { CheckoutError, sendProblem as sendCheckoutProblem } from "../../checkout/errors";
import { sendProblem } from "../../http/problem";
import { INTERNAL_LEAK, logServerError, toHttpProblem, xErrorHandler } from "../error-handler";
import { REQUEST_ID_PATTERN, traceIdOf } from "../trace";

/** Regex kiểm của BASE-ERR-003 (blueprint) — phản hồi lỗi không được khớp. */
const BLUEPRINT_LEAK = /(Traceback|at .*\.(js|py|java)|SELECT |\/home\/|\/var\/)/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Captured {
  status?: number;
  headers: Record<string, string>;
  body?: string;
}

function fakeRes(opts: { headersSent?: boolean } = {}) {
  const captured: Captured = { headers: {} };
  const res = {
    headersSent: opts.headersSent ?? false,
    req: undefined as unknown,
    status(code: number) {
      captured.status = code;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body: string) {
      captured.body = body;
      return res;
    },
    json(body: unknown) {
      captured.body = JSON.stringify(body);
      return res;
    },
  };
  return { res, captured };
}

function fakeReq(requestId?: unknown) {
  const logs: { level: "error" | "info"; msg: string }[] = [];
  const logger = {
    error: (msg: string) => logs.push({ level: "error", msg }),
    info: (msg: string) => logs.push({ level: "info", msg }),
  };
  const req = {
    method: "POST",
    path: "/store/x/thing",
    requestId,
    scope: { resolve: () => logger },
  };
  return { req, logs };
}

function run(err: unknown, requestId?: unknown, resOpts: { headersSent?: boolean } = {}) {
  const { req, logs } = fakeReq(requestId);
  const { res, captured } = fakeRes(resOpts);
  res.req = req;
  const next = jest.fn();
  xErrorHandler(
    err,
    req as unknown as MedusaRequest,
    res as unknown as MedusaResponse,
    next as unknown as MedusaNextFunction,
  );
  const body = captured.body ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined;
  return { captured, body, logs, next, req };
}

/** Lỗi giả của driver pg (các trường của DatabaseError). */
function pgError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "x_refund_pkey"`), {
    code,
    severity: "ERROR",
    routine: "_bt_check_unique",
    ...extra,
  });
}

describe("traceIdOf", () => {
  it("dùng requestId hợp lệ của Medusa (header x-request-id hoặc UUID)", () => {
    expect(traceIdOf({ requestId: "req_01ABC:x.y-z" })).toBe("req_01ABC:x.y-z");
  });

  it.each([
    ["CR/LF (log injection)", "abc\r\nlevel=fatal"],
    ["ký tự HTML", "<script>"],
    ["quá dài", "a".repeat(129)],
    ["rỗng", ""],
    ["không phải chuỗi", 42],
  ])("requestId xấu (%s) → UUID mới, ghi đè lên request", (_n, bad) => {
    const req: { requestId?: unknown } = { requestId: bad };
    const id = traceIdOf(req);
    expect(id).toMatch(UUID);
    expect(req.requestId).toBe(id);
    expect(traceIdOf(req)).toBe(id);
  });

  it("không có request → vẫn có mã", () => {
    expect(traceIdOf(undefined)).toMatch(UUID);
    expect(REQUEST_ID_PATTERN.test(traceIdOf(null))).toBe(true);
  });
});

describe("toHttpProblem — 5xx không lộ chi tiết", () => {
  const leaky = [
    ["Error có stack + đường dẫn", new Error("ENOENT: no such file '/home/app/apps/backend/src/x.ts'")],
    [
      "câu SQL",
      new Error(`select "x_refund".* from "x_refund" where "id" = 'r1' - relation "x_refund" does not exist`),
    ],
    ["TypeError thường", new TypeError("Cannot read properties of undefined (reading 'id')")],
    [
      "DB_ERROR của Medusa (giữ message gốc ở mặc định)",
      new MedusaError(MedusaError.Types.DB_ERROR, "insert into user_role failed"),
    ],
    [
      "UNEXPECTED_STATE (Medusa giữ message ở 500)",
      new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "medusa v2.22.1 at /var/lib"),
    ],
    ["không phải Error", { secret: "postgres://u:p@10.0.0.5:5432/db" }],
    ["chuỗi", "boom /var/log"],
    ["null", null],
    ["undefined", undefined],
  ] as const;

  it.each(leaky)("%s → 500 INTERNAL, thông điệp chung", (_n, err) => {
    const p = toHttpProblem(err, "t-1");
    expect(p.status).toBe(500);
    expect(p.body).toEqual({
      type: "about:blank",
      title: "Không thể xử lý yêu cầu lúc này",
      status: 500,
      code: "INTERNAL",
      detail: "Không thể xử lý yêu cầu lúc này",
      message: "Không thể xử lý yêu cầu lúc này",
      trace_id: "t-1",
    });
    expect(JSON.stringify(p.body)).not.toMatch(BLUEPRINT_LEAK);
  });

  it("bộ định dạng của Medusa tự ném (lỗi 23505 thiếu `table`) → 500 chung, không ném tiếp", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(() => toHttpProblem(err, "t")).not.toThrow();
    expect(toHttpProblem(err, "t").status).toBe(500);
  });
});

describe("toHttpProblem — 4xx giữ mã của Medusa, bỏ chi tiết nội bộ", () => {
  it.each([
    [MedusaError.Types.NOT_FOUND, 404, "NOT_FOUND"],
    [MedusaError.Types.INVALID_DATA, 400, "INVALID_DATA"],
    [MedusaError.Types.NOT_ALLOWED, 400, "INVALID_DATA"],
    [MedusaError.Types.UNAUTHORIZED, 401, "UNAUTHORIZED"],
    [MedusaError.Types.FORBIDDEN, 403, "FORBIDDEN"],
    [MedusaError.Types.DUPLICATE_ERROR, 422, "invalid_request_error"],
    [MedusaError.Types.CONFLICT, 409, "invalid_state_error"],
  ])("MedusaError %s → %d %s, giữ thông điệp an toàn", (type, status, code) => {
    const p = toHttpProblem(new MedusaError(type, "Giỏ hàng cart_01 không tồn tại"), "t");
    expect(p.status).toBe(status);
    expect(p.body.code).toBe(code);
    expect(p.body.trace_id).toBe("t");
    if (type !== MedusaError.Types.CONFLICT) {
      expect(p.body.detail).toBe("Giỏ hàng cart_01 không tồn tại");
      expect(p.body.message).toBe(p.body.detail);
    }
  });

  it("mã native có sẵn (vd insufficient_inventory) giữ nguyên — client đang đọc", () => {
    const err = new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Some variant does not have the required inventory",
      "insufficient_inventory",
    );
    const p = toHttpProblem(err, "t");
    expect(p).toMatchObject({
      status: 400,
      body: { code: "insufficient_inventory", detail: "Some variant does not have the required inventory" },
    });
  });

  it.each([
    [
      "23505 trùng khoá",
      pgError("23505", { table: "x_refund", detail: "Key (id)=(r1) already exists." }),
      422,
    ],
    [
      "23503 khoá ngoại",
      pgError("23503", { table: "x_return", detail: 'Key (order_id)=(o1) is not present in table "order".' }),
      404,
    ],
    ["23502 null", pgError("23502", { table: "x_refund", column: "amount" }), 400],
  ])("lỗi Postgres %s → %d, không lộ tên bảng/cột", (_n, err, status) => {
    const p = toHttpProblem(err, "t");
    expect(p.status).toBe(status);
    expect(JSON.stringify(p.body)).not.toMatch(/x_refund|x_return|order_id|amount|Key \(/);
  });

  it("4xx có thông điệp trông như lộ nội bộ → thay bằng tiêu đề chung", () => {
    const p = toHttpProblem(
      new MedusaError(MedusaError.Types.INVALID_DATA, "bad at /home/app/src/x.ts:12:3"),
      "t",
    );
    expect(p.status).toBe(400);
    expect(p.body.detail).toBe("Yêu cầu không hợp lệ");
  });

  it("4xx thông điệp rỗng/quá dài → tiêu đề chung", () => {
    expect(toHttpProblem(new MedusaError(MedusaError.Types.NOT_FOUND, ""), "t").body.detail).toBe(
      "Không tìm thấy",
    );
    expect(
      toHttpProblem(new MedusaError(MedusaError.Types.NOT_FOUND, "x".repeat(501)), "t").body.detail,
    ).toBe("Không tìm thấy");
  });

  it("lỗi zod thô → 400 VALIDATION có errors[] (Medusa mặc định trả 500)", () => {
    const r = z.strictObject({ qty: z.number().int() }).safeParse({ qty: "x", extra: 1 });
    expect(r.success).toBe(false);
    const p = toHttpProblem(r.error, "t");
    expect(p.status).toBe(400);
    expect(p.body.code).toBe("VALIDATION");
    expect(p.body.errors?.length).toBeGreaterThan(0);
    expect(p.body.errors?.[0]).toEqual({ param: expect.any(String), reason: expect.any(String) });
  });

  it.each([
    [
      "JSON hỏng",
      {
        statusCode: 400,
        status: 400,
        expose: true,
        type: "entity.parse.failed",
        message: "Unexpected token } in JSON at position 7",
      },
      400,
      "Thân yêu cầu không phải JSON hợp lệ",
    ],
    [
      "quá lớn",
      {
        statusCode: 413,
        status: 413,
        expose: true,
        type: "entity.too.large",
        message: "request entity too large",
      },
      413,
      "Dữ liệu gửi lên quá lớn",
    ],
    [
      "415",
      { statusCode: 415, expose: true, type: "charset.unsupported", message: 'unsupported charset "UTF-7"' },
      415,
      'unsupported charset "UTF-7"',
    ],
    [
      "http-error 5xx",
      { statusCode: 502, expose: false, message: "upstream 10.0.0.2:80 refused" },
      502,
      "Không thể xử lý yêu cầu lúc này",
    ],
  ])("lỗi body-parser/http-errors (%s) → %d", (_n, err, status, detail) => {
    const p = toHttpProblem(Object.assign(new Error(String(err.message)), err), "t");
    expect(p.status).toBe(status);
    expect(p.body.detail).toBe(detail);
  });

  it("multer: quá cỡ → 413, khác → 400", () => {
    const big = Object.assign(new Error("File too large"), { name: "MulterError", code: "LIMIT_FILE_SIZE" });
    const other = Object.assign(new Error("Unexpected field"), {
      name: "MulterError",
      code: "LIMIT_UNEXPECTED_FILE",
    });
    expect(toHttpProblem(big, "t").status).toBe(413);
    expect(toHttpProblem(other, "t").status).toBe(400);
  });

  it("INTERNAL_LEAK nhận dạng các dấu hiệu nội bộ", () => {
    for (const s of [
      "at foo (/app/x.js:1:2)",
      "SELECT * FROM a",
      'relation "user_role"',
      "connect ECONNREFUSED",
      "10.0.0.5:5432",
      "postgres error",
    ]) {
      expect(INTERNAL_LEAK.test(s)).toBe(true);
    }
    for (const s of ["Không tìm thấy giỏ hàng", "Cart with id cart_01 was not found", "Số lượng phải ≥ 1"]) {
      expect(INTERNAL_LEAK.test(s)).toBe(false);
    }
  });
});

describe("xErrorHandler", () => {
  it("ngoại lệ chưa bắt → 500 problem+json kèm trace_id, log ERROR có stack + cùng trace_id", () => {
    const err = new Error("kaboom at /home/app/x.ts");
    const { captured, body, logs, next } = run(err, "req-123");
    expect(captured.status).toBe(500);
    expect(captured.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
    expect(captured.headers["cache-control"]).toBe("no-store");
    expect(body).toMatchObject({ status: 500, code: "INTERNAL", trace_id: "req-123" });
    expect(captured.body).not.toMatch(BLUEPRINT_LEAK);
    expect(captured.body).not.toContain("kaboom");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("error");
    expect(logs[0]!.msg).toContain("trace_id=req-123");
    expect(logs[0]!.msg).toContain("kaboom");
    expect(logs[0]!.msg).toContain(err.stack!.split("\n")[1]!.trim());
    expect(next).not.toHaveBeenCalled();
  });

  it("4xx → log INFO ngắn (không thông điệp lỗi, không stack)", () => {
    const { captured, body, logs } = run(new MedusaError(MedusaError.Types.NOT_FOUND, "Không có"), "r1");
    expect(captured.status).toBe(404);
    expect(body).toMatchObject({ code: "NOT_FOUND", trace_id: "r1" });
    expect(logs).toEqual([{ level: "info", msg: "[http] 404 NOT_FOUND POST /store/x/thing trace_id=r1" }]);
  });

  it("x-request-id xấu → trace_id là UUID mới, request được gán lại cùng mã", () => {
    const { body, req } = run(new Error("x"), "bad\nid");
    expect(String(body?.trace_id)).toMatch(UUID);
    expect(req.requestId).toBe(body?.trace_id);
  });

  it("phản hồi đã gửi một phần → không ghi thêm, log lỗi, chuyển next(err) để Express đóng kết nối", () => {
    const err = new Error("stream vỡ");
    const { captured, logs, next } = run(err, "r2", { headersSent: true });
    expect(captured.status).toBeUndefined();
    expect(captured.body).toBeUndefined();
    expect(next).toHaveBeenCalledWith(err);
    expect(logs[0]!.level).toBe("error");
  });

  it("handler tiếp tục phục vụ sau lỗi (gọi nhiều lần liên tiếp/đồng thời đều đúng)", async () => {
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => run(new Error(`e${i}`), `r-${i}`))),
    );
    expect(outs.map((o) => o.body?.trace_id)).toEqual(Array.from({ length: 20 }, (_, i) => `r-${i}`));
    expect(new Set(outs.map((o) => o.captured.status))).toEqual(new Set([500]));
  });

  it("logger không resolve được → vẫn trả 500 (log ra console)", () => {
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { res, captured } = fakeRes();
      const req = {
        method: "GET",
        path: "/x",
        requestId: "r",
        scope: {
          resolve: () => {
            throw new Error("no");
          },
        },
      };
      xErrorHandler(
        new Error("x"),
        req as unknown as MedusaRequest,
        res as unknown as MedusaResponse,
        jest.fn() as unknown as MedusaNextFunction,
      );
      expect(captured.status).toBe(500);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("logServerError", () => {
  it("giá trị không phải Error (vòng tham chiếu) → vẫn ghi được, trả trace_id", () => {
    const { req, logs } = fakeReq("r-9");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(logServerError(req as unknown as MedusaRequest, "checkout", circular)).toBe("r-9");
    expect(logs[0]!.msg).toMatch(/^\[checkout\] POST \/store\/x\/thing trace_id=r-9: /);
  });
});

describe("problem+json của route có trace_id (cùng mã với log)", () => {
  it("lib/http/problem.sendProblem", () => {
    const { res, captured } = fakeRes();
    res.req = { requestId: "req-a" };
    sendProblem(
      res as unknown as MedusaResponse,
      422,
      "VALIDATION",
      "Dữ liệu chưa hợp lệ",
      [{ param: "x", reason: "y" }],
      { extra: 1 },
    );
    expect(JSON.parse(captured.body!)).toEqual({
      type: "about:blank",
      title: "Dữ liệu chưa hợp lệ",
      status: 422,
      code: "VALIDATION",
      errors: [{ param: "x", reason: "y" }],
      extra: 1,
      trace_id: "req-a",
    });
  });

  it("extra không đè được trace_id", () => {
    const { res, captured } = fakeRes();
    res.req = { requestId: "req-b" };
    sendProblem(res as unknown as MedusaResponse, 400, "X", "x", [], { trace_id: "giả" });
    expect(JSON.parse(captured.body!).trace_id).toBe("req-b");
  });

  it("checkout sendProblem giữ mã nghiệp vụ, thêm trace_id", () => {
    const { res, captured } = fakeRes();
    res.req = { requestId: "req-c" };
    sendCheckoutProblem(res, new CheckoutError("INSUFFICIENT_STOCK"));
    expect(captured.status).toBe(409);
    expect(JSON.parse(captured.body!)).toMatchObject({
      code: "INSUFFICIENT_STOCK",
      status: 409,
      trace_id: "req-c",
    });
  });
});
