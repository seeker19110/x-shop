// @vitest-environment node
import { EVENT_NAMES } from "../../../lib/analytics/schema";
import { analyticsStats, resetAnalyticsStats } from "../../../lib/analytics/stats";
import { validateEvent } from "../../../lib/analytics/validate";
import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/analytics", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const base = { v: 1, currency: "VND" };
const ok = {
  ...base,
  event: "add_to_cart",
  value: 450000,
  items: [{ item_id: "ao-so-mi", sku: "A-1", quantity: 1 }],
};

beforeEach(() => resetAnalyticsStats());

describe("analytics: POST /api/analytics", () => {
  it("hợp lệ → 204, thân rỗng; chỉ đếm tổng hợp", async () => {
    const r = await post(ok);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    expect(analyticsStats()).toEqual({ seen: 1, rejected: 0, byEvent: { add_to_cart: 1 } });
  });

  it("mọi tên sự kiện trong đặc tả được chấp nhận (sự kiện đơn kèm order_id + value)", async () => {
    for (const event of EVENT_NAMES) {
      const r = await post({ ...base, event, order_id: "XS-ABC123", value: 100, items: [{ item_id: "a" }] });
      expect(r.status, event).toBe(204);
    }
  });

  it("loại trường lạ khỏi sự kiện đã validate (không lưu được gì ngoài schema)", () => {
    const r = validateEvent({
      ...ok,
      user_agent: "x",
      note: "tuỳ ý",
      items: [{ item_id: "a", title: "Áo" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.event).sort()).toEqual(["currency", "event", "items", "v", "value"]);
      expect(r.event.items).toEqual([{ item_id: "a" }]);
    }
  });

  it.each([
    ["email ở trường lạ", { ...ok, contact: "khach@example.com" }],
    ["email ở item_id", { ...ok, items: [{ item_id: "khach@example.com" }] }],
    ["SĐT ở sku", { ...ok, items: [{ item_id: "a", sku: "0912345678" }] }],
    ["SĐT có dấu cách ở trường lạ", { ...ok, phone: "0912 345 678" }],
    ["địa chỉ ở trường lạ", { ...ok, shipping: "12 Phố Điện Biên Phủ, Phường Ba Đình" }],
    ["địa chỉ ở list_id", { ...ok, list_id: "so 5 duong Nguyen Hue" }],
    ["địa chỉ ở khóa", { ...ok, "phường Ba Đình": 1 }],
  ])("từ chối PII: %s → 400 PII_REJECTED", async (_n, body) => {
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ code: "PII_REJECTED" });
    expect(analyticsStats().rejected).toBe(1);
  });

  it.each([
    ["JSON hỏng", "{not json"],
    ["rỗng", ""],
    ["không phải object", "[1,2]"],
    ["sai version", { ...ok, v: 2 }],
    ["sai tiền tệ", { ...ok, currency: "USD" }],
    ["sự kiện lạ", { ...ok, event: "page_view" }],
    ["tiền không nguyên", { ...ok, value: 99.5 }],
    ["tiền âm", { ...ok, value: -1 }],
    ["purchase thiếu order_id", { ...base, event: "purchase", value: 1 }],
    ["purchase thiếu value", { ...base, event: "purchase", order_id: "XS-ABC123" }],
    ["item_id có khoảng trắng", { ...ok, items: [{ item_id: "ao so mi" }] }],
    ["quá 50 mục", { ...ok, items: Array.from({ length: 51 }, (_, i) => ({ item_id: `p${i}` })) }],
    ["payment_type lạ", { ...ok, payment_type: "bitcoin" }],
  ])("từ chối: %s → 400", async (_n, body) => {
    expect((await post(body)).status).toBe(400);
  });

  it("thân quá lớn → 413", async () => {
    expect((await post({ ...ok, pad: "x".repeat(9000) })).status).toBe(413);
  });

  it("value = 0 hợp lệ (khác thiếu)", async () => {
    expect((await post({ ...ok, value: 0 })).status).toBe(204);
  });
});
