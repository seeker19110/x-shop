import { contentHashOf, parseSettlementCsv, parseVnd } from "../csv";
import { classifyLine, nextSettlementState, settlementStateFor, type SettlementTarget } from "../match";
import { SETTLEMENT_CONFIG } from "../constants";
import SettlementModuleService, { SettlementError, type ImportBatchInput } from "../service";

const NOW = new Date("2026-10-25T05:00:00Z");
const HEADER = "reference,amount,occurred_at,type";
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");

describe("parseSettlementCsv (định dạng nội bộ giả định)", () => {
  it("dòng hợp lệ: header không phân biệt hoa thường/thứ tự, BOM, CRLF, thời điểm có múi giờ → UTC", () => {
    const text = "﻿Type,Reference,Amount,Occurred_At\r\ncod,XS-1-S1,730000,2026-10-25T08:00:00+07:00\r\n";
    const out = parseSettlementCsv(text, "ghn_cod", NOW);
    expect(out).toMatchObject({
      ok: true,
      rows: [{ line: 2, reference: "XS-1-S1", amount: 730_000, type: "cod" }],
    });
    if (out.ok) expect(out.rows[0]?.occurred_at.toISOString()).toBe("2026-10-25T01:00:00.000Z");
  });

  it("file rỗng / chỉ header", () => {
    expect(parseSettlementCsv("", "ghn_cod", NOW)).toMatchObject({ ok: false, code: "EMPTY_FILE" });
    expect(parseSettlementCsv("\n\n", "ghn_cod", NOW)).toMatchObject({ ok: false, code: "EMPTY_FILE" });
    expect(parseSettlementCsv(`${HEADER}\n`, "ghn_cod", NOW)).toMatchObject({
      ok: false,
      code: "EMPTY_BATCH",
    });
  });

  it("thiếu cột / cột lạ / trùng cột → lỗi dòng 1", () => {
    expect(parseSettlementCsv("reference,amount\nA,1", "ghn_cod", NOW)).toMatchObject({
      ok: false,
      errors: [{ line: 1, column: "occurred_at,type" }],
    });
    const extra = parseSettlementCsv(`${HEADER},fee\nA,1,2026-10-25T00:00:00Z,cod,0`, "ghn_cod", NOW);
    expect(extra).toMatchObject({ ok: false, errors: [{ line: 1 }] });
  });

  it.each([
    ["-1", "âm"],
    ["1.5", "thập phân"],
    ["1,000", "phân cách"],
    ["1.000", "phân cách nghìn kiểu VN"],
    ["1e3", "số mũ"],
    ["", "rỗng"],
    ["2147483648", "vượt trần integer"],
    ["99999999999", "quá 10 chữ số"],
    [" 12a", "ký tự lạ"],
  ])("số tiền %p (%s) → lỗi cột amount", (amount) => {
    const out = parseSettlementCsv(csv(`A1,"${amount}",2026-10-25T00:00:00Z,cod`), "ghn_cod", NOW);
    expect(out).toMatchObject({ ok: false, code: "INVALID_ROWS", errors: [{ line: 2, column: "amount" }] });
  });

  it("số tiền 0 và trần integer hợp lệ; parseVnd chỉ nhận số nguyên an toàn ≥ 0", () => {
    expect(parseVnd("0")).toBe(0);
    expect(parseVnd("2147483647")).toBe(2_147_483_647);
    expect(parseVnd("007")).toBe(7);
    expect(parseVnd("-0")).toBeNull();
  });

  it("chống CSV injection: reference bắt đầu = + - @ hoặc có ký tự lạ → lỗi, không lặp lại nội dung ô", () => {
    for (const ref of ["=HYPERLINK(1)", "+1", "-1", "@SUM", "A B", "Đơn1", "x".repeat(65)]) {
      const out = parseSettlementCsv(csv(`"${ref}",1,2026-10-25T00:00:00Z,cod`), "ghn_cod", NOW);
      expect(out).toMatchObject({ ok: false, errors: [{ line: 2, column: "reference" }] });
      if (!out.ok) expect(JSON.stringify(out.errors)).not.toContain(ref.slice(0, 5));
    }
  });

  it("thời điểm thiếu múi giờ / sai / tương lai quá 24h → lỗi; type sai nguồn → lỗi", () => {
    const bad = (when: string) =>
      parseSettlementCsv(csv(`A1,1,${when},cod`), "ghn_cod", NOW) as { ok: false; errors: unknown[] };
    expect(bad("2026-10-25T08:00:00").errors).toEqual([expect.objectContaining({ column: "occurred_at" })]);
    expect(bad("25/10/2026").errors).toEqual([expect.objectContaining({ column: "occurred_at" })]);
    expect(bad("2026-10-27T00:00:00Z").errors).toEqual([
      expect.objectContaining({ column: "occurred_at", message: "Thời điểm ở tương lai" }),
    ]);
    expect(parseSettlementCsv(csv("A1,1,2026-10-25T00:00:00Z,payment"), "ghn_cod", NOW)).toMatchObject({
      ok: false,
      errors: [{ column: "type" }],
    });
    expect(parseSettlementCsv(csv("A1,1,2026-10-25T00:00:00Z,cod"), "vnpay", NOW)).toMatchObject({
      ok: false,
      errors: [{ column: "type" }],
    });
  });

  it("số cột sai và dòng trùng (reference + type) → lỗi; tất cả hoặc không", () => {
    const out = parseSettlementCsv(
      csv("A1,1,2026-10-25T00:00:00Z,cod", "A2,1", "a1,5,2026-10-25T01:00:00Z,cod"),
      "ghn_cod",
      NOW,
    );
    expect(out).toMatchObject({
      ok: false,
      errors: [
        { line: 3, column: "*" },
        { line: 4, column: "reference", message: "Trùng với dòng 2" },
      ],
    });
  });

  it("băm nội dung chuẩn hoá: CRLF/BOM/thứ tự dòng không đổi băm; đổi số tiền hoặc nguồn thì đổi", () => {
    const a = parseSettlementCsv(
      csv("A1,1,2026-10-25T00:00:00Z,payment", "B1,2,2026-10-25T01:00:00Z,refund"),
      "vnpay",
      NOW,
    );
    const b = parseSettlementCsv(
      "﻿" +
        [HEADER, "B1,2,2026-10-25T08:00:00+07:00,refund", "A1,1,2026-10-25T00:00:00.000Z,payment"].join(
          "\r\n",
        ),
      "vnpay",
      NOW,
    );
    const c = parseSettlementCsv(
      csv("A1,1,2026-10-25T00:00:00Z,payment", "B1,3,2026-10-25T01:00:00Z,refund"),
      "vnpay",
      NOW,
    );
    if (!a.ok || !b.ok || !c.ok) throw new Error("parse lỗi");
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.content_hash).not.toBe(c.content_hash);
    expect(contentHashOf("ghn_cod", a.rows)).not.toBe(a.content_hash);
  });
});

describe("classifyLine / settlementState", () => {
  const target = (expected: number, cancelled = false): SettlementTarget => ({
    kind: "shipment",
    id: "shp_1",
    order_id: "order_1",
    expected,
    order_cancelled: cancelled,
  });

  it("khớp / lệch thiếu / lệch dư / thừa / thu dư / tiền đến sau hủy", () => {
    expect(classifyLine(500, target(500), 0)).toEqual({
      result: "matched",
      expected: 500,
      difference: null,
      exposure: 0,
    });
    expect(classifyLine(450, target(500), 0)).toMatchObject({
      result: "amount_mismatch",
      difference: -50,
      exposure: 50,
    });
    expect(classifyLine(520, target(500), 0)).toMatchObject({
      result: "amount_mismatch",
      difference: 20,
      exposure: 20,
    });
    expect(classifyLine(50, target(500), 450)).toMatchObject({ result: "matched", expected: 50 });
    expect(classifyLine(300, null, 0)).toMatchObject({ result: "unexpected", expected: null, exposure: 300 });
    expect(classifyLine(500, target(500), 500)).toMatchObject({
      result: "overpaid",
      expected: 0,
      exposure: 500,
    });
    // Đơn đã trả online đủ (COD = 0) mà hãng vẫn thu → thu dư (AT13).
    expect(classifyLine(200, target(0), 0)).toMatchObject({ result: "overpaid", exposure: 200 });
    expect(classifyLine(500, target(500, true), 0)).toMatchObject({
      result: "late_after_cancel",
      exposure: 500,
    });
    expect(() => classifyLine(-1, null, 0)).toThrow(RangeError);
    expect(() => classifyLine(1.5, null, 0)).toThrow(RangeError);
  });

  it("trạng thái đối soát theo tổng đã nhận; settled là kết thúc", () => {
    expect(settlementStateFor(500, 0)).toBe("unsettled");
    expect(settlementStateFor(500, 100)).toBe("partially_settled");
    expect(settlementStateFor(500, 500)).toBe("settled");
    expect(settlementStateFor(500, 600)).toBe("disputed");
    expect(nextSettlementState("unsettled", 500, 500)).toBe("settled");
    expect(nextSettlementState("partially_settled", 500, 500)).toBe("settled");
    expect(nextSettlementState("settled", 500, 600)).toBeNull();
    expect(nextSettlementState("unsettled", 500, 0)).toBeNull();
    expect(nextSettlementState("disputed", 500, 700)).toBeNull();
  });
});

describe("importBatch — chờ khoá nhập có hạn (T-140)", () => {
  const input: ImportBatchInput = {
    source: "ghn_cod",
    content_hash: "a".repeat(64),
    external_ref: null,
    period_end: null,
    imported_by: "user_1",
    rows: [],
  };
  /** knex giả: `raw` ghi lại câu lệnh; câu chờ khoá ném `lockError` (nếu có); bước sau khoá dừng bằng lỗi STOP. */
  function fakeDb(lockError?: unknown) {
    const calls: Array<{ sql: string; bindings: unknown }> = [];
    const raw = jest.fn(async (sql: string, bindings?: unknown) => {
      calls.push({ sql, bindings });
      if (lockError !== undefined && sql.includes("pg_advisory_xact_lock")) throw lockError;
      return { rows: [] };
    });
    const trx = Object.assign(
      () => {
        throw new Error("STOP");
      },
      { raw },
    );
    const db = { transaction: async (fn: (t: typeof trx) => Promise<unknown>) => fn(trx) };
    const svc = new SettlementModuleService({ __pg_connection__: db as never });
    return { svc, calls };
  }

  it("đặt lock_timeout cục bộ = hạn chờ TRƯỚC câu chờ khoá, trả về mặc định NGAY SAU khi giành được", async () => {
    const { svc, calls } = fakeDb();
    await expect(svc.importBatch(input)).rejects.toThrow("STOP");
    expect(calls.map((c) => c.sql)).toEqual([
      "select set_config('lock_timeout', ?, true)",
      "select pg_advisory_xact_lock(hashtext(?))",
      "set local lock_timeout to default",
    ]);
    expect(calls[0]!.bindings).toEqual([`${SETTLEMENT_CONFIG.importLockWaitMs}ms`]);
    expect(calls[1]!.bindings).toEqual(["x-settlement:ghn_cod"]);
  });

  it.each([
    ["55P03", "lock_timeout"],
    ["57014", "statement_timeout nhỏ hơn hạn chờ"],
  ])(
    "câu chờ khoá lỗi %s (%s) → SettlementError IMPORT_IN_PROGRESS, không chạy câu nào sau đó",
    async (code) => {
      const { svc, calls } = fakeDb(Object.assign(new Error("canceling statement"), { code }));
      const err = (await svc.importBatch(input).catch((e: unknown) => e)) as SettlementError;
      expect(err).toBeInstanceOf(SettlementError);
      expect(err.code).toBe("IMPORT_IN_PROGRESS");
      expect(err.detail).toEqual({ source: "ghn_cod" });
      expect(calls).toHaveLength(2);
    },
  );

  it("lỗi khác ở câu chờ khoá (mất kết nối, lỗi lạ, giá trị không phải Error) → ném nguyên lỗi gốc", async () => {
    for (const e of [
      Object.assign(new Error("terminated"), { code: "57P01" }),
      new Error("ECONNRESET"),
      null,
    ]) {
      const { svc } = fakeDb(e);
      await expect(svc.importBatch(input)).rejects.toBe(e);
    }
  });
});

describe("hạn chờ khoá nhập: cấu hình hợp lệ", () => {
  it("số nguyên dương, nhỏ hơn hẳn statement_timeout mặc định 30 s", () => {
    expect(Number.isSafeInteger(SETTLEMENT_CONFIG.importLockWaitMs)).toBe(true);
    expect(SETTLEMENT_CONFIG.importLockWaitMs).toBeGreaterThan(0);
    expect(SETTLEMENT_CONFIG.importLockWaitMs).toBeLessThanOrEqual(15_000);
  });
});
