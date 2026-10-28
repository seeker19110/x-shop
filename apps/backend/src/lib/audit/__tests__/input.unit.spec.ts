import { EventEmitter } from "node:events";
import { MedusaError } from "@medusajs/framework/utils";
import { z } from "zod";
import {
  classifyInputError,
  INVALID_PATH_LABEL,
  inputAuditTrail,
  inputResourceOf,
  MEDUSA_VALIDATOR_PREFIX,
  withInputAudit,
} from "../input";

describe("classifyInputError (T-175)", () => {
  it("lỗi validator native của Medusa (zodValidator → MedusaError invalid_data 'Invalid request: …') → validation", () => {
    const err = new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `${MEDUSA_VALIDATOR_PREFIX}Unrecognized fields: 'x'`,
    );
    expect(classifyInputError(err)).toEqual({ kind: "validation", cause: "medusa_schema" });
  });

  it("MedusaError invalid_data của nghiệp vụ (không tiền tố validator) → không phải lỗi đầu vào", () => {
    const err = new MedusaError(MedusaError.Types.INVALID_DATA, "Cannot transfer order");
    expect(classifyInputError(err)).toBeNull();
    expect(
      classifyInputError(new MedusaError(MedusaError.Types.NOT_FOUND, MEDUSA_VALIDATOR_PREFIX)),
    ).toBeNull();
  });

  it("ZodError thô → validation; URIError → deserialize (path_decode)", () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(parsed.success).toBe(false);
    expect(classifyInputError(parsed.error)).toEqual({ kind: "validation", cause: "zod" });
    expect(classifyInputError(new URIError("URI malformed"))).toEqual({
      kind: "deserialize",
      cause: "path_decode",
    });
  });

  it("lỗi body-parser: JSON hỏng/charset/encoding → deserialize; quá lớn (413) và lỗi khác → null", () => {
    const httpErr = (type: string, status: number) =>
      Object.assign(new Error("x"), { type, status, expose: true });
    expect(classifyInputError(httpErr("entity.parse.failed", 400))).toEqual({
      kind: "deserialize",
      cause: "body_parse",
    });
    expect(classifyInputError(httpErr("charset.unsupported", 415))?.cause).toBe("body_charset");
    expect(classifyInputError(httpErr("encoding.unsupported", 415))?.cause).toBe("body_encoding");
    expect(classifyInputError(httpErr("entity.too.large", 413))).toBeNull();
    // `type` trùng tên nhưng không phải http-errors (thiếu `expose`) → không tin.
    expect(classifyInputError({ type: "entity.parse.failed" })).toBeNull();
    // Khoá kế thừa từ prototype không được coi là loại hợp lệ.
    expect(classifyInputError({ type: "toString", expose: true })).toBeNull();
  });

  it("ca biên: null/undefined/chuỗi/số/lỗi thường → null", () => {
    for (const v of [null, undefined, "lỗi", 0, new Error("boom")]) expect(classifyInputError(v)).toBeNull();
  });
});

describe("inputResourceOf", () => {
  const req = (over: Record<string, unknown>) => over as never;

  it("mẫu route Express đã khớp → `<METHOD> <mẫu>` (không id cụ thể)", () => {
    expect(
      inputResourceOf(
        req({ method: "post", route: { path: "/admin/stores/:id" }, originalUrl: "/admin/stores/s_1" }),
        null,
      ),
    ).toBe("POST /admin/stores/:id");
  });

  it("không có mẫu → pathname đã che email/SĐT, cắt ≤ 200; giải mã hỏng → nhãn cố định", () => {
    const r = inputResourceOf(req({ method: "GET", originalUrl: "/store/x/a@b.vn/0912345678?q=1" }), null);
    expect(r).not.toContain("a@b.vn");
    expect(r).not.toContain("0912345678");
    expect(r.startsWith("GET /store/x/")).toBe(true);
    expect(
      inputResourceOf(req({ method: "GET", originalUrl: `/${"a".repeat(500)}` }), null).length,
    ).toBeLessThan(220);
    expect(
      inputResourceOf(req({ method: "POST", originalUrl: "/auth/%E0%A4%A/x" }), {
        kind: "deserialize",
        cause: "path_decode",
      }),
    ).toBe(`POST ${INVALID_PATH_LABEL}`);
  });

  it("mẫu route có ký tự lạ (không phải mẫu Express hợp lệ) → bỏ, dùng pathname", () => {
    expect(inputResourceOf(req({ method: "GET", route: { path: /regex/ }, originalUrl: "/x" }), null)).toBe(
      "GET /x",
    );
  });
});

/** res tối giản: EventEmitter + status/json/send như Express. */
function fakeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    json: (b: unknown) => unknown;
    send: (b: unknown) => unknown;
  };
  res.statusCode = 200;
  res.json = (b: unknown) => res.send(JSON.stringify(b));
  res.send = () => {
    res.emit("finish");
    return res;
  };
  return res;
}

describe("inputAuditTrail / withInputAudit không làm hỏng request (ghi audit lỗi → chỉ log)", () => {
  const brokenScope = (onError: (m: string) => void) => ({
    resolve: (key: string) => {
      if (key === "logger") return { error: onError, warn: () => undefined, info: () => undefined };
      throw new Error("container hỏng");
    },
  });

  it("phản hồi 422 VALIDATION nhưng audit không ghi được → next() một lần, phản hồi gửi bình thường, lỗi vào log", async () => {
    const errors: string[] = [];
    const req = {
      method: "POST",
      originalUrl: "/admin/x/a",
      headers: {},
      scope: brokenScope((m) => errors.push(m)),
    };
    const res = fakeRes();
    const next = jest.fn();
    inputAuditTrail(req as never, res as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    res.statusCode = 422;
    expect(() =>
      res.send(JSON.stringify({ code: "VALIDATION", errors: [{ param: "a", reason: "x" }] })),
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(errors.some((m) => m.startsWith("[audit] Không ghi được audit đầu vào"))).toBe(true);
    // Không chép thân/giá trị vào log lỗi.
    expect(errors.join("\n")).not.toContain("reason");
  });

  it("phản hồi thành công / lỗi nghiệp vụ khác → không ghi (không chạm container)", async () => {
    const resolve = jest.fn(() => {
      throw new Error("không được gọi");
    });
    for (const [status, body] of [
      [200, { ok: true }],
      [409, { code: "CONFLICT" }],
      [400, { code: "INVALID_DATA" }],
      [422, "không phải JSON"],
    ] as const) {
      const res = fakeRes();
      inputAuditTrail(
        { method: "POST", originalUrl: "/x", headers: {}, scope: { resolve } } as never,
        res as never,
        () => undefined,
      );
      res.statusCode = status;
      res.send(typeof body === "string" ? body : JSON.stringify(body));
    }
    await new Promise((r) => setImmediate(r));
    expect(resolve).not.toHaveBeenCalled();
  });

  it("withInputAudit: lỗi khi phân loại (getter ném) vẫn giao nguyên cho handler gốc", () => {
    const handler = jest.fn();
    const err = {
      get name(): string {
        throw new Error("getter ném");
      },
    };
    const req = { method: "GET", originalUrl: "/x", headers: {}, scope: { resolve: () => undefined } };
    const res = fakeRes();
    const next = jest.fn();
    withInputAudit(handler)(err, req as never, res as never, next);
    expect(handler).toHaveBeenCalledWith(err, req, res, next);
  });
});
