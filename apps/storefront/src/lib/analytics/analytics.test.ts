import { findPii, looksLikePii, type AnalyticsEvent } from "./schema";
import { resetAnalyticsForTests, setAnalyticsConsent, track } from "./track";

const layer = () => (window.dataLayer ?? []) as AnalyticsEvent[];

beforeEach(() => {
  window.dataLayer = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetAnalyticsForTests();
});
afterEach(() => vi.unstubAllEnvs());

describe("analytics: track() mặc định đẩy vào dataLayer", () => {
  it("phủ version + currency VND; giá trị nguyên; chỉ id/sku", () => {
    expect(
      track({
        event: "add_to_cart",
        value: 450000,
        items: [{ item_id: "ao-so-mi", sku: "AOSM-DEN-M", quantity: 1, price: 450000 }],
      }),
    ).toBe(true);
    expect(layer()).toEqual([
      {
        v: 1,
        currency: "VND",
        event: "add_to_cart",
        value: 450000,
        items: [{ item_id: "ao-so-mi", sku: "AOSM-DEN-M", quantity: 1, price: 450000 }],
      },
    ]);
  });

  it("bỏ (không ném) khi tiền không nguyên / âm; sự kiện đơn thiếu order_id hoặc value", () => {
    expect(track({ event: "add_to_cart", value: 1.5 })).toBe(false);
    expect(track({ event: "add_to_cart", value: -1 })).toBe(false);
    expect(track({ event: "order_placed", value: 1000 })).toBe(false);
    expect(track({ event: "refund", order_id: "XS-ABC123" })).toBe(false);
    expect(track({ event: "add_to_cart", value: 0 })).toBe(true); // 0 hợp lệ, khác thiếu
    expect(layer()).toHaveLength(1);
  });

  it("bỏ khi payload chứa email / SĐT / địa chỉ", () => {
    expect(track({ event: "view_item", items: [{ item_id: "a@example.test" }] })).toBe(false);
    expect(track({ event: "view_item", items: [{ item_id: "x", sku: "0912345678" }] })).toBe(false);
    expect(track({ event: "view_item", list_id: "12 Phố Điện Biên Phủ" } as never)).toBe(false);
    expect(layer()).toHaveLength(0);
  });
});

describe("analytics: purchase dedupe theo order_id", () => {
  it("lần 2 cùng order_id bị bỏ; order_id khác vẫn qua; khóa localStorage không chứa PII", () => {
    const p = { event: "purchase", order_id: "XS-ABC123", value: 1330000 } as const;
    expect(track(p)).toBe(true);
    expect(track(p)).toBe(false);
    expect(track({ ...p, order_id: "XS-ZZZ999" })).toBe(true);
    expect(layer().filter((e) => e.event === "purchase")).toHaveLength(2);
    const keys = Object.keys(window.localStorage);
    expect(keys.sort()).toEqual(["xs_purchase_XS-ABC123", "xs_purchase_XS-ZZZ999"]);
    expect(keys.some((k) => looksLikePii(k))).toBe(false);
  });

  it("bền qua phiên trình duyệt: mất sessionStorage + bộ nhớ (tab mới) vẫn không bắn lại", () => {
    const p = { event: "purchase", order_id: "XS-BEN001", value: 10 } as const;
    expect(track(p)).toBe(true);
    window.sessionStorage.clear();
    resetAnalyticsForTests();
    expect(track(p)).toBe(false);
  });

  it("localStorage hỏng → dùng sessionStorage", () => {
    const real = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      k: string,
    ) {
      if (this === window.localStorage) throw new Error("denied");
      return real.call(this, k);
    });
    const p = { event: "purchase", order_id: "XS-SES001", value: 5 } as const;
    expect(track(p)).toBe(true);
    expect(track(p)).toBe(false);
    expect(window.sessionStorage.getItem("xs_purchase_XS-SES001")).toBe("1");
    spy.mockRestore();
  });

  it("order_placed không bị dedupe (sự kiện vận hành riêng)", () => {
    const e = { event: "order_placed", order_id: "XS-ABC123", value: 1 } as const;
    expect(track(e)).toBe(true);
    expect(track(e)).toBe(true);
  });

  it("mọi kho hỏng → vẫn dedupe bằng bộ nhớ", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const p = { event: "purchase", order_id: "XS-MEM001", value: 5 } as const;
    expect(track(p)).toBe(true);
    expect(track(p)).toBe(false);
    spy.mockRestore();
  });
});

describe("analytics: sendBeacon chỉ khi cấu hình + đồng ý", () => {
  const beacon = vi.fn(() => true);
  beforeEach(() => {
    beacon.mockClear();
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
  });

  it("mặc định (không cấu hình): không beacon dù đã đồng ý", () => {
    setAnalyticsConsent(true);
    track({ event: "view_item", items: [{ item_id: "a" }] });
    expect(beacon).not.toHaveBeenCalled();
  });

  it("transport=beacon nhưng chưa đồng ý: không gửi; đồng ý rồi: gửi tới /api/analytics", () => {
    vi.stubEnv("NEXT_PUBLIC_ANALYTICS_TRANSPORT", "beacon");
    track({ event: "view_item", items: [{ item_id: "a" }] });
    expect(beacon).not.toHaveBeenCalled();
    setAnalyticsConsent(true);
    track({ event: "view_item", items: [{ item_id: "a" }] });
    expect(beacon).toHaveBeenCalledTimes(1);
    expect((beacon.mock.calls[0] as unknown as [string])[0]).toBe("/api/analytics");
    setAnalyticsConsent(false);
    track({ event: "view_item", items: [{ item_id: "a" }] });
    expect(beacon).toHaveBeenCalledTimes(1);
  });
});

describe("analytics: bộ quét PII", () => {
  it.each([
    ["email", "khach.hang@example.com"],
    ["SĐT có dấu cách", "0912 345 678"],
    ["SĐT +84", "+84 912 345 678"],
    ["địa chỉ số nhà", "12/3 Điện Biên Phủ"],
    ["địa chỉ từ khóa", "Phường Ba Đình, Hà Nội"],
    ["địa chỉ không dấu", "duong Nguyen Hue"],
  ])("bắt %s", (_n, s) => expect(looksLikePii(s)).toBe(true));

  it.each(["ao-so-mi-lua", "AOSM-DEN-M", "XS-ABC123", "quan-tay-so-mi", "tim-kiem", "450000", "SKU-0001"])(
    "không bắt nhầm định danh hợp lệ %s",
    (s) => expect(looksLikePii(s)).toBe(false),
  );

  it("quét sâu cả khóa và mảng lồng", () => {
    expect(findPii({ a: [{ b: "x@example.test" }] })).toBe("$.a[0].b");
    expect(findPii({ "0912345678": 1 })).toBe("$.0912345678");
    expect(findPii({ a: { b: ["ok"] } })).toBeNull();
  });
});
