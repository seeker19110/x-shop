import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import type { OutboxClaim } from "../../../modules/checkout/service";
import { fakeOutboxDb } from "../../outbox/__tests__/fake-outbox-store";
import { resetShutdownStateForTest, shutdownState } from "../../lifecycle/shutdown";
import { acquireOrdered } from "../locks";
import { codConfirmTimeout, dispatchOutbox, expireHolds, reconcileAttempts } from "../jobs";

/**
 * T-172/D-081: ba vòng lặp job kiểm `isDraining()` ở RANH GIỚI giữa hai đơn vị — đơn vị đang xử lý chạy trọn, đơn vị sau
 * không bị đụng (không claim, không khóa, không gọi cổng), `stopped: "draining"`; không tắt thì chạy đủ như cũ.
 */

const mockQueryAndProcess = jest.fn();
jest.mock("../recheck", () => ({
  queryAndProcess: (...a: unknown[]) => mockQueryAndProcess(...a),
}));
jest.mock("../locks", () => ({
  ...jest.requireActual("../locks"),
  acquireOrdered: jest.fn(async () => undefined),
  releaseOwnedOrWarn: jest.fn(async () => undefined),
}));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function containerOf(service: Record<string, unknown>, extra: Record<string, unknown> = {}): MedusaContainer {
  return {
    resolve: (key: string) => {
      if (key === CHECKOUT_MODULE) return service;
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      if (key in extra) return extra[key];
      throw new Error(`không có ${key}`);
    },
  } as unknown as MedusaContainer;
}

beforeEach(() => {
  resetShutdownStateForTest();
  jest.clearAllMocks();
});
afterAll(() => resetShutdownStateForTest());

const ids = ["ord_1", "ord_2", "ord_3"];

const backlog = jest.fn(async () => 0);

function expireFixture(onFirstDone: () => void) {
  const touched: string[] = [];
  const finance = (orderId: string) => ({
    order_id: orderId,
    state: "awaiting_payment",
    hold_expires_at: new Date(0),
    next_check_at: null,
    hold_check_attempts: 0,
    total: 100_000,
  });
  const service = {
    listExpiredHoldOrderIds: async () => ids,
    readJobBreaker: async () => null,
    listOrderFinances: async ({ order_id }: { order_id: string }) => [finance(order_id)],
    cancelExpiredOrder: async (orderId: string) => {
      touched.push(orderId);
      if (touched.length === 1) onFirstDone();
      return true;
    },
    countUnknownHoldBacklog: backlog,
  };
  mockQueryAndProcess.mockResolvedValue({ outcome: "not_paid" });
  const container = containerOf(service, {
    [Modules.LOCKING]: {},
    [Modules.ORDER]: { retrieveOrder: async () => ({ status: "canceled" }) },
  });
  return { container, touched };
}

describe("expireHolds — dừng khi đang tắt", () => {
  it("bật cờ tắt sau đơn 1/3: chỉ đơn 1 được xử lý, đơn 2-3 không bị đụng, stopped = draining", async () => {
    const f = expireFixture(() => {
      shutdownState().draining = true;
    });
    const r = await expireHolds(f.container, { now: new Date() });
    expect(r.cancelled).toEqual(["ord_1"]);
    expect(f.touched).toEqual(["ord_1"]);
    expect(mockQueryAndProcess).toHaveBeenCalledTimes(1);
    expect(acquireOrdered).toHaveBeenCalledTimes(1);
    expect(backlog).not.toHaveBeenCalled();
    expect(r.stopped).toBe("draining");
  });

  it("đã tắt từ đầu: không đơn nào được xử lý", async () => {
    shutdownState().draining = true;
    const f = expireFixture(() => undefined);
    const r = await expireHolds(f.container, { now: new Date() });
    expect(r.cancelled).toEqual([]);
    expect(mockQueryAndProcess).not.toHaveBeenCalled();
    expect(acquireOrdered).not.toHaveBeenCalled();
    expect(backlog).not.toHaveBeenCalled();
    expect(r.stopped).toBe("draining");
  });

  it("không tắt: chạy đủ 3 đơn, stopped = null", async () => {
    const f = expireFixture(() => undefined);
    const r = await expireHolds(f.container, { now: new Date() });
    expect(r.cancelled).toEqual(ids);
    expect(acquireOrdered).toHaveBeenCalledTimes(3);
    expect(backlog).toHaveBeenCalledTimes(1);
    expect(r.stopped).toBeNull();
  });
});

describe("reconcileAttempts — dừng khi đang tắt", () => {
  function fixture(onFirstDone: () => void) {
    const claimed: string[] = [];
    const service = {
      listStaleAttempts: async () => ids.map((id) => ({ id: `att_${id}`, cart_id: `cart_${id}` })),
      claimStaleAttempt: async (id: string) => {
        claimed.push(id);
        return true;
      },
      compensateAttemptRecords: async () => {
        if (claimed.length === 1) onFirstDone();
      },
    };
    const container = containerOf(service, {
      [Modules.LOCKING]: {},
      [ContainerRegistrationKeys.PG_CONNECTION]: { raw: async () => ({ rows: [] }) },
      [Modules.INVENTORY]: { listReservationItems: async () => [] },
    });
    return { container, claimed };
  }

  it("bật cờ tắt sau attempt 1/3: chỉ attempt 1 được claim và bù trừ, stopped = draining", async () => {
    const f = fixture(() => {
      shutdownState().draining = true;
    });
    const r = await reconcileAttempts(f.container, { now: new Date() });
    expect(r.compensated).toEqual(["att_ord_1"]);
    expect(f.claimed).toEqual(["att_ord_1"]);
    expect(acquireOrdered).toHaveBeenCalledTimes(1);
    expect(r.stopped).toBe("draining");
  });

  it("không tắt: bù trừ đủ 3 attempt, stopped = null", async () => {
    const f = fixture(() => undefined);
    const r = await reconcileAttempts(f.container, { now: new Date() });
    expect(r.compensated).toHaveLength(3);
    expect(r.stopped).toBeNull();
  });
});

describe("dispatchOutbox — dừng khi đang tắt", () => {
  const event = (i: number): OutboxClaim => ({
    id: `obx_${i}`,
    event_key: `test.x:${i}`,
    aggregate_id: "agg_1",
    type: "test.x",
    payload: {},
    attempts: 0,
  });

  function fixture() {
    const queue = [1, 2, 3].map(event);
    const { service: shared } = fakeOutboxDb([]);
    let claims = 0;
    const sent: string[] = [];
    const service = {
      ...shared,
      claimDueOutbox: async () => {
        claims++;
        return queue.shift() ?? null;
      },
      markOutboxSent: async (id: string) => {
        sent.push(id);
      },
    };
    return { container: containerOf(service), queue, sent, claims: () => claims };
  }

  it("bật cờ tắt sau sự kiện 1/3: chỉ sự kiện 1 được nhận và gửi, 2-3 còn nguyên trong hàng, stopped = draining", async () => {
    const f = fixture();
    const handlers = {
      "test.x": async () => {
        shutdownState().draining = true;
      },
    };
    const r = await dispatchOutbox(f.container, { handlers });
    expect(r.sent).toEqual(["test.x:1"]);
    expect(f.sent).toEqual(["obx_1"]);
    expect(f.claims()).toBe(1);
    expect(f.queue.map((e) => e.id)).toEqual(["obx_2", "obx_3"]);
    expect(r.stopped).toBe("draining");
  });

  it("không tắt: gửi đủ 3, stopped = null", async () => {
    const f = fixture();
    const r = await dispatchOutbox(f.container, { handlers: { "test.x": async () => undefined } });
    expect(r.sent).toHaveLength(3);
    expect(r.stopped).toBeNull();
  });
});

describe("codConfirmTimeout — dừng khi đang tắt", () => {
  function fixture() {
    const opened: string[] = [];
    const service = {
      listOverdueCodOrders: async () => ids.map((id) => ({ order_id: id, display_ref: `#${id}` })),
      openOpsException: async (input: { order_id: string }) => {
        opened.push(input.order_id);
        if (opened.length === 1 && stopAfterFirst) shutdownState().draining = true;
        return true;
      },
    };
    return { container: containerOf(service), opened };
  }
  let stopAfterFirst = false;
  beforeEach(() => {
    stopAfterFirst = false;
  });

  it("bật cờ tắt sau đơn 1/3: chỉ đơn 1 có ngoại lệ, stopped = draining", async () => {
    stopAfterFirst = true;
    const f = fixture();
    const r = await codConfirmTimeout(f.container, { now: new Date() });
    expect(r).toEqual({ opened: ["ord_1"], stopped: "draining" });
    expect(f.opened).toEqual(["ord_1"]);
  });

  it("không tắt: mở đủ 3, stopped = null", async () => {
    const f = fixture();
    const r = await codConfirmTimeout(f.container, { now: new Date() });
    expect(r).toEqual({ opened: ids, stopped: null });
  });
});
