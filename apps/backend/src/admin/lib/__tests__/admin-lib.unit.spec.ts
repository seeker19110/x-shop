import { formatVnd as domainFormatVnd, isNonEmpty as domainIsNonEmpty } from "@x-shop/domain";
import { buildQuery } from "../api";
import { checkCsvFile } from "../csv-file";
import { formatAge, formatInstant, formatVnd } from "../format";
import { checkInspection, type InspectDraft } from "../inspect";
import { periodFromDays } from "../period";
import { kindLabel } from "../labels";
import { isNonEmpty } from "../presence";
import { describeProblem, normalizeRowErrors, rowErrorsOf, toApiError } from "../problem";

describe("formatVnd / formatAge / formatInstant", () => {
  it("khớp formatVnd của domain (0, số lớn, âm hợp lệ với domain)", () => {
    for (const n of [0, 1, 999, 1_000, 1_300_000, 2_147_483_647]) {
      expect(formatVnd(n).replace(/\s/g, " ")).toBe(domainFormatVnd(n).replace(/\s/g, " "));
    }
  });
  it("null/undefined/không nguyên/không an toàn → dấu gạch, không bịa 0", () => {
    expect(formatVnd(null)).toBe("—");
    expect(formatVnd(undefined)).toBe("—");
    expect(formatVnd(1.5)).toBe("—");
    expect(formatVnd(Number.NaN)).toBe("—");
    expect(formatVnd(2 ** 53)).toBe("—");
    expect(formatVnd(0)).toContain("0");
  });
  it("tuổi: ranh giới giây/phút/giờ/ngày, âm/null", () => {
    expect(formatAge(0)).toBe("0 giây");
    expect(formatAge(59)).toBe("59 giây");
    expect(formatAge(60)).toBe("1 phút");
    expect(formatAge(3600)).toBe("1 giờ");
    expect(formatAge(3600 + 300)).toBe("1 giờ 5 phút");
    expect(formatAge(86_400)).toBe("1 ngày");
    expect(formatAge(86_400 + 4 * 3600)).toBe("1 ngày 4 giờ");
    expect(formatAge(-1)).toBe("—");
    expect(formatAge(null)).toBe("—");
    expect(formatAge(Number.NaN)).toBe("—");
  });
  it("thời điểm: hiển thị theo giờ Việt Nam; rỗng/sai → dấu gạch", () => {
    expect(formatInstant("2026-10-25T17:30:00Z")).toContain("00:30");
    expect(formatInstant(null)).toBe("—");
    expect(formatInstant("")).toBe("—");
    expect(formatInstant("không phải ngày")).toBe("—");
  });
});

describe("describeProblem — lỗi API → tiếng Việt", () => {
  it("SELF_APPROVAL nêu rõ nguyên tắc hai người", () => {
    const v = describeProblem(toApiError(403, { code: "SELF_APPROVAL", title: "x" }));
    expect(v.action).toBe("none");
    expect(v.message).toContain("không được tự duyệt");
    expect(v.message).toContain("người khác");
  });
  it("REAUTH_REQUIRED → yêu cầu xác thực lại, kèm số phút từ max_age_seconds", () => {
    const v = describeProblem(toApiError(403, { code: "REAUTH_REQUIRED", max_age_seconds: 300 }));
    expect(v.action).toBe("reauth");
    expect(v.message).toContain("TOTP");
    expect(v.message).toContain("5 phút");
  });
  it("REAUTH_REQUIRED thiếu/0/âm max_age_seconds → không in số phút bừa", () => {
    for (const body of [{}, { max_age_seconds: 0 }, { max_age_seconds: -5 }, { max_age_seconds: "300" }]) {
      expect(describeProblem(toApiError(403, { code: "REAUTH_REQUIRED", ...body })).message).not.toContain(
        "hiệu lực",
      );
    }
  });
  it("MFA_REQUIRED → reauth; phiên hết hạn/401 → login", () => {
    expect(describeProblem(toApiError(403, { code: "MFA_REQUIRED" })).action).toBe("reauth");
    for (const code of ["UNAUTHORIZED", "SESSION_EXPIRED", "SESSION_IDLE"]) {
      expect(describeProblem(toApiError(401, { code })).action).toBe("login");
    }
  });
  it("FORBIDDEN nêu quyền thiếu nếu server cho biết", () => {
    expect(
      describeProblem(toApiError(403, { code: "FORBIDDEN", permission: "refund.approve" })).message,
    ).toContain("refund.approve");
    expect(describeProblem(toApiError(403, { code: "FORBIDDEN" })).message).not.toContain("cần quyền");
  });
  it("VALIDATION liệt kê lỗi theo trường; không có chi tiết vẫn có thông điệp", () => {
    const v = describeProblem(
      toApiError(422, {
        code: "VALIDATION",
        errors: [
          { param: "reason", reason: "ít nhất 3 ký tự" },
          { param: "*", reason: "sai" },
        ],
      }),
    );
    expect(v.message).toContain("reason: ít nhất 3 ký tự");
    expect(v.message).toContain("sai");
    expect(describeProblem(toApiError(422, { code: "VALIDATION" })).message).toBe("Dữ liệu không hợp lệ.");
  });
  it("mã lạ → dùng title server; thân không phải problem+json → mã HTTP_<status>", () => {
    expect(describeProblem(toApiError(409, { code: "ZZZ", title: "Tiêu đề server" })).message).toBe(
      "Tiêu đề server",
    );
    const e = toApiError(500, "<html>");
    expect(e.code).toBe("HTTP_500");
    expect(describeProblem(e).message).toBe("Lỗi 500");
    expect(toApiError(502, null).code).toBe("HTTP_502");
    expect(describeProblem(toApiError(502, [])).message).toContain("thử lại");
  });
});

describe("isNonEmpty bản Admin (BASE-DATA-003)", () => {
  it('khớp bản domain: thiếu/rỗng → false; có nội dung (kể cả "0", " ") và Date → true', () => {
    for (const v of [null, undefined, "", " ", "0", "false", "id_1", new Date(0)]) {
      expect(isNonEmpty(v)).toBe(domainIsNonEmpty(v));
    }
    expect(isNonEmpty("")).toBe(false);
    expect(isNonEmpty("0")).toBe(true);
  });
});

describe("lỗi theo dòng/cột", () => {
  it("commit catalog 422: rows {line,column,message}", () => {
    const e = toApiError(422, {
      code: "IMPORT_HAS_ERRORS",
      rows: [{ line: 3, column: "price", message: "Giá phải là số nguyên" }],
      errors: [{ param: "line 3: price", reason: "Giá phải là số nguyên" }],
    });
    expect(rowErrorsOf(e)).toEqual([{ line: 3, column: "price", message: "Giá phải là số nguyên" }]);
  });
  it("đối soát 422: row_errors", () => {
    const e = toApiError(422, {
      code: "INVALID_ROWS",
      row_errors: [{ line: 2, column: "*", message: "Cần 4 cột, có 3" }],
    });
    expect(rowErrorsOf(e)).toEqual([{ line: 2, column: "*", message: "Cần 4 cột, có 3" }]);
  });
  it("chỉ có errors[].param dạng 'line N: cột' → suy ra; param khác bị bỏ", () => {
    const e = toApiError(422, {
      errors: [
        { param: "line 7: sku", reason: "SKU trùng" },
        { param: "file", reason: "không liên quan" },
      ],
    });
    expect(rowErrorsOf(e)).toEqual([{ line: 7, column: "sku", message: "SKU trùng" }]);
  });
  it("param 'line N: ' cột rỗng → \"*\" (cả dòng), như khi thiếu (BASE-DATA-003)", () => {
    const e = toApiError(422, { errors: [{ param: "line 4: ", reason: "Dòng lỗi" }] });
    expect(rowErrorsOf(e)).toEqual([{ line: 4, column: "*", message: "Dòng lỗi" }]);
  });
  it("rỗng/sai hình dạng → danh sách rỗng, không ném lỗi", () => {
    expect(rowErrorsOf(toApiError(500, {}))).toEqual([]);
    expect(normalizeRowErrors(undefined)).toEqual([]);
    expect(normalizeRowErrors([null, 3, { line: 1 }, { message: "ok", line: 1.5 }])).toEqual([
      { line: null, column: "*", message: "ok" },
    ]);
  });
  it("Unicode trong thông điệp được giữ nguyên", () => {
    expect(normalizeRowErrors([{ line: 4, column: "tên", message: "Áo thun — dài quá ✓" }])[0]?.message).toBe(
      "Áo thun — dài quá ✓",
    );
  });
});

describe("checkInspection (D-019)", () => {
  const lines = [
    { line_id: "li_1", received_quantity: 3 },
    { line_id: "li_2", received_quantity: 0 },
    { line_id: "li_3", received_quantity: null },
  ];
  const d = (restock: string, damaged: string, note = ""): InspectDraft => ({ restock, damaged, note });

  it("đạt + lỗi ≤ đã nhận; không đạt = phần còn lại; bỏ dòng chưa nhận", () => {
    const out = checkInspection(lines, { li_1: d("1", "1", "  rách tay  ") });
    expect(out).toEqual({
      ok: true,
      lines: [{ line_id: "li_1", restock_quantity: 1, damaged_quantity: 1, note: "rách tay" }],
      rejected: { li_1: 1 },
    });
  });
  it("chưa nhập (rỗng) không mặc định 0 — bắt buộc nhập rõ", () => {
    expect(checkInspection(lines, {})).toMatchObject({ ok: false, errors: { li_1: expect.any(String) } });
    expect(checkInspection(lines, { li_1: d("2", "") })).toMatchObject({ ok: false });
    expect(checkInspection(lines, { li_1: d("", "0") })).toMatchObject({ ok: false });
  });
  it("0/0 hợp lệ → toàn bộ không đạt (trả lại khách)", () => {
    expect(checkInspection(lines, { li_1: d("0", "0") })).toMatchObject({ ok: true, rejected: { li_1: 3 } });
  });
  it("vượt số đã nhận, số âm/thập phân/chữ → lỗi theo dòng", () => {
    expect(checkInspection(lines, { li_1: d("2", "2") })).toMatchObject({
      ok: false,
      errors: { li_1: expect.stringContaining("vượt") },
    });
    for (const bad of ["-1", "1.5", "a", "100", "1e1"]) {
      expect(checkInspection(lines, { li_1: d(bad, "0") }).ok).toBe(false);
    }
  });
  it("không có dòng nào đã nhận → lỗi chung '*'", () => {
    expect(checkInspection([{ line_id: "a", received_quantity: 0 }], {})).toEqual({
      ok: false,
      errors: { "*": expect.any(String) },
    });
    expect(checkInspection([], {})).toMatchObject({ ok: false });
  });
  it("ghi chú rỗng không gửi; ghi chú quá dài cắt 500 ký tự", () => {
    const out = checkInspection(lines, { li_1: d("3", "0", "x".repeat(600)) });
    expect(out.ok && out.lines[0]?.note?.length).toBe(500);
    const empty = checkInspection(lines, { li_1: d("3", "0", "   ") });
    expect(empty.ok && "note" in (empty.lines[0] ?? {})).toBe(false);
  });
});

describe("periodFromDays", () => {
  it("rỗng cả hai → không giới hạn", () => {
    expect(periodFromDays("", "")).toEqual({ ok: true, from: null, to: null });
  });
  it("to bao gồm ngày cuối → mốc là 00:00 ngày kế (giờ VN), qua ranh tháng/năm/năm nhuận", () => {
    expect(periodFromDays("2026-10-01", "2026-10-31")).toEqual({
      ok: true,
      from: "2026-10-01T00:00:00+07:00",
      to: "2026-11-01T00:00:00+07:00",
    });
    expect(periodFromDays("", "2026-12-31")).toMatchObject({ to: "2027-01-01T00:00:00+07:00" });
    expect(periodFromDays("", "2028-02-28")).toMatchObject({ to: "2028-02-29T00:00:00+07:00" });
  });
  it("một ngày: from = to → khoảng đúng 24 giờ", () => {
    expect(periodFromDays("2026-10-25", "2026-10-25")).toEqual({
      ok: true,
      from: "2026-10-25T00:00:00+07:00",
      to: "2026-10-26T00:00:00+07:00",
    });
  });
  it("sai định dạng, ngày không tồn tại, đảo ngược → lỗi", () => {
    expect(periodFromDays("25/10/2026", "")).toMatchObject({ ok: false });
    expect(periodFromDays("2026-02-31", "")).toMatchObject({ ok: false });
    expect(periodFromDays("", "2027-02-29")).toMatchObject({ ok: false });
    expect(periodFromDays("2026-10-26", "2026-10-25")).toMatchObject({ ok: false });
  });
});

describe("buildQuery / checkCsvFile", () => {
  it("bỏ giá trị rỗng/null/undefined, cắt khoảng trắng, mã hoá Unicode và ký tự đặc biệt", () => {
    expect(buildQuery({ a: "x", b: "", c: null, d: undefined, e: 0, f: "  y  " })).toBe("?a=x&e=0&f=y");
    expect(buildQuery({})).toBe("");
    expect(buildQuery(undefined)).toBe("");
    expect(buildQuery({ q: "áo&dài" })).toBe("?q=%C3%A1o%26d%C3%A0i");
  });
  it("file CSV: đuôi, rỗng, quá cỡ, đúng biên", () => {
    const max = 1024;
    expect(checkCsvFile({ name: "a.csv", size: 10 }, max)).toBeNull();
    expect(checkCsvFile({ name: "A.TXT", size: max }, max)).toBeNull();
    expect(checkCsvFile({ name: "a.csv", size: max + 1 }, max)).toContain("lớn hơn");
    expect(checkCsvFile({ name: "a.csv", size: 0 }, max)).toContain("rỗng");
    expect(checkCsvFile({ name: "a.xlsx", size: 10 }, max)).toContain("đuôi");
    expect(checkCsvFile({ name: "csv", size: 10 }, max)).toContain("đuôi");
  });
});

describe("kindLabel (dashboard ngoại lệ)", () => {
  it("kind ngoại lệ catalog có nhãn tiếng Việt; mã lạ/rỗng hiện nguyên mã", () => {
    expect(kindLabel("catalog_compensation_failed")).toBe("Hoàn tác dữ liệu sản phẩm lỗi");
    expect(kindLabel("catalog_index_mismatch")).toBe("Chỉ mục danh mục lệch giá");
    expect(kindLabel("ma_la")).toBe("ma_la");
    expect(kindLabel("")).toBe("");
  });
});
