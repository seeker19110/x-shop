import type { MedusaContainer } from "@medusajs/framework/types";
import { resetShutdownStateForTest, shutdownState } from "../../lib/lifecycle/shutdown";
import codConfirmTimeoutJob from "../cod-confirm-timeout";
import expireHoldsJob from "../expire-holds";
import orderAccessCleanupJob from "../order-access-cleanup";
import outboxDispatchJob from "../outbox-dispatch";
import reconcileAttemptsJob from "../reconcile-attempts";

/**
 * T-171/D-081: mọi job định kỳ còn lại trả về ngay khi tiến trình đang tắt (cùng gốc lỗi với job catalog, T-094):
 * Medusa chờ job đang chạy xong trước khi đóng pool nên một tick rơi vào lúc tắt có thể kéo tiến trình vượt trần tắt êm.
 */

const mockCod = jest.fn(async () => undefined);
const mockExpire = jest.fn(async () => ({
  cancelled: [],
  confirmed: [],
  unknown: [],
  deferred: [],
  skipped: [],
}));
const mockDispatch = jest.fn(async () => undefined);
const mockReconcile = jest.fn(async () => ({ compensated: [] as string[] }));
const mockPurge = jest.fn(async () => ({ counters: 0, redemptions: 0 }));

jest.mock("../../lib/checkout/jobs", () => ({
  codConfirmTimeout: (...a: unknown[]) => mockCod(...(a as [])),
  expireHolds: (...a: unknown[]) => mockExpire(...(a as [])),
  dispatchOutbox: (...a: unknown[]) => mockDispatch(...(a as [])),
  reconcileAttempts: (...a: unknown[]) => mockReconcile(...(a as [])),
}));

const mockResolve = jest.fn((key: string) =>
  key === "checkout"
    ? { purgeOrderAccessRecords: (...a: unknown[]) => mockPurge(...(a as [])) }
    : { info: jest.fn(), warn: jest.fn() },
);
const container = { resolve: (k: string) => mockResolve(k) } as unknown as MedusaContainer;

const all = () => [mockCod, mockExpire, mockDispatch, mockReconcile, mockPurge];

async function runAll() {
  await codConfirmTimeoutJob(container);
  await expireHoldsJob(container);
  await orderAccessCleanupJob(container);
  await outboxDispatchJob(container);
  await reconcileAttemptsJob(container);
}

beforeEach(() => {
  resetShutdownStateForTest();
  jest.clearAllMocks();
});
afterAll(() => resetShutdownStateForTest());

describe("job checkout/dọn dẹp khi đang tắt", () => {
  it("bình thường: mỗi job gọi đúng hàm thật (đã mock) một lần", async () => {
    await runAll();
    for (const m of all()) expect(m).toHaveBeenCalledTimes(1);
  });

  it("đang tắt: không gọi gì (kể cả không resolve container)", async () => {
    shutdownState().draining = true;
    await runAll();
    for (const m of all()) expect(m).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
