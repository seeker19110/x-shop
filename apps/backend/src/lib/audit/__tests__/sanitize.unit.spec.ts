import { PII, REDACTED, sanitizeChanges } from "../sanitize";

describe("sanitizeChanges (che PII trong audit)", () => {
  it("che theo tên khóa: bí mật bỏ hẳn, email/điện thoại che bằng mask, địa chỉ/họ tên thay hẳn", () => {
    expect(
      sanitizeChanges({
        password: "p@ss",
        token: "eyJ...",
        email: "nguyen.van.a@example.vn",
        phone: "0912345678",
        address: { line1: "12 Lý Thái Tổ", ward: "Hoàn Kiếm" },
        first_name: "An",
        role: "warehouse",
        delta: -3,
      }),
    ).toEqual({
      password: REDACTED,
      token: REDACTED,
      email: "n***@example.vn",
      phone: "091****678",
      address: PII,
      first_name: PII,
      role: "warehouse",
      delta: -3,
    });
  });

  it("che theo giá trị ở khóa bất kỳ, kể cả trong mảng/lồng nhau; null/rỗng giữ nguyên", () => {
    expect(
      sanitizeChanges({
        note: "khach@mail.vn",
        contacts: ["+84 912 345 678", "không phải số"],
        nested: { deep: { who: "a@b.co" } },
        empty: "",
        missing: null,
        skipped: undefined,
      }),
    ).toEqual({
      note: "k***@mail.vn",
      contacts: ["+84******678", "không phải số"],
      nested: { deep: { who: "a***@b.co" } },
      empty: "",
      missing: null,
    });
  });

  it("email/số điện thoại lẫn trong văn bản tự do cũng bị che; số khác giữ nguyên", () => {
    expect(sanitizeChanges({ reason: "Khách a.b@mail.vn gọi 0912345678 hỏi đơn 1234" })).toEqual({
      reason: "Khách a***@mail.vn gọi 091****678 hỏi đơn 1234",
    });
  });

  it("giới hạn độ sâu/độ dài (không phình audit)", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(JSON.stringify(sanitizeChanges(deep))).toContain("[…]");
    const long = sanitizeChanges({ s: "x".repeat(5000) }).s as string;
    expect(long.length).toBeLessThanOrEqual(1001);
    expect(
      (sanitizeChanges({ list: Array.from({ length: 500 }, (_, i) => i) }).list as number[]).length,
    ).toBe(100);
  });
});
