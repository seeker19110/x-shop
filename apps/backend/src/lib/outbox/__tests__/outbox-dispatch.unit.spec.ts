import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { OutboxClaim } from "../../../modules/checkout/service";
import { dispatchOutbox, type OutboxHandler } from "../../checkout/jobs";
import { CheckoutError } from "../../checkout/errors";
import { GhnError } from "../../shipping/ghn-client";
import { ShippingError } from "../../shipping/shipments";

/**
 * T-093 (review): `dispatchOutbox` với service giả — phân loại lỗi nội bộ đúng (lỗi tạm của dự án không vào dead), và
 * `next_attempt_at` tính từ LÚC LỖI khi không tiêm `now` (lượt dài vẫn tôn trọng Retry-After).
 */
interface Failed {
  id: string;
  error: string;
  next: Date | null;
}

function fakeContainer(events: OutboxClaim[]) {
  const queue = [...events];
  const failed: Failed[] = [];
  const sent: string[] = [];
  const exceptions: Array<Record<string, unknown>> = [];
  const service = {
    claimDueOutbox: async () => queue.shift() ?? null,
    markOutboxSent: async (id: string) => {
      sent.push(id);
    },
    markOutboxFailed: async (id: string, error: string, next: Date | null) => {
      failed.push({ id, error, next });
    },
    openOpsException: async (input: Record<string, unknown>) => {
      exceptions.push(input);
      return true;
    },
  };
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const container = {
    resolve: (key: string) => {
      if (key === CHECKOUT_MODULE) return service;
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      throw new Error(`không có ${key}`);
    },
  } as unknown as MedusaContainer;
  return { container, failed, sent, exceptions };
}

const event = (i: number, type = "test.x"): OutboxClaim => ({
  id: `obx_${i}`,
  event_key: `${type}:${i}`,
  aggregate_id: "agg_1",
  type,
  payload: {},
  attempts: 0,
});

describe("dispatchOutbox — next_attempt_at tính từ lúc lỗi", () => {
  it("không tiêm now: lượt bắt đầu T0, lỗi xảy ra T0+300 s với Retry-After 600 s → hẹn T0+900 s", async () => {
    const t0 = Date.parse("2026-10-27T08:00:00.000Z");
    let calls = 0;
    // Lần đọc đồng hồ đầu = đầu lượt; các lần sau = lúc lỗi (handler đã chạy 5 phút).
    const clock = () => new Date(calls++ === 0 ? t0 : t0 + 300_000);
    const f = fakeContainer([event(1)]);
    const handlers: Record<string, OutboxHandler> = {
      "test.x": async () => {
        throw Object.assign(new Error("ESP 429"), { status: 429, retryAfterMs: 600_000 });
      },
    };
    const r = await dispatchOutbox(f.container, { handlers, clock, random: () => 0 });
    expect(r.retried).toEqual(["test.x:1"]);
    expect(f.failed[0]!.next!.getTime()).toBe(t0 + 300_000 + 600_000);
  });

  it("tiêm now: mốc cố định (tương thích test cũ), không đọc đồng hồ", async () => {
    const now = new Date("2026-10-27T08:00:00.000Z");
    const f = fakeContainer([event(1)]);
    const clock = jest.fn(() => new Date(0));
    await dispatchOutbox(f.container, {
      now,
      clock,
      random: () => 0,
      handlers: {
        "test.x": async () => {
          throw new Error("SMTP 503");
        },
      },
    });
    expect(clock).not.toHaveBeenCalled();
    expect(f.failed[0]!.next!.getTime()).toBe(now.getTime() + 5_000);
  });
});

describe("dispatchOutbox — lỗi tạm của dự án không vào dead (review T-093)", () => {
  const cases: Array<[string, () => Error, "retried" | "dead"]> = [
    ["CheckoutError BUSY_RETRY", () => new CheckoutError("BUSY_RETRY"), "retried"],
    ["CheckoutError PAYMENT_PENDING", () => new CheckoutError("PAYMENT_PENDING"), "retried"],
    ["ShippingError BUSY_RETRY", () => new ShippingError("BUSY_RETRY", "x"), "retried"],
    ["GhnError unavailable 401", () => new GhnError("unavailable", "x", { status: 401 }), "retried"],
    [
      "GhnError 403 bọc qua cause",
      () => new Error("bọc", { cause: new GhnError("unavailable", "x", { status: 403 }) }),
      "retried",
    ],
    ["CheckoutError VALIDATION", () => new CheckoutError("VALIDATION"), "dead"],
    ["ShippingError PROVIDER_REJECTED", () => new ShippingError("PROVIDER_REJECTED", "x"), "dead"],
    [
      "HTTP bên ngoài 422 bọc qua cause",
      () => new Error("bọc", { cause: Object.assign(new Error("ESP"), { status: 422 }) }),
      "dead",
    ],
  ];
  it.each(cases)("%s → %s", async (_name, make, expected) => {
    const f = fakeContainer([event(1)]);
    const r = await dispatchOutbox(f.container, {
      now: new Date("2026-10-27T08:00:00.000Z"),
      handlers: {
        "test.x": async () => {
          throw make();
        },
      },
    });
    expect(r[expected]).toEqual(["test.x:1"]);
    if (expected === "dead") {
      expect(f.failed[0]!.next).toBeNull();
      expect(f.exceptions[0]!.detail).toMatchObject({ dead_reason: "permanent_error", attempts: 1 });
    } else {
      expect(f.failed[0]!.next).not.toBeNull();
      expect(f.exceptions).toEqual([]);
    }
  });

  it("đồng thời: hai lượt song song trên hai hàng đợi giả độc lập — mỗi sự kiện xử lý đúng một lần", async () => {
    const f = fakeContainer([event(1), event(2), event(3), event(4)]);
    const seen: string[] = [];
    const handlers: Record<string, OutboxHandler> = {
      "test.x": async (_c, e) => {
        seen.push(e.event_key);
        await new Promise((res) => setTimeout(res, 5));
        if (e.event_key.endsWith(":2")) throw new CheckoutError("BUSY_RETRY");
      },
    };
    const now = new Date("2026-10-27T08:00:00.000Z");
    const [a, b] = await Promise.all([
      dispatchOutbox(f.container, { now, handlers }),
      dispatchOutbox(f.container, { now, handlers }),
    ]);
    expect(seen.sort()).toEqual(["test.x:1", "test.x:2", "test.x:3", "test.x:4"]);
    expect([...a.retried, ...b.retried]).toEqual(["test.x:2"]);
    expect([...a.sent, ...b.sent].sort()).toEqual(["test.x:1", "test.x:3", "test.x:4"]);
    expect([...a.dead, ...b.dead]).toEqual([]);
  });
});
