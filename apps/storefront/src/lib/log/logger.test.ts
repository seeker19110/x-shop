// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { schemaErrors as validateSchema } from "../../../../../scripts/log-schema-validate.cjs";
import { onRequestError } from "../../instrumentation";
import { createLogger, escapeLine, exceptionFields, newTraceId, traceIdFromHeaders } from "./logger";
import { MAX_ARRAY, REDACTED, isSensitiveKey, redactLog, redactText } from "./redact";
import { logRequestError, pathOnly, safePath } from "./request-error";

/**
 * T-190 (BASE-ERR-005/006): dòng log JSON của storefront server theo `docs/ops/log-schema.json` (dùng chung với backend),
 * che PII bằng bộ mẫu chung `scripts/fixtures/pii-samples.json` (D-065), chỉ phía server.
 */

// Validator dùng chung với backend: scripts/log-schema-validate.cjs (danh sách trắng từ khoá, lạ → ném).
type Schema = Record<string, unknown>;
const logSchema = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../docs/ops/log-schema.json"), "utf8"),
) as Schema;
const schemaErrors = (line: unknown): string[] => validateSchema(logSchema, line);

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const raw: string[] = [];
  const logger = createLogger({
    service: "x-shop-storefront",
    version: "1.2.3",
    env: "test",
    now: () => new Date("2026-10-30T01:02:03.004Z"),
    write: (l) => raw.push(l),
    ...opts,
  });
  return { logger, raw, records: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("logger: dòng log theo schema chung", () => {
  it("validator bắt dòng sai (kiểm chứng chính validator)", () => {
    const good = {
      timestamp: "2026-10-30T01:02:03.004Z",
      level: "warn",
      severity_number: 13,
      message: "m",
      service: "s",
      version: "1",
      env: "e",
    };
    expect(schemaErrors(good)).toEqual([]);
    expect(schemaErrors({ ...good, severity_number: 9 })).not.toEqual([]);
    expect(schemaErrors({ ...good, timestamp: "2026-10-30T01:02:03Z" })).not.toEqual([]);
    expect(schemaErrors({ ...good, timestamp: "2026-10-30T01:02:03.004+07:00" })).not.toEqual([]);
    expect(schemaErrors({ ...good, level: "FATAL" })).not.toEqual([]);
    const { env: _env, ...noEnv } = good;
    expect(schemaErrors(noEnv)).not.toEqual([]);
  });

  it.each([
    ["debug", 5],
    ["info", 9],
    ["warn", 13],
    ["error", 17],
    ["fatal", 21],
  ] as const)("mức %s → severity_number %i, hợp schema", (level, n) => {
    const { logger, records } = capture({ level: "debug" });
    logger.emit(level, "xin chào", { order_total: 0 });
    const [r] = records();
    expect(r).toMatchObject({
      level,
      severity_number: n,
      message: "xin chào",
      service: "x-shop-storefront",
      version: "1.2.3",
      env: "test",
      timestamp: "2026-10-30T01:02:03.004Z",
      order_total: 0,
    });
    expect(schemaErrors(r)).toEqual([]);
    expect(String(r?.trace_id)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("lỗi: exception.* theo OTel + cause, hợp schema", () => {
    const { logger, records } = capture();
    logger.error("hỏng", new Error("ngoài", { cause: new TypeError("trong") }));
    const [r] = records();
    expect(r).toMatchObject({ level: "error", "exception.type": "Error", "exception.message": "ngoài" });
    expect(String(r?.["exception.stacktrace"])).toContain("Caused by: TypeError: trong");
    expect(schemaErrors(r)).toEqual([]);
  });

  it("lý do không phải Error (null/0/chuỗi/vòng) không ném", () => {
    expect(exceptionFields(null)).toMatchObject({ "exception.type": "null", "exception.message": "null" });
    expect(exceptionFields(0)).toMatchObject({ "exception.type": "number", "exception.message": "0" });
    expect(exceptionFields("x")).toMatchObject({ "exception.type": "string", "exception.message": "x" });
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => exceptionFields(o)).not.toThrow();
  });

  it("cause vòng tham chiếu không lặp vô hạn", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => exceptionFields(a)).not.toThrow();
    expect(exceptionFields(a)["exception.stacktrace"]).toContain("[Circular]");
  });

  it("lọc theo mức; mặc định info", () => {
    const { logger, raw } = capture();
    logger.debug("bỏ");
    logger.info("giữ");
    expect(raw).toHaveLength(1);
    const dbg = capture({ level: "error" });
    dbg.logger.warn("bỏ");
    dbg.logger.error("giữ");
    expect(dbg.raw).toHaveLength(1);
  });

  it("trường dành riêng không bị ghi đè; trace_id hợp lệ được giữ, không hợp lệ bị thay", () => {
    const { logger, records } = capture();
    logger.info("a", { level: "debug", service: "kẻ-giả", severity_number: 1, trace_id: "req-1.a:b" });
    logger.info("b", { trace_id: 'x"\n{"level":"fatal"}' });
    const [a, b] = records();
    expect(a).toMatchObject({
      level: "info",
      service: "x-shop-storefront",
      severity_number: 9,
      trace_id: "req-1.a:b",
    });
    expect(String(b?.trace_id)).toMatch(/^[0-9a-f]{32}$/);
  });

  it("CR/LF, U+2028 và ký tự bidi không phá dòng (chống log injection)", () => {
    const { logger, raw } = capture();
    logger.info('a\r\n{"level":"fatal"}\u2028\u202e', { note: "x\ny" });
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toMatch(new RegExp("[\\r\\n\\u2028\\u2029\\u202e]"));
    expect(escapeLine("\u0085")).toBe("\\u0085");
  });

  it("write ném lỗi → logger không ném", () => {
    const { logger } = capture({
      write: () => {
        throw new Error("đĩa đầy");
      },
    });
    expect(() => logger.error("x", new Error("y"))).not.toThrow();
  });
});

describe("validator schema dùng chung", () => {
  const throwsFor = (schema: Record<string, unknown>) => () => validateSchema(schema, { a: {} });
  it.each(["maxLength", "format", "unevaluatedProperties", "minimum", "items", "oneOf", "$ref"])(
    "từ khoá chưa hỗ trợ %s → ném (không bỏ qua lặng lẽ)",
    (k) => {
      expect(throwsFor({ [k]: 1 })).toThrow(/chưa hỗ trợ/);
      expect(throwsFor({ properties: { a: { [k]: 1 } } })).toThrow(/chưa hỗ trợ/);
    },
  );
  it.each(["integer", "number", "array", "boolean", "null"])("type %s → ném", (t) => {
    expect(throwsFor({ type: t })).toThrow(/type chưa hỗ trợ/);
  });
  it("additionalProperties không phải boolean → ném; false được kiểm", () => {
    expect(throwsFor({ additionalProperties: { type: "string" } })).toThrow();
    expect(validateSchema({ properties: { a: {} }, additionalProperties: false }, { a: 1, b: 2 })).toEqual([
      "$: trường thừa b",
    ]);
  });
  it("schema thật của log chỉ dùng từ khoá được hỗ trợ (không ném)", () => {
    expect(() => schemaErrors({})).not.toThrow();
  });
});

describe("logger: trace_id từ header", () => {
  const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  it("x-request-id hợp lệ thắng traceparent", () => {
    expect(traceIdFromHeaders({ "x-request-id": "abc-123", traceparent: TP })).toBe("abc-123");
  });
  it("traceparent → trace-id 32 hex", () => {
    expect(traceIdFromHeaders(new Headers({ traceparent: TP }))).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(traceIdFromHeaders({ Traceparent: [TP] })).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
  });
  it.each([
    ["không có header", undefined],
    ["x-request-id rỗng", { "x-request-id": "" }],
    ["x-request-id có ký tự lạ", { "x-request-id": 'a"b\nc' }],
    ["x-request-id quá dài", { "x-request-id": "a".repeat(129) }],
    [
      "traceparent trace-id toàn 0",
      { traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01" },
    ],
    ["traceparent sai khuôn", { traceparent: "garbage" }],
    ["traceparent viết hoa (W3C: chỉ hex thường)", { traceparent: TP.toUpperCase() }],
    ["traceparent version ff", { traceparent: TP.replace(/^00/, "ff") }],
    [
      "traceparent parent-id toàn 0",
      { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01" },
    ],
  ])("%s → sinh mới (32 hex, mỗi lần khác)", (_n, headers) => {
    const a = traceIdFromHeaders(headers);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdFromHeaders(headers)).not.toBe(a);
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });
  it("forRequest gắn trace_id vào mọi dòng của logger con", () => {
    const { logger, records } = capture();
    const child = logger.forRequest({ "x-request-id": "rid-9" });
    child.info("một");
    child.warn("hai");
    expect(records().map((r) => r.trace_id)).toEqual(["rid-9", "rid-9"]);
  });
});

interface Sample {
  id: string;
  kind: string;
  value?: string;
  parts?: string[];
  prefix?: string;
  leak: string[];
  scopes: string[];
}
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "../../scripts/fixtures/pii-samples.json"), "utf8"),
) as { samples: Sample[]; negatives: string[] };
const text = (s: Sample) => `${s.prefix ?? ""}${s.value ?? (s.parts ?? []).join("")}`;
const samples = fixture.samples.filter((s) => s.scopes.includes("storefront"));
const leaked = (s: Sample, out: string) => {
  const esc = (x: string) => JSON.stringify(x).slice(1, -1);
  const o = out.normalize("NFKC");
  return s.leak.filter((l) => o.includes(l.normalize("NFKC")) || o.includes(esc(l.normalize("NFKC"))));
};

describe("logger: che PII bằng bộ mẫu chung (D-065)", () => {
  it("fixture có đủ loại PII", () => {
    const kinds = new Set(samples.map((s) => s.kind));
    for (const k of ["email", "phone", "address", "cccd", "cmnd"]) expect(kinds).toContain(k);
  });

  it.each(samples.map((s) => [s.id, s] as const))(
    "%s: không lọt qua message/field/khoá/mảng/lỗi",
    (_id, s) => {
      const v = text(s);
      const { logger, raw } = capture();
      logger.info(`giao tới ${v} nhé`, {
        note: v,
        nested: { a: [1, { b: v }] },
        list: [v],
        [v]: 1,
      });
      logger.error(v, new Error(`lỗi với ${v}`));
      for (const line of raw) {
        expect(leaked(s, line), line).toEqual([]);
        expect(schemaErrors(JSON.parse(line))).toEqual([]);
      }
      expect(redactText(v)).toBe(REDACTED);
    },
  );

  it.each(fixture.negatives.map((n) => [n]))("không che nhầm %j", (n) => {
    expect(redactText(n)).toBe(n);
    expect(redactLog({ note: n })).toEqual({ note: n });
  });

  it.each([
    "Authorization: Bearer abcdefgh12345678",
    "Basic dXNlcjpwYXNzd29yZA==",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
    "token=abc123",
    "password: hunter2",
    "postgres://user:pw@db.internal:5432/x",
    "vnp_SecureHash=ABCDEF",
  ])("bí mật trong chuỗi: %s", (v) => {
    expect(redactText(v)).toBe(REDACTED);
  });

  it.each([
    "password",
    "Authorization",
    "set-cookie",
    "access_token",
    "email",
    "Số điện thoại",
    "địa chỉ",
    "ip",
    "vnp_SecureHash",
  ])("khoá nhạy cảm %s → che cả giá trị (kể cả object)", (k) => {
    expect(isSensitiveKey(k)).toBe(true);
    expect(Object.values(redactLog({ [k]: { deep: "giá trị" } }) as object)).toEqual([REDACTED]);
  });

  it.each(["order_id", "shipping", "company", "status", "sku", "http.request.method"])(
    "khoá thường %s giữ nguyên",
    (k) => {
      expect(isSensitiveKey(k)).toBe(false);
    },
  );

  it("dòng `at …` của stack không bị che nhầm; dòng thông điệp chứa PII thì bị che", () => {
    const stack = "Error: lỗi\n    at so (/app/12/3/x.ts:1:2)\n    at run (/app/y.ts:3:4)";
    expect(redactText(stack, true)).toBe(stack);
    expect(redactText("Error: gọi 0912345678\n    at run (/a.ts:1:1)", true)).toBe(
      `${REDACTED}\n    at run (/a.ts:1:1)`,
    );
    expect(redactText("Error: x\n    at f (a@example.test:1:1)", true)).toContain(REDACTED);
  });

  it("BigInt → chuỗi, Date → ISO (không mất dòng log); Date sai → Invalid Date", () => {
    const { logger, records } = capture();
    logger.info("x", {
      big: 12345678901234567890n,
      at: new Date("2026-10-30T00:00:00.000Z"),
      bad: new Date(NaN),
    });
    expect(records()[0]).toMatchObject({
      big: "12345678901234567890",
      at: "2026-10-30T00:00:00.000Z",
      bad: "Invalid Date",
    });
  });

  it("mảng dài bị cắt ở MAX_ARRAY, phần dư ghi …+N; đúng trần thì giữ nguyên", () => {
    const out = redactLog({ a: Array.from({ length: MAX_ARRAY + 5 }, (_, i) => i) }) as { a: unknown[] };
    expect(out.a).toHaveLength(MAX_ARRAY + 1);
    expect(out.a.at(-1)).toBe("…+5");
    expect((redactLog(Array.from({ length: MAX_ARRAY }, () => 0)) as unknown[]).length).toBe(MAX_ARRAY);
    expect(redactLog([])).toEqual([]);
  });

  it("dòng `at` có /@scope/ không bị che nhầm; email thật trong dòng `at` vẫn bị che", () => {
    const stack = "Error: x\n    at f (/app/node_modules/@scope/pkg/dist/x.js:1:2)\n    at g (/app/y.ts:3:4)";
    expect(redactText(stack, true)).toBe(stack);
    expect(redactText("Error: x\n    at f (khach.hang@example.test:1:1)", true)).toContain(REDACTED);
  });

  it("vòng tham chiếu, quá sâu, null/0/rỗng", () => {
    const o: Record<string, unknown> = { n: null, z: 0, e: "" };
    o.self = o;
    expect(redactLog(o)).toEqual({ n: null, z: 0, e: "", self: "[Circular]" });
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(redactLog(deep))).toContain("[Truncated]");
    expect(redactText("")).toBe("");
  });

  it("không đổi đầu vào", () => {
    const input = { email: "khach.hang+1@example.test", list: ["a"] };
    const copy = structuredClone(input);
    redactLog(input);
    expect(input).toEqual(copy);
  });

  it("chuỗi rất dài, nhiều '@' / số: chạy nhanh (không ReDoS)", () => {
    for (const s of [
      "@".repeat(200_000),
      "0".repeat(200_000),
      "a ".repeat(100_000),
      "Bearer " + " ".repeat(100_000),
    ]) {
      const t0 = process.cpuUsage();
      redactText(s);
      const d = process.cpuUsage(t0);
      expect((d.user + d.system) / 1000).toBeLessThan(1_500);
    }
  });
});

describe("logRequestError / onRequestError (instrumentation)", () => {
  it("pathOnly bỏ query và fragment", () => {
    expect(pathOnly("/don-hang/XS-1?email=a@example.test&token=x#frag")).toBe("/don-hang/XS-1");
    expect(pathOnly("/a")).toBe("/a");
    expect(pathOnly("")).toBe("");
  });

  it("safePath: %40 không giấu email; %XX sai không ném; đường dẫn thường giữ nguyên", () => {
    expect(safePath("/don-hang/khach.hang%40example.test")).toBe(REDACTED);
    expect(safePath("/don-hang/khach.hang%2540example.test")).toBe("/don-hang/khach.hang%2540example.test");
    expect(safePath("/a/%E0%A4%A?x=1")).toBe("/a/%E0%A4%A");
    expect(safePath("/san-pham/ao-so-mi?email=a@example.test")).toBe("/san-pham/ao-so-mi");
    expect(safePath("")).toBe("");
  });

  it("ghi một dòng error có trace_id, digest, đường dẫn không query; hợp schema", () => {
    const { logger, records } = capture();
    const err = Object.assign(new Error("render hỏng"), { digest: "d123" });
    logRequestError(
      err,
      { path: "/san-pham/ao?token=abc", method: "GET", headers: { "x-request-id": "rid-1" } },
      { routerKind: "App Router", routePath: "/san-pham/[handle]", routeType: "render" },
      logger,
    );
    const [r] = records();
    expect(r).toMatchObject({
      level: "error",
      trace_id: "rid-1",
      "http.request.method": "GET",
      "url.path": "/san-pham/ao",
      "next.route_path": "/san-pham/[handle]",
      "error.digest": "d123",
      "exception.message": "render hỏng",
    });
    expect(schemaErrors(r)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("token=abc");
  });

  it("request/ngữ cảnh thiếu trường, lỗi không phải Error → không ném", () => {
    const { logger, records } = capture();
    expect(() =>
      logRequestError(
        null,
        { path: undefined as unknown as string, method: "POST", headers: null },
        undefined,
        logger,
      ),
    ).not.toThrow();
    expect(records()).toHaveLength(1);
  });

  it("onRequestError ghi ra stdout bằng logger dùng chung", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await onRequestError(
        new Error("boom"),
        { path: "/x?y=1", method: "GET", headers: {} },
        { routeType: "route" },
      );
    } finally {
      spy.mockRestore();
    }
    const parsed = lines
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ level: "error", "url.path": "/x", "exception.message": "boom" });
    expect(schemaErrors(parsed[0])).toEqual([]);
  });
});

describe("logger: chỉ phía server", () => {
  it("nạp trong trình duyệt (có window + document) → ném", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    try {
      await expect(import("./logger")).rejects.toThrow(/server/);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("không file 'use client' nào import lib/log (trực tiếp)", () => {
    const src = resolve(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
          const body = readFileSync(p, "utf8");
          const client = /^\s*(?:\/\*[\s\S]{0,2000}?\*\/\s*)?["']use client["']/.test(body);
          if (client && /from\s+["'][^"']*\/lib\/log\/|from\s+["']\.\/log\//.test(body)) offenders.push(p);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
