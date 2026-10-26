import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { fatalLogLine, installProcessErrorHandlers, type ProcessLike } from "../process";

const MODULE = join(__dirname, "..", "process.ts");

function fakeProc() {
  const emitter = new EventEmitter();
  const lines: string[] = [];
  const exits: number[] = [];
  const installed = installProcessErrorHandlers({
    proc: emitter as unknown as ProcessLike,
    write: (l) => lines.push(l),
    exit: (c) => exits.push(c),
    now: () => new Date("2026-10-26T01:02:03.004Z"),
  });
  return { emitter, lines, exits, installed };
}

describe("installProcessErrorHandlers (tiến trình giả)", () => {
  it("unhandledRejection → một dòng JSON có cấu trúc (khoá OTel) rồi exit(1)", () => {
    const { emitter, lines, exits, installed } = fakeProc();
    expect(installed).toBe(true);
    const err = new Error("boom");
    emitter.emit("unhandledRejection", err);
    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-10-26T01:02:03.004Z",
      level: "fatal",
      service: "x-shop-backend",
      event: "unhandledRejection",
      message: expect.any(String),
      "exception.type": "Error",
      "exception.message": "boom",
      "exception.stacktrace": err.stack,
    });
  });

  it("uncaughtException → log + exit(1)", () => {
    const { emitter, lines, exits } = fakeProc();
    emitter.emit("uncaughtException", new TypeError("x is undefined"));
    expect(exits).toEqual([1]);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: "uncaughtException",
      "exception.type": "TypeError",
    });
  });

  it("lỗi thứ hai trong lúc đang thoát → vẫn log, không gọi exit lần nữa", () => {
    const { emitter, lines, exits } = fakeProc();
    emitter.emit("unhandledRejection", new Error("a"));
    emitter.emit("uncaughtException", new Error("b"));
    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(2);
  });

  it("cài hai lần trên cùng tiến trình → lần sau không thêm listener", () => {
    const emitter = new EventEmitter();
    const opts = { proc: emitter as unknown as ProcessLike, write: () => undefined, exit: () => undefined };
    expect(installProcessErrorHandlers(opts)).toBe(true);
    expect(installProcessErrorHandlers(opts)).toBe(false);
    expect(emitter.listenerCount("unhandledRejection")).toBe(1);
    expect(emitter.listenerCount("uncaughtException")).toBe(1);
  });

  it("ghi log ném lỗi → vẫn exit(1) (không treo tiến trình hỏng)", () => {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    installProcessErrorHandlers({
      proc: emitter as unknown as ProcessLike,
      write: () => {
        throw new Error("EPIPE");
      },
      exit: (c) => exits.push(c),
    });
    expect(() => emitter.emit("unhandledRejection", new Error("x"))).toThrow("EPIPE");
    expect(exits).toEqual([1]);
  });
});

describe("fatalLogLine", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  it.each([
    ["chuỗi", "lý do", "string", "lý do"],
    ["null", null, "null", "null"],
    ["undefined", undefined, "undefined", "undefined"],
    ["object", { a: 1 }, "object", '{"a":1}'],
    ["số", 0, "number", "0"],
  ])("lý do không phải Error (%s)", (_n, reason, type, message) => {
    expect(JSON.parse(fatalLogLine("unhandledRejection", reason, now, "s"))).toMatchObject({
      "exception.type": type,
      "exception.message": message,
    });
  });

  it("object vòng tham chiếu → không ném", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => fatalLogLine("unhandledRejection", o, now, "s")).not.toThrow();
  });

  it("CR/LF trong thông điệp không phá dòng log (chống log injection)", () => {
    const line = fatalLogLine("uncaughtException", new Error('a\r\n{"level":"info"}'), now, "s");
    expect(line).not.toMatch(/[\r\n]/);
    expect(JSON.parse(line)["exception.message"]).toBe('a\r\n{"level":"info"}');
  });
});

describe("tiến trình Node thật", () => {
  function runChild(body: string) {
    const script = `import(${JSON.stringify(MODULE)}).then((m) => { m.installProcessErrorHandlers(); ${body} });`;
    return spawnSync(process.execPath, ["--no-warnings", "-e", script], {
      encoding: "utf8",
      timeout: 20_000,
    });
  }
  const fatalLines = (stderr: string) =>
    stderr
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("Promise bị từ chối không ai xử lý → stderr một dòng JSON, mã thoát 1, không chạy tiếp", () => {
    const r = runChild(
      `Promise.reject(new Error("mất kết nối")); setTimeout(() => console.log("VẪN CHẠY"), 500);`,
    );
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("VẪN CHẠY");
    const lines = fatalLines(r.stderr);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "fatal",
      event: "unhandledRejection",
      "exception.type": "Error",
      "exception.message": "mất kết nối",
    });
  });

  it("ngoại lệ ném trong callback → log + mã thoát 1", () => {
    const r = runChild(`setTimeout(() => { throw new RangeError("ngoài biên"); }, 10);`);
    expect(r.status).toBe(1);
    expect(fatalLines(r.stderr)[0]).toMatchObject({
      event: "uncaughtException",
      "exception.type": "RangeError",
    });
  });

  it("không có lỗi → tiến trình thoát bình thường (mã 0, không log fatal)", () => {
    const r = runChild(`setTimeout(() => console.log("xong"), 10);`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("xong");
    expect(fatalLines(r.stderr)).toEqual([]);
  });
});
