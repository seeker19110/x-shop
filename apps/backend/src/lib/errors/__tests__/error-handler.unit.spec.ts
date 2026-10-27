import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { z } from "zod";
import { CheckoutError, sendProblem as sendCheckoutProblem } from "../../checkout/errors";
import { sendProblem } from "../../http/problem";
import {
  DEFAULT_RETRY_AFTER_SECONDS,
  dbValueMessage,
  echoedValueMessage,
  INTERNAL_LEAK,
  logServerError,
  toHttpProblem,
  xErrorHandler,
} from "../error-handler";
import { REDACTED } from "../../log/redact";
import { REQUEST_ID_PATTERN, traceIdOf } from "../trace";
import { isNonEmpty } from "@x-shop/domain";

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
    getHeader(name: string): string | undefined {
      return captured.headers[name.toLowerCase()];
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
  const logs: { level: "error" | "info"; msg: string; err?: Error }[] = [];
  const logger = {
    error: (msg: string, err?: Error) => logs.push({ level: "error", msg, ...(err && { err }) }),
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
  const body = isNonEmpty(captured.body) ? (JSON.parse(captured.body) as Record<string, unknown>) : undefined;
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

  it("URIError (Express không giải mã được tham số đường dẫn, gắn status 400) → 400 INVALID_PATH, không 500", () => {
    const err = Object.assign(new URIError("Failed to decode param '%E0%A4%A'"), {
      status: 400,
      statusCode: 400,
    });
    expect(toHttpProblem(err, "t")).toMatchObject({
      status: 400,
      body: { code: "INVALID_PATH", detail: "Đường dẫn không hợp lệ", trace_id: "t" },
    });
    expect(toHttpProblem(new URIError("URI malformed"), "t").status).toBe(400);
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
  it("ngoại lệ chưa bắt → 500 problem+json kèm trace_id, log ERROR có Error (stack) + cùng trace_id", () => {
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
    // Stack đi theo Error (tham số thứ hai) → logger ghi exception.stacktrace (T-090), không nhồi vào message.
    expect(logs[0]!.err).toBe(err);
    expect(logs[0]!.msg).not.toContain(err.stack!.split("\n")[1]!.trim());
    expect(next).not.toHaveBeenCalled();
  });

  it("4xx → log INFO ngắn (không thông điệp lỗi, không stack)", () => {
    const { captured, body, logs } = run(new MedusaError(MedusaError.Types.NOT_FOUND, "Không có"), "r1");
    expect(captured.status).toBe(404);
    expect(body).toMatchObject({ code: "NOT_FOUND", trace_id: "r1" });
    expect(logs).toEqual([{ level: "info", msg: "[http] 404 NOT_FOUND POST /store/x/thing trace_id=r1" }]);
  });

  it("429 lọt tới handler toàn cục → luôn kèm Retry-After (mặc định); route đã đặt giá trị riêng thì giữ nguyên", () => {
    const tooMany = Object.assign(new Error("Too Many Requests"), { status: 429, expose: true });
    const { captured, body } = run(tooMany, "r429");
    expect(captured.status).toBe(429);
    expect(body).toMatchObject({ code: "RATE_LIMITED" });
    expect(captured.headers["retry-after"]).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));

    const { req } = fakeReq("r429b");
    const { res, captured: c2 } = fakeRes();
    res.req = req;
    res.setHeader("Retry-After", "7");
    xErrorHandler(
      tooMany,
      req as unknown as MedusaRequest,
      res as unknown as MedusaResponse,
      jest.fn() as unknown as MedusaNextFunction,
    );
    expect(c2.headers["retry-after"]).toBe("7");
    // Mã khác 429 không bị gắn Retry-After.
    expect(
      run(new MedusaError(MedusaError.Types.NOT_FOUND, "x")).captured.headers["retry-after"],
    ).toBeUndefined();
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

  /**
   * T-151 review (🟢6): `describeError` tự che TRƯỚC khi tuần tự hoá — logger giả ở đây ghi nguyên văn (không che), nên
   * bỏ `redactLog` trong describeError là test này đỏ (logger thật che lại lần nữa nên test qua logger thật không phát hiện).
   */
  const PII_THROWN = {
    name: "DriverException",
    email: "khach.hang@example.test",
    phone: "0912345678",
    customer: { full_name: "Nguyễn Văn A", note: "giao 12 Lê Lợi, Phường Bến Nghé, Quận 1" },
    detail: "gọi lại 0987 654 321",
    message: `update "fashion_product_attributes" set "image_exception_by" = 'user_qa_t144', "weight" = 9431 where "id" = 'fpa_01J' - boom`,
  };
  const PII_LEAK = /khach\.hang|0912345678|Nguyễn|Lê Lợi|Bến Nghé|0987|user_qa_t144|9431|fpa_01J/;
  function assertRedactedMessage(msg: string) {
    expect(msg).not.toMatch(PII_LEAK);
    expect(msg).toContain(`"email":"${REDACTED}"`);
    expect(msg).toContain(`"phone":"${REDACTED}"`);
    expect(msg).toContain(`"customer":{"full_name":"${REDACTED}","note":"giao [ADDRESS]"}`);
    expect(msg).toContain(`update \\"fashion_product_attributes\\" set ${REDACTED} - boom`);
  }

  it("logServerError: object thường có PII (tên trường, nội dung, câu SQL) → thông điệp đã che", () => {
    const { req, logs } = fakeReq("r-151");
    logServerError(req as unknown as MedusaRequest, "x", PII_THROWN);
    assertRedactedMessage(logs[0]!.msg);
  });

  it("xErrorHandler 500 với object thường có PII → log đã che, phản hồi không lộ gì", () => {
    const { logs, body } = run(PII_THROWN, "r-152");
    expect(body?.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(PII_LEAK);
    assertRedactedMessage(logs[0]!.msg);
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

/** T-157 / D-097 — thông điệp `dbErrorMapper` của Medusa chép giá trị người gửi; phản hồi 4xx chỉ giữ tên trường. */
describe("toHttpProblem — dbErrorMapper không chép giá trị (T-157)", () => {
  const uniqueMsg = (pairs: string[]) =>
    `Fashion model measurement with ${pairs.join(", ")}, already exists.`;
  const fkMsg = (pairs: string[]) =>
    `You tried to set relationship ${pairs.join(",")}, but such entity does not exist`;
  const VALUES = [
    "173",
    "a: b: c",
    "dòng một\ndòng hai\n    at x.ts:1",
    "Nguyễn Văn Ạ 0912345678 😀",
    "khach@example.test",
    "",
  ];

  it("unique → 400 giữ mã + tên trường, bỏ giá trị và tên bảng", () => {
    const err = new MedusaError(MedusaError.Types.INVALID_DATA, uniqueMsg(["height_cm: 173", "hip_cm: 139"]));
    const p = toHttpProblem(err, "t");
    expect(p.status).toBe(400);
    expect(p.body.code).toBe("INVALID_DATA");
    expect(p.body.detail).toBe("Giá trị đã tồn tại (trường: height_cm, hip_cm)");
    expect(p.body.message).toBe(p.body.detail);
    expect(p.body.errors).toEqual([
      { param: "height_cm", reason: "Giá trị đã tồn tại" },
      { param: "hip_cm", reason: "Giá trị đã tồn tại" },
    ]);
    expect(JSON.stringify(p.body)).not.toMatch(/173|139|Fashion|measurement/);
  });

  it("FK → giữ status 404 + tên trường, bỏ giá trị", () => {
    const p = toHttpProblem(
      new MedusaError(MedusaError.Types.NOT_FOUND, fkMsg(["product_id: prod_01SECRET", "order_id: o1"])),
      "t",
    );
    expect(p.status).toBe(404);
    expect(p.body.detail).toBe("Tham chiếu không tồn tại (trường: product_id, order_id)");
    expect(JSON.stringify(p.body)).not.toMatch(/prod_01SECRET|o1/);
  });

  it.each(VALUES)("giá trị đặc biệt %j không lọt ra, trường còn", (value) => {
    for (const msg of [
      uniqueMsg([`email: ${value}`, "has_account: false"]),
      fkMsg([`email: ${value}`, "a: 1"]),
    ]) {
      const kind = msg.startsWith("You") ? MedusaError.Types.NOT_FOUND : MedusaError.Types.INVALID_DATA;
      const p = toHttpProblem(new MedusaError(kind, msg), "t");
      expect(p.body.errors?.[0]?.param).toBe("email");
      const text = JSON.stringify(p.body);
      for (const leak of ["Nguyễn", "0912345678", "😀", "khach@example", "a: b", "dòng", "x.ts", "173"])
        expect(text).not.toContain(leak);
    }
  });

  it("một khoá, tên trường không hợp lệ, quá dài, 'undefined': vẫn không lộ giá trị", () => {
    const one = toHttpProblem(
      new MedusaError(MedusaError.Types.INVALID_DATA, uniqueMsg(["handle: áo-thun"])),
      "t",
    );
    expect(one.body.detail).toBe("Giá trị đã tồn tại (trường: handle)");
    const badKey = toHttpProblem(
      new MedusaError(MedusaError.Types.INVALID_DATA, uniqueMsg(["không hợp lệ: bí mật"])),
      "t",
    );
    expect(badKey.body.detail).toBe("Giá trị đã tồn tại");
    expect(badKey.body.errors).toBeUndefined();
    const long = toHttpProblem(
      new MedusaError(MedusaError.Types.INVALID_DATA, uniqueMsg([`k: ${"x".repeat(10_000)}`])),
      "t",
    );
    expect(long.body.detail).toBe("Giá trị đã tồn tại");
    const undef = toHttpProblem(new MedusaError(MedusaError.Types.NOT_FOUND, fkMsg(["undefined"])), "t");
    expect(undef.body.detail).toBe("Tham chiếu không tồn tại");
  });

  it("không ảnh hưởng 4xx khác (thông điệp thường, thông điệp 'already' sai dạng)", () => {
    for (const m of [
      "Giỏ hàng cart_01 không tồn tại",
      "Email đã được dùng, already exists",
      "with x: 1, already",
    ]) {
      expect(toHttpProblem(new MedusaError(MedusaError.Types.INVALID_DATA, m), "t").body.detail).toBe(m);
    }
    expect(dbValueMessage("Giỏ hàng không tồn tại", 400)).toBeNull();
    expect(dbValueMessage(undefined, 400)).toBeNull();
  });

  it("chỉ viết lại đúng status: unique ở 400, FK ở 404; status khác giữ nguyên", () => {
    const u = "T with handle: ok, already exists.";
    const f = "You tried to set relationship a: b, but such entity does not exist";
    const unauthorized = toHttpProblem(new MedusaError(MedusaError.Types.UNAUTHORIZED, u), "t");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.detail).toBe(u);
    const forbidden = toHttpProblem(new MedusaError(MedusaError.Types.FORBIDDEN, f), "t");
    expect(forbidden.body.detail).toBe(f);
    expect(toHttpProblem(new MedusaError(MedusaError.Types.INVALID_DATA, f), "t").body.detail).toBe(f);
    expect(dbValueMessage(u, 404)).toBeNull();
    expect(dbValueMessage(f, 400)).toBeNull();
  });

  it("33 cặp ngắn (< 4096 ký tự) → thông điệp chung, không có trường", () => {
    const pairs = Array.from({ length: 33 }, (_, i) => `k${i}: v`);
    const u = toHttpProblem(new MedusaError(MedusaError.Types.INVALID_DATA, uniqueMsg(pairs)), "t");
    expect(u.body.detail).toBe("Giá trị đã tồn tại");
    expect(u.body.errors).toBeUndefined();
    const f = toHttpProblem(new MedusaError(MedusaError.Types.NOT_FOUND, fkMsg(pairs)), "t");
    expect(f.body.detail).toBe("Tham chiếu không tồn tại");
    expect(f.body.errors).toBeUndefined();
    const ok = toHttpProblem(
      new MedusaError(MedusaError.Types.INVALID_DATA, uniqueMsg(pairs.slice(0, 32))),
      "t",
    );
    expect(ok.body.errors).toHaveLength(32);
  });

  const N = 32_768;
  const adversarial: Array<[string, string]> = [
    ["unique: lặp ' with '", `${" with ".repeat(N / 6)}, already exists.`],
    ["unique: nhiều cặp", `T with ${"a: b, ".repeat(N / 6)}, already exists.`],
    ["unique: toàn dấu hai chấm", `T with ${": ".repeat(N / 2)}, already exists.`],
    [
      "FK: nhiều cặp",
      `You tried to set relationship ${"a: b,".repeat(N / 5)}, but such entity does not exist`,
    ],
    ["FK: không dấu phẩy", `You tried to set relationship ${"a".repeat(N)}, but such entity does not exist`],
    ["unique: không đuôi", `T with ${"a: b, ".repeat(N / 6)}already exist`],
  ];
  it.each(adversarial)("đối nghịch %s → < 50 ms CPU", (_n, input) => {
    dbValueMessage(input.slice(0, 100), 400);
    const t0 = process.cpuUsage();
    dbValueMessage(input, 400);
    dbValueMessage(input, 404);
    toHttpProblem(new MedusaError(MedusaError.Types.INVALID_DATA, input), "t");
    const d = process.cpuUsage(t0);
    expect((d.user + d.system) / 1000).toBeLessThan(50);
  });
});
describe("toHttpProblem — thông điệp nghiệp vụ Medusa chép giá trị người gửi (T-159)", () => {
  const SECRET = "bí-mật-Nguyễn@example.test 0912345678 😀";
  const T = MedusaError.Types;
  // [tên, kiểu lỗi, status mong đợi, thông điệp dựng từ SECRET, tên trường mong đợi (nếu có)]
  const forms: Array<[string, string, number, string, string | undefined]> = [
    [
      "variant trùng tổ hợp",
      T.INVALID_DATA,
      400,
      `Variant (${SECRET}) with provided options already exists.`,
      "options",
    ],
    [
      "variant cùng tổ hợp",
      T.INVALID_DATA,
      400,
      `Variant "${SECRET}" has same combination of option values as "${SECRET}".`,
      "options",
    ],
    [
      "product trùng gán option",
      T.INVALID_DATA,
      400,
      `Product "${SECRET}" has duplicate option assignments: [${SECRET}]`,
      "options",
    ],
    [
      "product thiếu option",
      T.INVALID_DATA,
      400,
      `Product "${SECRET}" has variants with missing options: [${SECRET}]`,
      "options",
    ],
    [
      "số giá trị option",
      T.INVALID_DATA,
      400,
      `Product has 2 option values but there were 1 provided option values for the variant: ${SECRET}.`,
      "options",
    ],
    [
      "handle sai",
      T.INVALID_DATA,
      400,
      `Invalid product handle '${SECRET}'. It must contain URL safe characters`,
      "handle",
    ],
    [
      "rank không có trong danh sách",
      T.INVALID_DATA,
      400,
      `Value "${SECRET}" is assigned a rank but is not defined in the list of values.`,
      "values",
    ],
    [
      "giá trị option không tồn tại",
      T.INVALID_DATA,
      400,
      `Option value ${SECRET} does not exist for option ${SECRET}`,
      "options",
    ],
    [
      "refund idempotency khác số tiền",
      T.INVALID_DATA,
      400,
      `A refund with idempotency key ${SECRET} already exists on payment pay_01 for a different amount.`,
      "idempotency_key",
    ],
    [
      "refund idempotency đang chạy (loại INVALID_DATA, phòng thủ)",
      T.INVALID_DATA,
      400,
      `A refund with idempotency key ${SECRET} is still in progress on payment pay_01.`,
      "idempotency_key",
    ],
    ["promo không tìm thấy", T.INVALID_DATA, 400, `Promotion code "${SECRET}" not found`, "promo_codes"],
    ["promo không hoạt động", T.INVALID_DATA, 400, `Promotion code "${SECRET}" is not active`, "promo_codes"],
    ["promo không hợp lệ", T.INVALID_DATA, 400, `The promotion code ${SECRET} is invalid`, "promo_codes"],
    [
      "authIdentity không thấy",
      T.NOT_FOUND,
      404,
      `AuthIdentity with entity_id "${SECRET}" not found`,
      "entity_id",
    ],
    [
      "providerIdentity không thấy",
      T.NOT_FOUND,
      404,
      `ProviderIdentity with entity_id "${SECRET}" not found`,
      "entity_id",
    ],
    [
      "nhiều authIdentity",
      T.INVALID_DATA,
      400,
      `Multiple authIdentities found for entity_id "${SECRET}"`,
      "entity_id",
    ],
    [
      "provider identity không thấy",
      T.NOT_FOUND,
      404,
      `Provider identity with entity_id ${SECRET} and provider emailpass not found`,
      "entity_id",
    ],
    ["app metadata trùng khoá", T.INVALID_DATA, 400, `Key ${SECRET} already exists in app metadata`, "key"],
    [
      "kênh bán hàng tắt",
      T.INVALID_DATA,
      400,
      `Unable to assign cart to disabled Sales Channel: ${SECRET}`,
      "sales_channel_id",
    ],
    ["dòng hàng không đơn giá", T.INVALID_DATA, 400, `Line item ${SECRET} has no unit price`, undefined],
    [
      "chuyển đơn cho khách vãng lai",
      T.NOT_ALLOWED,
      400,
      `Cannot transfer order: order_01 to a guest customer account: ${SECRET}`,
      "customer_id",
    ],
    [
      "chuyển đơn cho khách đã đăng ký",
      T.NOT_ALLOWED,
      400,
      `Cannot transfer order: order_01 to registered customer account: ${SECRET}. Only guest customers are allowed.`,
      "customer_id",
    ],
    [
      "email đã có tài khoản",
      T.INVALID_DATA,
      400,
      `User account for following email(s) already exist: ${SECRET}, ${SECRET}`,
      "email",
    ],
  ];

  it.each(forms)("%s → thông điệp chung, giữ status + mã, bỏ giá trị", (_n, kind, status, msg, field) => {
    const baseline = toHttpProblem(new MedusaError(kind as never, "x"), "t");
    const p = toHttpProblem(new MedusaError(kind as never, msg), "t");
    expect(p.status).toBe(status);
    expect(p.status).toBe(baseline.status);
    expect(p.body.code).toBe(baseline.body.code);
    expect(p.body.message).toBe(p.body.detail);
    const text = JSON.stringify(p.body);
    for (const leak of [
      "bí-mật",
      "Nguyễn",
      "example.test",
      "0912345678",
      "😀",
      "pay_01",
      "order_01",
      "emailpass",
    ])
      expect(text).not.toContain(leak);
    if (field === undefined) expect(p.body.errors).toBeUndefined();
    else {
      expect(p.body.errors).toHaveLength(1);
      expect(p.body.errors?.[0]?.param).toBe(field);
      expect(p.body.detail).toContain(`(trường: ${field})`);
    }
    expect(echoedValueMessage(msg)).not.toBeNull();
  });

  it("status và mã Medusa giữ nguyên (404 not_found, 409 conflict)", () => {
    const p = toHttpProblem(
      new MedusaError(T.NOT_FOUND, `AuthIdentity with entity_id "a@b.test" not found`),
      "t",
    );
    expect(p.status).toBe(404);
    expect(p.body.code).toBe("NOT_FOUND");
    const q = toHttpProblem(
      new MedusaError(T.CONFLICT, `A refund with idempotency key k1 is still in progress on payment p.`),
      "t",
    );
    expect(q.status).toBe(409);
    // Medusa tự thay thông điệp CONFLICT bằng câu chung → giá trị không lọt, mã `invalid_state_error` giữ nguyên.
    expect(q.body.code).toBe("invalid_state_error");
    expect(JSON.stringify(q.body)).not.toContain("k1");
  });

  it("giá trị rỗng / Unicode / xuống dòng vẫn được che", () => {
    for (const v of ["", "dòng một\nat x.ts:1", "ảnh 🙂", "a: b"]) {
      const p = toHttpProblem(
        new MedusaError(T.INVALID_DATA, `Variant (${v}) with provided options already exists.`),
        "t",
      );
      expect(p.body.detail).toBe("Tổ hợp tuỳ chọn của biến thể đã tồn tại (trường: options)");
    }
  });

  it("thông điệp của chính dự án và thông điệp Medusa không nội suy giá trị: giữ nguyên", () => {
    for (const m of [
      "Biến thể đã tồn tại",
      "Mã khuyến mãi không tồn tại",
      "Email đã có tài khoản",
      "Variant with provided options already exists.",
      "Variant (x) with provided options exist.",
      "Key already exists in app metadata",
      "Product has no options",
      "Line item with id: li_01 was not found",
      "Variant (",
      "Hoàn tiền với khoá idempotency k đã tồn tại",
      "Cannot transfer",
    ]) {
      expect(echoedValueMessage(m)).toBeNull();
      expect(toHttpProblem(new MedusaError(T.INVALID_DATA, m), "t").body.detail).toBe(m);
    }
    expect(echoedValueMessage(undefined)).toBeNull();
    expect(echoedValueMessage(42)).toBeNull();
    expect(echoedValueMessage("")).toBeNull();
  });

  it("lỗi Postgres vẫn dùng thông điệp chung (không đi nhánh dạng nghiệp vụ)", () => {
    const pg = Object.assign(new Error("Variant (x) with provided options already exists."), {
      code: "23505",
      severity: "ERROR",
      table: "product_variant",
    });
    expect(JSON.stringify(toHttpProblem(pg, "t").body)).not.toContain("Variant (x)");
  });

  it("head và tail không chồng lấn: thiếu chỗ cho giá trị thì không khớp", () => {
    expect(echoedValueMessage("Key already exists in app metadata")).toBeNull();
    expect(echoedValueMessage("Key  already exists in app metadata")).not.toBeNull();
  });

  const N = 32_768;
  const adversarial: Array<[string, string]> = [
    ["head lặp", `Variant (${"Variant (".repeat(N / 9)}`],
    ["mid lặp, không đuôi", `Product "${'" has duplicate option assignments: ['.repeat(N / 36)}`],
    ["mid lặp, có đuôi", `Product "${'" has variants with missing options: ['.repeat(N / 36)}]`],
    ["toàn khoảng trắng", `Key ${" ".repeat(N)}already exists in app metadata`],
    ["Option value lặp", `Option value ${" does not exist for option ".repeat(N / 27)}`],
    ["promo đuôi lệch", `Promotion code "${'" not foun'.repeat(N / 9)}`],
    ["chuỗi 1 MB", `A refund with idempotency key ${"x".repeat(1_000_000)}`],
    ["1 MB thiếu mid", `Option value ${"a".repeat(1_000_000)}`],
  ];
  it.each(adversarial)("đối nghịch %s → < 50 ms CPU", (_n, input) => {
    echoedValueMessage(input.slice(0, 100));
    const t0 = process.cpuUsage();
    echoedValueMessage(input);
    toHttpProblem(new MedusaError(T.INVALID_DATA, input), "t");
    const d = process.cpuUsage(t0);
    expect((d.user + d.system) / 1000).toBeLessThan(50);
  });

  it("thông điệp quá dài khớp head+tail vẫn được che (đóng an toàn)", () => {
    const long = `Variant "${"x".repeat(10_000)}" has same combination of option values as "y".`;
    expect(echoedValueMessage(long)?.reason).toBe("Tổ hợp tuỳ chọn của biến thể đã tồn tại");
  });
});
