import { EventEmitter } from "node:events";
import { MedusaError } from "@medusajs/framework/utils";
import { z } from "zod";
import { MemoryCounter } from "../../security/__tests__/memory-counter";
import { DENY_AUDIT_THROTTLE, type WindowCounter, type WindowPeek } from "../deny-throttle";
import { SECURITY_EVENTS } from "../events";
import {
  anonBucket,
  anonCapVerdict,
  anonGlobalCap,
  classifyInputError,
  INPUT_ANON_GLOBAL_CAP,
  isAnonMilestone,
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
    const r = inputResourceOf(
      req({ method: "GET", originalUrl: "/store/x/a@example.test/0912345678?q=1" }),
      null,
    );
    expect(r).not.toContain("a@example.test");
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

describe("trần chung vô danh (review T-175 vòng 2)", () => {
  it("≤ trần → ghi; đúng trần + 1 → MỘT dòng đánh dấu; vượt nữa → chỉ đếm; bộ đếm lỗi → ghi", () => {
    expect(anonCapVerdict(1)).toBe("record");
    expect(anonCapVerdict(INPUT_ANON_GLOBAL_CAP)).toBe("record");
    expect(anonCapVerdict(INPUT_ANON_GLOBAL_CAP + 1)).toBe("reached");
    expect(anonCapVerdict(INPUT_ANON_GLOBAL_CAP + 2)).toBe("skip");
    expect(anonCapVerdict(10_000)).toBe("skip");
    expect(anonCapVerdict(null)).toBe("record");
  });

  /** Bộ đếm dùng chung của test bảo mật (cùng ngữ nghĩa `rate_limit_counter`), lấy `.current` như `counterOf`/`peekCounterOf`. */
  function memoryCounter() {
    const m = new MemoryCounter();
    const counter: WindowCounter = async (bucket, windowMs, now) =>
      (await m.hit(bucket, windowMs, now)).current;
    const peek: WindowPeek = async (bucket, windowMs, now) => (await m.peek(bucket, windowMs, now)).current;
    return { counter, peek };
  }
  const EVENT = SECURITY_EVENTS.INPUT_DESERIALIZE_FAILED;
  const W = DENY_AUDIT_THROTTLE.windowMs;
  // Ca biên thời gian: mọi request rơi vào ms CUỐI của cửa sổ (đọc lại phải dùng cùng `now` → cùng cửa sổ).
  const EDGE = new Date(Date.UTC(2026, 9, 30, 4, 0, 0) + W - 1);

  it("ĐỒNG THỜI (xen kẽ): request đếm thô 50 nhận dòng thứ trần + 1 sau request đếm thô 51 → occurrence = số thô lúc chạm trần (51), không phải 50", async () => {
    const { counter, peek } = memoryCounter();
    const raw = anonBucket(EVENT, "raw");
    const noop = () => undefined;
    // 49 request tuần tự: thô 1..49, dòng 1..49 — đều ghi thường.
    for (let i = 1; i < INPUT_ANON_GLOBAL_CAP; i++) {
      const r = await counter(raw, W, EDGE);
      expect(await anonGlobalCap(counter, peek, EVENT, EDGE, r, noop)).toBe("record");
    }
    // A đếm thô (50), rồi bị chậm; B đếm thô (51) và đếm dòng TRƯỚC A.
    const rawA = await counter(raw, W, EDGE);
    const rawB = await counter(raw, W, EDGE);
    expect([rawA, rawB]).toEqual([INPUT_ANON_GLOBAL_CAP, INPUT_ANON_GLOBAL_CAP + 1]);
    expect(await anonGlobalCap(counter, peek, EVENT, EDGE, rawB, noop)).toBe("record");
    // A nhận dòng thứ trần + 1 → dòng đánh dấu; số thô của cửa sổ lúc đó là 51 (bản cũ ghi 50 = số chụp sớm của A).
    expect(await anonGlobalCap(counter, peek, EVENT, EDGE, rawA, noop)).toEqual({
      mark: "reached",
      occurrence: INPUT_ANON_GLOBAL_CAP + 1,
    });
    // Vượt nữa → chỉ đếm; vẫn đúng MỘT dòng đánh dấu bất kể thứ tự.
    const rawC = await counter(raw, W, EDGE);
    expect(await anonGlobalCap(counter, peek, EVENT, EDGE, rawC, noop)).toBe("skip");
  });

  it("ĐỒNG THỜI (thứ tự tất định): 65 request chụp thô trước, đếm dòng theo thứ tự NGƯỢC → đúng trần dòng thường + MỘT dòng đánh dấu, occurrence = số thô cửa sổ", async () => {
    const { counter, peek } = memoryCounter();
    const raw = anonBucket(EVENT, "raw");
    const n = INPUT_ANON_GLOBAL_CAP + 15;
    // Mọi request đếm thô trước (chụp sớm), sau đó đếm dòng theo thứ tự NGƯỢC — xấu nhất cho số chụp sớm.
    const snaps: number[] = [];
    for (let i = 0; i < n; i++) snaps.push(await counter(raw, W, EDGE));
    const outcomes = await Promise.all(
      [...snaps].reverse().map((r) => anonGlobalCap(counter, peek, EVENT, EDGE, r, () => undefined)),
    );
    expect(outcomes.filter((o) => o === "record")).toHaveLength(INPUT_ANON_GLOBAL_CAP);
    const marks = outcomes.filter((o) => typeof o === "object");
    expect(marks).toEqual([{ mark: "reached", occurrence: n }]);
    expect(outcomes.filter((o) => o === "skip")).toHaveLength(n - INPUT_ANON_GLOBAL_CAP - 1);
  });

  it("biên cửa sổ: đọc lại thô dùng cùng `now` — không lẫn số của cửa sổ kế tiếp; đọc lỗi → số chụp sớm; cả hai không có → null", async () => {
    const { counter, peek } = memoryCounter();
    const raw = anonBucket(EVENT, "raw");
    const rows = anonBucket(EVENT, "rows");
    const next = new Date(EDGE.getTime() + 1); // ms đầu của cửa sổ kế tiếp
    for (let i = 0; i < 999; i++) await counter(raw, W, next);
    for (let i = 0; i < INPUT_ANON_GLOBAL_CAP; i++) await counter(rows, W, EDGE);
    const r = await counter(raw, W, EDGE); // thô của cửa sổ EDGE = 1
    expect(await anonGlobalCap(counter, peek, EVENT, EDGE, r, () => undefined)).toEqual({
      mark: "reached",
      occurrence: 1,
    });

    let errors = 0;
    const broken: WindowPeek = async () => {
      throw new Error("db");
    };
    const fresh = memoryCounter();
    for (let i = 0; i < INPUT_ANON_GLOBAL_CAP; i++) await fresh.counter(rows, W, EDGE);
    expect(await anonGlobalCap(fresh.counter, broken, EVENT, EDGE, 42, () => errors++)).toEqual({
      mark: "reached",
      occurrence: 42,
    });
    expect(errors).toBe(1);
    for (let i = 0; i < INPUT_ANON_GLOBAL_CAP; i++) await fresh.counter(anonBucket(EVENT, "rows"), W, next);
    expect(await anonGlobalCap(fresh.counter, broken, EVENT, next, null, () => errors++)).toEqual({
      mark: "reached",
      occurrence: null,
    });
  });

  it("đếm thô của request lỗi (rawAtHit = null) + bucket thô rỗng/thấp (< trần + 1) → occurrence null, không 0/số thấp; bucket thô ≥ trần + 1 → dùng số đọc lại", async () => {
    const raw = anonBucket(EVENT, "raw");
    const rows = anonBucket(EVENT, "rows");
    const noop = () => undefined;
    for (const rawCount of [0, 10, INPUT_ANON_GLOBAL_CAP]) {
      const { counter, peek } = memoryCounter();
      for (let i = 0; i < rawCount; i++) await counter(raw, W, EDGE);
      for (let i = 0; i < INPUT_ANON_GLOBAL_CAP; i++) await counter(rows, W, EDGE);
      expect(await anonGlobalCap(counter, peek, EVENT, EDGE, null, noop)).toEqual({
        mark: "reached",
        occurrence: null,
      });
    }
    const { counter, peek } = memoryCounter();
    for (let i = 0; i < INPUT_ANON_GLOBAL_CAP + 7; i++) await counter(raw, W, EDGE);
    for (let i = 0; i < INPUT_ANON_GLOBAL_CAP; i++) await counter(rows, W, EDGE);
    expect(await anonGlobalCap(counter, peek, EVENT, EDGE, null, noop)).toEqual({
      mark: "reached",
      occurrence: INPUT_ANON_GLOBAL_CAP + 7,
    });
  });

  it("mốc theo số request THÔ: 1000, 10000… (dưới 1000 không phải mốc — trần + dòng đánh dấu đã phủ)", () => {
    for (const n of [1000, 10_000, 100_000]) expect(isAnonMilestone(n)).toBe(true);
    for (const n of [null, 1, 10, 100, 999, 1001, 2000, 5000]) expect(isAnonMilestone(n)).toBe(false);
  });
});
