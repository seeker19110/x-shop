import { LogNotificationAdapter, maskRecipient } from "../adapters";
import { renderTemplate, TEMPLATE_NAMES } from "../templates";

const PII = { name: "Trần Thị Bình", email: "binh.tran@example.test", phone: "0987654321" };

describe("mẫu thông báo tiếng Việt", () => {
  it("đủ 4 mẫu, có mã đơn; SMS không dấu; link chỉ có trong mẫu tra cứu", () => {
    for (const name of TEMPLATE_NAMES) {
      const r = renderTemplate(name, {
        name: PII.name,
        display_ref: "XS-ABC234",
        total: 1_330_000,
        link: "https://shop.example.vn/t?x=1",
        tracking_code: "GHN123",
      });
      expect(r.subject).toContain("XS-ABC234");
      expect(r.text).toContain(PII.name);
      expect(r.sms).toMatch(/^[\x20-\x7E]+$/);
      expect(r.text.includes("https://shop.example.vn/t?x=1")).toBe(name === "order.lookup_link");
    }
    expect(
      renderTemplate("order.confirmed", { name: "A", display_ref: "XS-1", total: 1_330_000 }).text,
    ).toContain("1.330.000");
    expect(() => renderTemplate("order.lookup_link", { name: "A", display_ref: "XS-1" })).toThrow();
  });
});

describe("adapter log", () => {
  it("không gửi thật, log chỉ có địa chỉ đã che — không tên, không nội dung", async () => {
    const lines: string[] = [];
    const adapter = new LogNotificationAdapter();
    expect(adapter.live).toBe(false);
    const rendered = renderTemplate("order.placed", { name: PII.name, display_ref: "XS-ABC234", total: 1 });
    for (const [channel, to] of [
      ["email", PII.email],
      ["sms", PII.phone],
    ] as const) {
      await adapter.send(
        { messageKey: "notify:k:email", template: "order.placed", channel, to, ...rendered },
        { logger: { info: (m) => lines.push(m) } },
      );
    }
    const all = lines.join("\n");
    expect(all).toContain(maskRecipient("email", PII.email));
    expect(all).toContain(maskRecipient("sms", PII.phone));
    for (const v of [PII.name, PII.email, PII.phone, rendered.subject]) expect(all).not.toContain(v);
  });
});
