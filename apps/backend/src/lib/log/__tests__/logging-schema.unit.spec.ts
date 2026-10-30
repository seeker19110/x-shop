import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schemaErrors as validateSchema } from "../../../../../../scripts/log-schema-validate.cjs";
import { fatalLogLine } from "../../errors/process";
import { createLogger } from "../logger";

/**
 * T-190 (BASE-ERR-005/006): dòng log của backend (logger ứng dụng + dòng fatal của process.ts) hợp `docs/ops/log-schema.json`
 * — cùng file mà test storefront (`logger.test.ts`) dùng. Validator tối thiểu (không thêm phụ thuộc) cho tập từ khoá của schema.
 */
type Schema = Record<string, unknown>;
const logSchema = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../docs/ops/log-schema.json"), "utf8"),
) as Schema;
const schemaErrors = (line: unknown): string[] => validateSchema(logSchema, line);

describe("logging: dòng log backend theo schema chung", () => {
  it("validator bắt dòng sai", () => {
    const good = {
      timestamp: "2026-10-30T01:02:03.004Z",
      level: "error",
      severity_number: 17,
      message: "m",
      service: "s",
      version: "1",
      env: "e",
    };
    expect(schemaErrors(good)).toEqual([]);
    expect(schemaErrors({ ...good, severity_number: 21 })).not.toEqual([]);
    expect(schemaErrors({ ...good, timestamp: "2026-10-30T01:02:03Z" })).not.toEqual([]);
    expect(schemaErrors({ ...good, version: "" })).not.toEqual([]);
  });

  it.each(["trace", "debug", "info", "warn", "error", "fatal"] as const)(
    "AppLogger mức %s hợp schema",
    (level) => {
      const raw: string[] = [];
      const logger = createLogger({
        service: "x-shop-backend",
        version: "0.1.0",
        env: "test",
        level: "silly",
        write: (l) => raw.push(l),
        now: () => new Date("2026-10-30T01:02:03.004Z"),
      });
      logger.emit(level, "xin chào", { order_total: 0 }, level === "error" ? new Error("lỗi") : undefined);
      expect(raw).toHaveLength(1);
      expect(schemaErrors(JSON.parse(raw[0] as string))).toEqual([]);
    },
  );

  it.each([
    ["uncaughtException", new Error("lỗi", { cause: new Error("gốc") })],
    ["unhandledRejection", "chuỗi"],
    ["unhandledRejection", null],
    ["unhandledRejection", 0],
  ] as const)("dòng fatal (%s) hợp schema, có version/env/severity_number", (event, reason) => {
    const line = fatalLogLine(event, reason, new Date("2026-10-30T01:02:03.004Z"), "x-shop-backend", {
      version: "0.1.0",
      env: "production",
    });
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec).toMatchObject({
      level: "fatal",
      severity_number: 21,
      version: "0.1.0",
      env: "production",
      event,
    });
    expect(schemaErrors(rec)).toEqual([]);
  });

  it("dòng fatal không có meta: dùng biến môi trường, thiếu → unknown; giá trị lạ bị thay (không chèn log)", () => {
    const keep = { v: process.env.npm_package_version, e: process.env.NODE_ENV };
    try {
      delete process.env.npm_package_version;
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
      let rec = JSON.parse(fatalLogLine("uncaughtException", new Error("x"), new Date(0), "s")) as Record<
        string,
        unknown
      >;
      expect(rec).toMatchObject({ version: "unknown", env: "unknown" });
      expect(schemaErrors(rec)).toEqual([]);
      rec = JSON.parse(
        fatalLogLine("uncaughtException", new Error("x"), new Date(0), "s", { version: 'a"\n', env: "" }),
      ) as Record<string, unknown>;
      expect(rec).toMatchObject({ version: "unknown", env: "unknown" });
    } finally {
      if (keep.v !== undefined) process.env.npm_package_version = keep.v;
      (process.env as Record<string, string | undefined>).NODE_ENV = keep.e;
    }
  });
});
