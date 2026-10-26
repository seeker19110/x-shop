import { maskFreeText, PII, REDACTED, sanitizeChanges } from "../sanitize";

describe("sanitizeChanges (che PII trong audit)", () => {
  it("che theo tên khóa: bí mật bỏ hẳn, email/điện thoại che bằng mask, địa chỉ/họ tên thay hẳn", () => {
    expect(
      sanitizeChanges({
        password: "p@ss",
        token: "eyJ...",
        email: "nguyen.van.a@example.test",
        phone: "0912345678",
        address: { line1: "12 Lý Thái Tổ", ward: "Hoàn Kiếm" },
        first_name: "An",
        role: "warehouse",
        delta: -3,
      }),
    ).toEqual({
      password: REDACTED,
      token: REDACTED,
      email: "n***@example.test",
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
        note: "khach@example.test",
        contacts: ["+84 912 345 678", "không phải số"],
        nested: { deep: { who: "a@example.test" } },
        empty: "",
        missing: null,
        skipped: undefined,
      }),
    ).toEqual({
      note: "k***@example.test",
      contacts: ["+84******678", "không phải số"],
      nested: { deep: { who: "a***@example.test" } },
      empty: "",
      missing: null,
    });
  });

  it("email/số điện thoại lẫn trong văn bản tự do cũng bị che; số khác giữ nguyên", () => {
    expect(sanitizeChanges({ reason: "Khách a.b@example.test gọi 0912345678 hỏi đơn 1234" })).toEqual({
      reason: "Khách a***@example.test gọi 091****678 hỏi đơn 1234",
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

describe("maskFreeText (ghi chú/lý do tự do — T-054)", () => {
  it("che SĐT VN dạng liền, có khoảng trắng/chấm/+84; email; địa chỉ theo cụm báo hiệu", () => {
    expect(maskFreeText("gọi 0912345678 nhé")).toBe("gọi 091****678 nhé");
    expect(maskFreeText("gọi +84 912 345 678 nhé")).toBe("gọi +84******678 nhé");
    expect(maskFreeText("gọi 0912.345.678")).toBe("gọi 091****678");
    expect(maskFreeText("mail lan.nguyen@example.com ạ")).toBe("mail l***@example.com ạ");
    expect(maskFreeText("giao số nhà 12 ngõ 5 Lý Thường Kiệt, Hà Nội; cảm ơn")).toBe("giao [PII]; cảm ơn");
    expect(maskFreeText("khách ở số 12 đường Lê Lợi, phường Bến Nghé, quận 1 gọi lại")).not.toMatch(
      /Lê Lợi|Bến Nghé/,
    );
  });

  it("không có PII → giữ nguyên từng ký tự (Unicode tiếng Việt, số tiền, mã); null/rỗng", () => {
    for (const t of [
      "Áo bị rách đường chỉ, khách muốn đổi size L — hoàn 250.000đ theo đơn XS-1234",
      "Đường may lỗi",
      "",
    ])
      expect(maskFreeText(t)).toBe(t);
    expect(maskFreeText(null)).toBeNull();
    expect(maskFreeText(undefined)).toBeNull();
  });
});
