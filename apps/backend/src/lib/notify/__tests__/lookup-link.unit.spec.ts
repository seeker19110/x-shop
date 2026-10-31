import { issueOrderToken, readOrderToken, setOrderLookupSecretForTest } from "../../orders/access";
import { expectLinearOrUnder } from "../../__tests__/cpu-budget";
import { orderLookupLink, scrubPii } from "../notify";

/** T-149 (D-089): liên kết tra cứu dựng lúc gửi; token không được lọt vào thông điệp lỗi lưu DB/log. */
describe("orderLookupLink", () => {
  beforeAll(() => setOrderLookupSecretForTest("unit-test-order-lookup-secret-0123456789abcdef"));
  afterAll(() => setOrderLookupSecretForTest(null));

  it("gốc + /tra-cuu-don/xac-thuc?token=…; bỏ `/` cuối, giữ tiền tố; token đọc lại được", () => {
    const { token } = issueOrderToken("link", "order_01JABC", new Date("2026-10-27T08:00:00Z"));
    const link = orderLookupLink("https://shop.example.vn/", token);
    expect(link).toBe(`https://shop.example.vn/tra-cuu-don/xac-thuc?token=${token}`);
    expect(orderLookupLink("http://localhost:8000/shop", token)).toBe(
      `http://localhost:8000/shop/tra-cuu-don/xac-thuc?token=${token}`,
    );
    const back = new URL(link).searchParams.get("token");
    expect(readOrderToken("link", back, new Date("2026-10-27T08:05:00Z"))?.orderId).toBe("order_01JABC");
  });

  it("ký tự đặc biệt trong token được mã hoá URL", () => {
    expect(orderLookupLink("https://a.vn", "a+b/c=&x")).toBe(
      "https://a.vn/tra-cuu-don/xac-thuc?token=a%2Bb%2Fc%3D%26x",
    );
  });
});

describe("scrubPii — token liên kết", () => {
  beforeAll(() => setOrderLookupSecretForTest("unit-test-order-lookup-secret-0123456789abcdef"));
  afterAll(() => setOrderLookupSecretForTest(null));

  it("che tham số token= và chuỗi dạng token ký HMAC; giữ phần còn lại", () => {
    const { token } = issueOrderToken("link", "order_01JABC");
    const link = orderLookupLink("https://shop.example.vn", token);
    const out = scrubPii(`SMTP 451 tạm lỗi — thư: Mở link ${link} ngay. Token trần: ${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain("SMTP 451");
    expect(out).toContain("/tra-cuu-don/xac-thuc?token=***");
    expect(scrubPii("lỗi https://x.vn/a?b=1&TOKEN=abc123&c=2")).toBe("lỗi https://x.vn/a?b=1&TOKEN=***&c=2");
  });

  it("không che nhầm thông điệp thường (tên miền, mã lỗi ngắn)", () => {
    expect(scrubPii("ESP 422 smtp.example.com từ chối")).toBe("ESP 422 smtp.example.com từ chối");
  });
});

/**
 * ReDoS (review T-149 🟢2): thông điệp lỗi adapter không giới hạn độ dài; mẫu token/email O(n²) trên chuỗi dài không có
 * `.`/`@` — bản cũ (regex trước, cắt sau) mất ~10 s với 100 KB. Đo bằng CPU time của tiến trình; trần 50 ms/lần.
 */
describe("scrubPii — đầu vào đối nghịch dài (chống ReDoS)", () => {
  const N = 100_000;
  const cases: Array<[string, string]> = [
    ["chữ dài không dấu chấm", "a".repeat(N)],
    ["chữ dài rồi một dấu chấm", `${"a".repeat(N)}.`],
    ["chữ dài không @", `${"b".repeat(N)}@`],
    ["nhiều @", "a@".repeat(N / 2)],
    ["số dài", "1 ".repeat(N / 2)],
    ["token= lặp", "?token=".repeat(N / 7)],
  ];
  it.each(cases)("%s → xong < 50 ms CPU, kết quả ≤ 300 ký tự", (_name, input) => {
    expectLinearOrUnder(50, input, scrubPii);
    expect(scrubPii(input).length).toBeLessThanOrEqual(300);
  });
});
