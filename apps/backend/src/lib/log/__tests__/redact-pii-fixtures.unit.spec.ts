import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { createLogger, exceptionFields } from "../logger";
import { isSensitiveKey, REDACTED, redactLog, redactText } from "../redact";

/**
 * T-136 (D-065, D-066): bộ mẫu PII dùng chung `scripts/fixtures/pii-samples.json` — mọi mẫu `scopes ∋ backend` đi qua mọi
 * đường ra của log (thông điệp, object lồng, mảng, Error + cause, util.inspect, JSON, dòng log thật của AppLogger) không
 * được lọt. Bản storefront (`analytics-pii-fixtures.test.ts`) khoá cùng file với phần PII của nó (CMP-PRIV-008, SEC-SECRET-007).
 */
interface Sample {
  id: string;
  kind: string;
  value?: string;
  parts?: string[];
  prefix?: string;
  leak: string[];
  scopes: string[];
}
interface Fixture {
  samples: Sample[];
  negatives: string[];
  negativesBackendOnly: string[];
}
const fixture = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../scripts/fixtures/pii-samples.json"), "utf8"),
) as Fixture;
const text = (s: Sample) => `${s.prefix ?? ""}${s.value ?? (s.parts ?? []).join("")}`;
const samples = fixture.samples.filter((s) => s.scopes.includes("backend"));

/** Lỗi nếu bất kỳ đoạn `leak` nào còn trong `out` (thô hoặc dạng đã thoát JSON). */
function leaked(s: Sample, out: string): string[] {
  const escaped = (x: string) => JSON.stringify(x).slice(1, -1);
  const o = out.normalize("NFC");
  return s.leak.filter((l) => {
    const n = l.normalize("NFC");
    return o.includes(n) || o.includes(escaped(n));
  });
}

function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    service: "svc",
    version: "1",
    env: "test",
    write: (l) => lines.push(l),
    exit: () => undefined,
  });
  return { logger, lines };
}

describe("bộ mẫu PII dùng chung: không lọt qua bất kỳ đường ra nào của log", () => {
  it("fixture đủ loại và đủ lớn", () => {
    const kinds = new Set(fixture.samples.map((s) => s.kind));
    for (const k of ["email", "phone", "address", "name", "cccd", "cmnd", "card", "token", "password", "ip"])
      expect(kinds).toContain(k);
    expect(samples.length).toBeGreaterThanOrEqual(40);
    for (const s of fixture.samples) expect(s.leak.length).toBeGreaterThan(0);
  });

  const contexts: [string, (s: Sample) => string][] = [
    ["redactText: thuần", (s) => redactText(text(s))],
    ["redactText: trong thông điệp", (s) => redactText(`Xử lý đơn thất bại: ${text(s)} (mã lỗi 500)`)],
    [
      "redactText: xuống dòng + stack",
      (s) => redactText(`Error: lỗi\n    at f (x.ts:1:1)\n${text(s)}\n    at g (y.ts:2:2)`),
    ],
    ["object lồng, khoá trung tính", (s) => JSON.stringify(redactLog({ a: { b: { note: text(s) } } }))],
    ["mảng (lồng mảng)", (s) => JSON.stringify(redactLog([text(s), [text(s), { x: [text(s)] }]]))],
    ["Error.message", (s) => JSON.stringify(redactLog(new Error(`hỏng: ${text(s)}`)))],
    ["Error trong object", (s) => JSON.stringify(redactLog({ err: new TypeError(text(s)), n: 1 }))],
    [
      "Error.cause (redactLog)",
      (s) => JSON.stringify(redactLog(new Error("ngoài", { cause: new Error(`gốc: ${text(s)}`) }))),
    ],
    [
      "Error.cause (exceptionFields, chuỗi 3 cấp)",
      (s) =>
        JSON.stringify(
          redactLog(
            exceptionFields(new Error("a", { cause: new Error("b", { cause: new Error(`c ${text(s)}`) }) })),
          ),
        ),
    ],
    [
      "AggregateError",
      (s) =>
        JSON.stringify(redactLog(exceptionFields(new AggregateError([new Error(text(s))], "nhiều lỗi")))),
    ],
    [
      "cause không phải Error",
      (s) => JSON.stringify(redactLog(exceptionFields(new Error("x", { cause: text(s) })))),
    ],
    [
      "util.inspect object",
      (s) => redactText(inspect({ note: text(s), nested: { list: [text(s)] } }, { depth: 6 })),
    ],
    ["util.inspect Error + cause", (s) => redactText(inspect(new Error("x", { cause: new Error(text(s)) })))],
    ["JSON.stringify rồi che chuỗi", (s) => redactText(JSON.stringify({ note: text(s), list: [text(s)] }))],
    [
      "JSON hai lớp (chuỗi trong chuỗi)",
      (s) => redactText(JSON.stringify({ body: JSON.stringify({ note: text(s) }) })),
    ],
    [
      "AppLogger.info → dòng log",
      (s) => {
        const { logger, lines } = capture();
        logger.info(`sự kiện: ${text(s)}`);
        return lines.join("\n");
      },
    ],
    [
      "AppLogger.emit fields lồng + mảng",
      (s) => {
        const { logger, lines } = capture();
        logger.emit("info", "x", { ctx: { items: [{ note: text(s) }], raw: text(s) } });
        return lines.join("\n");
      },
    ],
    [
      "AppLogger.error + cause",
      (s) => {
        const { logger, lines } = capture();
        logger.error("thất bại", new Error("ngoài", { cause: new Error(`gốc ${text(s)}`) }));
        return lines.join("\n");
      },
    ],
  ];

  describe.each(contexts)("%s", (_ctx, run) => {
    it.each(samples.map((s) => [s.id, s] as const))("%s", (_id, s) => {
      expect(leaked(s, run(s))).toEqual([]);
    });
  });

  it.each([...fixture.negatives, ...fixture.negativesBackendOnly].map((n) => [n]))(
    "không che nhầm %j (thuần và trong object)",
    (n) => {
      expect(redactText(n)).toBe(n);
      expect(redactLog({ note: n })).toEqual({ note: n });
    },
  );
});

describe("CMND 9 số: che khi có từ khoá, không che số tiền (D-066)", () => {
  it.each([
    ["CMND 012345678", "CMND [CMND]"],
    ["CMT: 123456789", "CMT: [CMND]"],
    ["Số CMND: 012 345 678", "Số CMND: [REDACTED]"], // khoá `cmnd:` đã che theo luật khoá=giá trị
    ["chứng minh nhân dân số 271234567", "chứng minh nhân dân số [CMND]"],
    ["chung minh thu 271234567", "chung minh thu [CMND]"],
    ["cmnd=271234567&x=1", "cmnd=[REDACTED]&x=1"],
    ["khách CMND 271-234-567 giao hàng", "khách CMND [CMND] giao hàng"],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each([
    "tổng tiền 123456789 đ",
    "amount=271234567 currency=VND",
    "số tiền 123456789",
    "CMND không hợp lệ",
    "cmnd 12345", // quá ngắn: không phải 9 số
    "CMND 1234567890123", // dài hơn 9 số: không phải CMND
    "order 123456789",
  ])("không che nhầm %j", (input) => {
    expect(redactText(input)).toBe(input);
  });
});

describe("chuẩn hoá NFC (D-112)", () => {
  it("dạng tách dấu cho kết quả như dạng NFC", () => {
    for (const v of [
      "Phường Dịch Vọng, Quận Cầu Giấy, Hà Nội",
      "mật khẩu: abc123",
      "họ tên: Lê Văn Ân",
      "CMND số 271234567",
    ]) {
      expect(redactText(v.normalize("NFD"))).toBe(redactText(v.normalize("NFC")));
      expect(redactText(v.normalize("NFD"))).not.toBe(v.normalize("NFC"));
    }
  });
  it("chuỗi rỗng và chuỗi không dấu không đổi", () => {
    expect(redactText("")).toBe("");
    expect(redactText("order XS-ABC123")).toBe("order XS-ABC123");
  });
});

describe("luật T-136: khoá tiếng Việt có dấu, JSON thoát nháy, IP theo khoá", () => {
  it.each([
    "mật khẩu",
    "mat_khau",
    "Họ tên",
    "họ_tên",
    "Địa chỉ",
    "số điện thoại",
    "ip",
    "client_ip",
    "remoteAddr",
    "X-Forwarded-For",
  ])("khoá %j là nhạy cảm", (k) => {
    expect(isSensitiveKey(k)).toBe(true);
    expect(redactLog({ [k]: "giá trị" })).toEqual({ [k]: REDACTED });
  });

  it.each(["shipping", "description", "tip", "recipe", "tên sản phẩm", "đơn hàng"])(
    "khoá %j không bị che nhầm",
    (k) => {
      expect(isSensitiveKey(k)).toBe(false);
    },
  );

  it.each([
    ['{"password":"abc 123"}', `{"password":"${REDACTED}"}`],
    [String.raw`{\"password\":\"abc 123\",\"x\":1}`, String.raw`{\"password\":\"${REDACTED}\",\"x\":1}`],
    [String.raw`{\"email\":\"a b\"}`, String.raw`{\"email\":\"${REDACTED}\"}`],
    [String.raw`{\"ip\":\"203.0.113.9\"}`, String.raw`{\"ip\":\"[IP]\"}`],
    ["ip=203.0.113.9 failed", "ip=[IP] failed"],
    ["client_ip: 203.0.113.9:443", "client_ip: [IP]"],
    ["x-forwarded-for: 198.51.100.1, 203.0.113.2 , 192.0.2.3 end", "x-forwarded-for: [IP] end"],
    ["remote_address=::1", "remote_address=[IP]"],
  ])("%j → %j", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it.each(["ip 10.0.0.12:5432", "ip: không có", "version 1.2.3.4", "ipsum=1.2.3.4", "tip=203.0.113.9"])(
    "không che nhầm %j",
    (input) => {
      expect(redactText(input)).toBe(input);
    },
  );
});

/** Ngân sách ReDoS cho các luật mới (T-136): đo CPU time, như bộ ca ở redact.unit.spec.ts. */
describe("luật T-136: chống ReDoS (CPU < 50 ms / 32K ký tự)", () => {
  const N = 32_000;
  const cases: [string, string][] = [
    ["CMND lặp không số", "CMND ".repeat(N / 5)],
    ["CMND + khoảng trắng dài", `CMND${" ".repeat(N)}1`],
    ["CMND + số dài", `CMND ${"1".repeat(N)}`],
    ["CMND + số tách nhóm lặp", `CMND ${"1 ".repeat(N / 2)}`],
    ["chứng minh nhân dân lặp", "chứng minh nhân dân ".repeat(N / 20)],
    ["chung minh lặp", "chung minh ".repeat(N / 11)],
    ["mật khẩu lặp", "mật khẩu ".repeat(N / 9)],
    ["mật khẩu + khoảng trắng dài", `mật khẩu${" ".repeat(N)}x`],
    ["mat_khau= nháy không đóng", `mat_khau="${"a".repeat(N)}`],
    ["họ tên lặp", "họ tên: ".repeat(N / 8)],
    ["ho ten + khoảng trắng dài", `ho ten${" ".repeat(N)}x`],
    ["client_ip lặp", "client_ip=".repeat(N / 10)],
    ["x-forwarded-for dài", `x-forwarded-for: ${"1.1.1.1, ".repeat(N / 9)}`],
    ["remote_addr IPv6 dài", `remote_addr=${"a:".repeat(N / 2)}`],
    ["ip: nhiều dấu hai chấm", `ip${":".repeat(N)}`],
    ["NFD: dấu kết hợp lặp", `a${"\u0301".repeat(N)}`],
    [
      "NFD: địa chỉ tách dấu lặp",
      "Ph\u01b0\u1eddng"
        .normalize("NFD")
        .concat(" A, ")
        .repeat(N / 12),
    ],
    ['JSON thoát: password=\\" lặp', String.raw`password=\"`.repeat(N / 11)],
    ["JSON thoát: không đóng nháy", `${String.raw`password=\"`}${"a".repeat(N)}`],
    ["JSON thoát: nhiều backslash", `password=${"\\".repeat(N)}`],
    ["IP: danh sách XFF lặp", "x-forwarded-for: 1.1.1.1,".repeat(N / 25)],
    ["IP: ip= lặp số", "ip=1.1.1.".repeat(N / 9)],
  ];
  it.each(cases)("%s → < 50 ms", (_name, input) => {
    redactText(input.slice(0, 100));
    const t0 = process.cpuUsage();
    redactText(input);
    const d = process.cpuUsage(t0);
    expect((d.user + d.system) / 1000).toBeLessThan(50);
  });

  it("mỗi mẫu fixture lặp tới 32K ký tự → < 50 ms", () => {
    for (const s of fixture.samples) {
      const unit = `${text(s)} `;
      const input = unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
      redactText(input.slice(0, 100));
      const t0 = process.cpuUsage();
      redactText(input);
      const d = process.cpuUsage(t0);
      expect({ id: s.id, ms: (d.user + d.system) / 1000 < 50 }).toEqual({ id: s.id, ms: true });
    }
  });
});
