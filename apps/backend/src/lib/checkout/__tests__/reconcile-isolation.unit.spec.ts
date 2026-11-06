import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import { resetShutdownStateForTest } from "../../lifecycle/shutdown";
import { CheckoutError } from "../errors";
import { RECONCILE_RETRY_DELAY_MS, reconcileAttempts } from "../jobs";
import type { LockingLike } from "../locks";

/**
 * Review T-185: lỗi bù trừ của MỘT attempt (vd hàng rào tồn từ chối nhả giữ) không được dừng cả lượt reconcile — trước
 * đây lỗi ném ra khỏi vòng lặp, attempt lỗi đứng đầu `ORDER BY lease_until` mãi và chặn mọi attempt sau nó. Nay: ghi log,
 * hẹn lại (`deferStaleAttempt`), làm tiếp attempt khác. Mất hạ tầng khóa vẫn dừng cả lượt như cũ.
 */

class FreeLocking implements LockingLike {
  async acquire(): Promise<void> {}
  async release(): Promise<boolean> {
    return true;
  }
}

const GUARD_ERROR = Object.assign(
  new Error("COMMIT; - x_inventory_level_stock_guard: inventory_level ilev_1 reserved_quantity=-1"),
  { code: "23514", constraint: "x_inventory_level_stock_guard" },
);

function setup(opts: { failOn: string; error?: unknown }) {
  const errors: string[] = [];
  const service = {
    listStaleAttempts: jest.fn(async () => [
      { id: "att_bad", cart_id: "cart_bad" },
      { id: "att_ok", cart_id: "cart_ok" },
    ]),
    claimStaleAttempt: jest.fn(async () => true),
    compensateAttemptRecords: jest.fn(async () => undefined),
    deferStaleAttempt: jest.fn(async () => true),
  };
  const pg = {
    raw: jest.fn(async (_sql: string, [attemptId]: [string]) => {
      if (attemptId === opts.failOn) throw opts.error ?? GUARD_ERROR;
      return { rows: [] };
    }),
  };
  const container = {
    resolve: (key: string) => {
      if (key === CHECKOUT_MODULE) return service;
      if (key === ContainerRegistrationKeys.LOGGER)
        return { info: () => undefined, warn: () => undefined, error: (m: string) => errors.push(m) };
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return pg;
      if (key === Modules.LOCKING) return new FreeLocking();
      if (key === Modules.INVENTORY) return { listReservationItems: async () => [] };
      throw new Error(`không có ${key}`);
    },
  } as unknown as MedusaContainer;
  return { container, service, errors };
}

beforeEach(() => resetShutdownStateForTest());

describe("reconcileAttempts — cô lập lỗi theo attempt (review T-185)", () => {
  it("attempt đầu lỗi (hàng rào tồn) → ghi log + hẹn lại sau RECONCILE_RETRY_DELAY_MS; attempt sau vẫn được bù trừ", async () => {
    const { container, service, errors } = setup({ failOn: "att_bad" });
    const now = new Date("2026-10-28T10:00:00Z");
    const r = await reconcileAttempts(container, { now });
    expect(r).toMatchObject({ compensated: ["att_ok"], failed: ["att_bad"], skipped: [] });
    expect(service.deferStaleAttempt).toHaveBeenCalledTimes(1);
    expect(service.deferStaleAttempt).toHaveBeenCalledWith(
      "att_bad",
      new Date(now.getTime() + RECONCILE_RETRY_DELAY_MS),
    );
    expect(service.compensateAttemptRecords).toHaveBeenCalledWith("att_ok", []);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("att_bad");
  });

  it("hẹn lại cũng lỗi → vẫn làm tiếp, không ném", async () => {
    const { container, service } = setup({ failOn: "att_bad" });
    service.deferStaleAttempt.mockRejectedValueOnce(new Error("db"));
    const r = await reconcileAttempts(container, { now: new Date() });
    expect(r).toMatchObject({ compensated: ["att_ok"], failed: ["att_bad"] });
  });

  it("mất hạ tầng khóa (LOCK_UNAVAILABLE) → dừng cả lượt như trước, không hẹn lại", async () => {
    const { container, service } = setup({ failOn: "att_bad", error: new CheckoutError("LOCK_UNAVAILABLE") });
    await expect(reconcileAttempts(container, { now: new Date() })).rejects.toMatchObject({
      code: "LOCK_UNAVAILABLE",
    });
    expect(service.deferStaleAttempt).not.toHaveBeenCalled();
  });
});
