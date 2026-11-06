import { parseRfc3339, rfc3339Instant } from "../time";
import { SummaryQuery, parseInput, SettlementHttpError } from "../../settlement/http";

const NO_OFFSET = [
  "2026-10-25T10:00:00",
  "2026-10-25T10:00:00.123",
  "2026-10-25",
  "2026-10-25 10:00:00Z", // dấu cách thay T
  "2026-10-25T10:00Z", // thiếu giây (RFC 3339 bắt buộc giây)
  "2026-10-25T10:00:00+07", // offset thiếu phút
  "2026-10-25T10:00:00+0700", // offset thiếu dấu hai chấm
  "1792897200000", // epoch dạng chuỗi
  "",
  "   ",
  "Sat, 25 Oct 2026 10:00:00 GMT",
];

describe("parseRfc3339 (XC-UNITS-001: chỉ nhận RFC 3339 có offset)", () => {
  it.each(NO_OFFSET)("từ chối %j", (raw) => {
    expect(parseRfc3339(raw)).toBeNull();
  });

  it("nhận Z, ±hh:mm, phần giây lẻ; quy về cùng một thời điểm UTC", () => {
    const utc = parseRfc3339("2026-10-25T03:00:00Z");
    expect(utc?.toISOString()).toBe("2026-10-25T03:00:00.000Z");
    expect(parseRfc3339("2026-10-25T10:00:00+07:00")?.getTime()).toBe(utc?.getTime());
    expect(parseRfc3339("2026-10-24T22:00:00-05:00")?.getTime()).toBe(utc?.getTime());
    expect(parseRfc3339("2026-10-25T03:00:00.123Z")?.toISOString()).toBe("2026-10-25T03:00:00.123Z");
    expect(parseRfc3339("2026-10-25T03:00:00.123456789Z")?.toISOString()).toBe("2026-10-25T03:00:00.123Z");
  });

  it("kết quả không phụ thuộc múi giờ máy chạy (không đoán giờ địa phương)", () => {
    expect(parseRfc3339("2026-10-25T00:00:00+07:00")?.toISOString()).toBe("2026-10-24T17:00:00.000Z");
  });

  it("ngày/giờ/offset không tồn tại bị từ chối (không tràn ngày)", () => {
    for (const raw of [
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z", // 2026 không nhuận
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-10-00T00:00:00Z",
      "2026-10-25T24:00:00Z",
      "2026-10-25T23:60:00Z",
      "2026-10-25T23:59:60Z",
      "2026-10-25T10:00:00+24:00",
      "2026-10-25T10:00:00+07:60",
    ]) {
      expect(parseRfc3339(raw)).toBeNull();
    }
    expect(parseRfc3339("2028-02-29T00:00:00Z")?.toISOString()).toBe("2028-02-29T00:00:00.000Z"); // năm nhuận
    expect(parseRfc3339("2000-02-29T00:00:00Z")).not.toBeNull(); // chia hết 400
    expect(parseRfc3339("2100-02-29T00:00:00Z")).toBeNull(); // chia hết 100, không chia hết 400
  });

  it("Unicode: chữ số toàn chiều rộng/Ả Rập không lọt qua", () => {
    expect(parseRfc3339("２０２６-10-25T10:00:00Z")).toBeNull();
    expect(parseRfc3339("2026-10-25T10:00:00Z​")).toBeNull();
    expect(parseRfc3339("2026-10-25T10:00:00−" + "07:00")).toBeNull(); // dấu trừ Unicode, không phải '-'
  });

  it("năm UTC sau khi trừ offset phải trong 0001–9999 (toISOString vẫn là RFC 3339)", () => {
    expect(parseRfc3339("9999-12-31T23:59:59-23:59")).toBeNull(); // UTC năm 10000
    expect(parseRfc3339("0000-01-01T00:00:00+00:01")).toBeNull(); // UTC năm -1
    expect(parseRfc3339("0000-06-01T00:00:00Z")).toBeNull(); // năm 0
    expect(parseRfc3339("9999-12-31T23:59:59Z")?.toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(parseRfc3339("0001-01-01T00:00:00Z")?.toISOString()).toBe("0001-01-01T00:00:00.000Z");
  });

  it("chỉ nhận T/Z chữ hoa (giới hạn cố ý trong phạm vi RFC 3339 §5.6)", () => {
    expect(parseRfc3339("2026-10-25t10:00:00z")).toBeNull();
    expect(parseRfc3339("2026-10-25T10:00:00z")).toBeNull();
    expect(parseRfc3339("2026-10-25T10:00:00Z")).not.toBeNull();
  });
});

describe("rfc3339Instant (zod) và tham số API", () => {
  it("trim khoảng trắng rồi parse; sai → lỗi kèm gợi ý", () => {
    expect(rfc3339Instant.parse(" 2026-10-25T03:00:00Z ").toISOString()).toBe("2026-10-25T03:00:00.000Z");
    const bad = rfc3339Instant.safeParse("2026-10-25T10:00:00");
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.message).toContain("offset");
  });

  it("API báo cáo: from/to không offset → 422 VALIDATION theo trường; có offset → nhận", () => {
    for (const raw of NO_OFFSET.filter((v) => v.trim() !== "")) {
      let caught: unknown;
      try {
        parseInput(SummaryQuery, { from: raw });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SettlementHttpError);
      expect(caught).toMatchObject({ status: 422, code: "VALIDATION", errors: [{ param: "from" }] });
    }
    const ok = parseInput(SummaryQuery, { from: "2026-10-01T00:00:00+07:00", to: "2026-10-25T00:00:00Z" });
    expect(ok.from?.toISOString()).toBe("2026-09-30T17:00:00.000Z");
    expect(ok.to?.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
});
