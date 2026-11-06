import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { CHECKOUT_MODULE } from "../../../modules/checkout";
import { resetShutdownStateForTest, shutdownState } from "../../lifecycle/shutdown";
import { readCheckoutError } from "../errors";
import { RELEASE_LOCK_ROUNDS, withInventoryItemLocks } from "../inventory-locks";
import { reconcileAttempts } from "../jobs";
import { activeLeaseCount, lockKeys, type LockingLike } from "../locks";

/**
 * T-224 — đường nhả giữ hàng lấy khóa `inventory_item:<id>` (lib/checkout/inventory-locks.ts): lấy theo thứ tự tăng dần,
 * đọc lại tập SKU dưới khóa, nhả khóa cả khi `fn` lỗi, quá số vòng → BUSY_RETRY, đang tắt (job) → thôi chờ. reconcileAttempts
 * giữ `cart:` rồi mới lấy `inventory_item:` (thứ tự toàn cục), khóa tồn bận → attempt `skipped` (không hẹn 5 phút).
 */

/** Nhật ký chung: khóa (+/-) và lời gọi workflow native — để kiểm workflow chạy KHI đang giữ khóa nào. */
const events: string[] = [];
jest.mock("@medusajs/medusa/core-flows", () => ({
  deleteReservationsWorkflow: () => ({
    run: async ({ input }: { input: { ids: string[] } }) =>
      void events.push(`run:delete(${input.ids.join(",")})`),
  }),
  cancelOrderWorkflow: () => ({
    run: async ({ input }: { input: { order_id: string } }) =>
      void events.push(`run:cancel(${input.order_id})`),
  }),
}));

class RecordingLocking implements LockingLike {
  readonly owners = new Map<string, string>();
  readonly log: string[] = [];
  async acquire(keys: string | string[], args: { ownerId?: string | null } = {}): Promise<void> {
    const owner = args.ownerId ?? "*";
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const cur = this.owners.get(key);
      if (cur !== undefined && cur !== owner) throw new Error(`Failed to acquire lock for key "${key}"`);
      if (cur === undefined && owner !== "OTHER") {
        this.log.push(`+${key}`);
        events.push(`+${key}`);
      }
      this.owners.set(key, owner);
    }
  }
  async release(keys: string | string[], args: { ownerId?: string | null } = {}): Promise<boolean> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.owners.get(key) === (args.ownerId ?? "*")) {
        this.owners.delete(key);
        if (args.ownerId !== "OTHER") {
          this.log.push(`-${key}`);
          events.push(`-${key}`);
        }
      }
    }
    return true;
  }
  /** Khóa đang giữ (không tính khóa giả lập của chủ khác). */
  held(): string[] {
    return [...this.owners.entries()].filter(([, o]) => o !== "OTHER").map(([k]) => k);
  }
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function containerOf(locking: LockingLike, extra: Record<string, unknown> = {}): MedusaContainer {
  return {
    resolve: (key: string) => {
      if (key === Modules.LOCKING) return locking;
      if (key === ContainerRegistrationKeys.LOGGER) return logger;
      if (key in extra) return extra[key];
      throw new Error(`không có ${key}`);
    },
  } as unknown as MedusaContainer;
}

const inv = (id: string) => lockKeys.inventoryItem(id);
const opts = { label: "test" };

beforeEach(() => {
  resetShutdownStateForTest();
  events.length = 0;
});
afterEach(() => {
  resetShutdownStateForTest();
  expect(activeLeaseCount()).toBe(0);
});

describe("withInventoryItemLocks (T-224)", () => {
  it("không có reservation → chạy fn, không lấy khóa nào", async () => {
    const locking = new RecordingLocking();
    const fn = jest.fn(async () => "done");
    await expect(withInventoryItemLocks(containerOf(locking), async () => [], fn, opts)).resolves.toBe(
      "done",
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(locking.log).toEqual([]);
  });

  it("lấy khóa tăng dần, bỏ trùng; fn chạy KHI đang giữ đủ khóa; xong thì nhả hết", async () => {
    const locking = new RecordingLocking();
    let heldDuringFn: string[] = [];
    await withInventoryItemLocks(
      containerOf(locking),
      async () => ["iitem_b", "iitem_a", "iitem_b"],
      async () => {
        heldDuringFn = locking.held().sort();
      },
      opts,
    );
    expect(heldDuringFn).toEqual([inv("iitem_a"), inv("iitem_b")]);
    expect(locking.log).toEqual([
      `+${inv("iitem_a")}`,
      `+${inv("iitem_b")}`,
      `-${inv("iitem_a")}`,
      `-${inv("iitem_b")}`,
    ]);
    expect(locking.held()).toEqual([]);
  });

  it("fn lỗi → vẫn nhả khóa, ném lỗi gốc", async () => {
    const locking = new RecordingLocking();
    const boom = new Error("23514 drift");
    await expect(
      withInventoryItemLocks(
        containerOf(locking),
        async () => ["iitem_a"],
        async () => {
          throw boom;
        },
        opts,
      ),
    ).rejects.toBe(boom);
    expect(locking.held()).toEqual([]);
  });

  it("đọc lại dưới khóa thấy SKU mới → nhả, lấy lại tập lớn hơn; fn chạy đúng một lần dưới tập đó", async () => {
    const locking = new RecordingLocking();
    const reads = [["iitem_b"], ["iitem_b", "iitem_a"], ["iitem_a", "iitem_b"]];
    let heldDuringFn: string[] = [];
    const fn = jest.fn(async () => {
      heldDuringFn = locking.held().sort();
    });
    await withInventoryItemLocks(containerOf(locking), async () => reads.shift() ?? [], fn, opts);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(heldDuringFn).toEqual([inv("iitem_a"), inv("iitem_b")]);
    // Vòng 2 lấy lại theo thứ tự tăng dần (a trước b) sau khi đã nhả b của vòng 1.
    expect(locking.log.slice(0, 4)).toEqual([
      `+${inv("iitem_b")}`,
      `-${inv("iitem_b")}`,
      `+${inv("iitem_a")}`,
      `+${inv("iitem_b")}`,
    ]);
    expect(locking.held()).toEqual([]);
  });

  it(`tập SKU đổi mãi → BUSY_RETRY sau ${RELEASE_LOCK_ROUNDS} vòng, fn không chạy, không rò khóa`, async () => {
    const locking = new RecordingLocking();
    let n = 0;
    const fn = jest.fn(async () => undefined);
    const err = await withInventoryItemLocks(
      containerOf(locking),
      async () => [`iitem_${n++}`],
      fn,
      opts,
    ).catch((e: unknown) => e);
    expect(readCheckoutError(err)?.code).toBe("BUSY_RETRY");
    expect(fn).not.toHaveBeenCalled();
    expect(locking.held()).toEqual([]);
  });

  it("job (abortWhenDraining) khi đang tắt: khóa tồn bận → BUSY_RETRY ngay, không chờ hết lockWaitMs; HTTP (mặc định) thì vẫn chờ", async () => {
    const locking = new RecordingLocking();
    await locking.acquire(inv("iitem_a"), { ownerId: "OTHER" });
    shutdownState().draining = true;
    const fn = jest.fn(async () => undefined);
    const start = Date.now();
    const err = await withInventoryItemLocks(containerOf(locking), async () => ["iitem_a"], fn, {
      ...opts,
      abortWhenDraining: true,
    }).catch((e: unknown) => e);
    expect(readCheckoutError(err)?.code).toBe("BUSY_RETRY");
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(fn).not.toHaveBeenCalled();

    // Đường HTTP: không thôi chờ vì đang tắt — chủ kia nhả trong lúc chờ thì lấy được và chạy.
    setTimeout(() => void locking.release(inv("iitem_a"), { ownerId: "OTHER" }), 150);
    await withInventoryItemLocks(containerOf(locking), async () => ["iitem_a"], fn, opts);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(locking.held()).toEqual([]);
  });
});

describe("reconcileAttempts dưới khóa tồn (T-224)", () => {
  function setup(locking: RecordingLocking, onClaim: () => void = () => undefined) {
    const service = {
      listStaleAttempts: jest.fn(async () => [{ id: "att_1", cart_id: "cart_1" }]),
      claimStaleAttempt: jest.fn(async () => {
        onClaim();
        return true;
      }),
      compensateAttemptRecords: jest.fn(async () => undefined),
      deferStaleAttempt: jest.fn(async () => true),
    };
    const pg = { raw: jest.fn(async () => ({ rows: [] })) };
    const inventory = {
      listReservationItems: jest.fn(async (filter: { id?: string[]; description?: string }) =>
        filter.description !== undefined
          ? [{ id: "res_1" }]
          : (filter.id ?? []).map((id) => ({ id, inventory_item_id: "iitem_z" })),
      ),
    };
    const container = containerOf(locking, {
      [CHECKOUT_MODULE]: service,
      [ContainerRegistrationKeys.PG_CONNECTION]: pg,
      [Modules.INVENTORY]: inventory,
    });
    return { container, service };
  }

  it("thứ tự khóa toàn cục: cart: → inventory_item:; xoá reservation chạy KHI giữ cả hai; nhả tồn trước giỏ", async () => {
    const locking = new RecordingLocking();
    const { container, service } = setup(locking);
    const r = await reconcileAttempts(container, { now: new Date() });
    expect(r).toMatchObject({ compensated: ["att_1"], skipped: [], failed: [] });
    expect(service.compensateAttemptRecords).toHaveBeenCalledWith("att_1", []);
    expect(events).toEqual([
      `+${lockKeys.cart("cart_1")}`,
      `+${inv("iitem_z")}`,
      "run:delete(res_1)",
      `-${inv("iitem_z")}`,
      `-${lockKeys.cart("cart_1")}`,
    ]);
  });

  it("khóa tồn bận, tiến trình bắt đầu tắt sau khi đã nhận attempt → thôi chờ: attempt skipped (lượt sau làm tiếp), không hẹn lại, không xoá, không bù trừ", async () => {
    const locking = new RecordingLocking();
    await locking.acquire(inv("iitem_z"), { ownerId: "OTHER" });
    // Bật cờ tắt SAU ranh giới attempt (đã giữ cart:, đã claim) — mô phỏng khóa tồn bận quá hạn mà không chờ 15 s.
    const { container, service } = setup(locking, () => (shutdownState().draining = true));
    const r = await reconcileAttempts(container, { now: new Date() });
    expect(r).toMatchObject({ skipped: ["att_1"], compensated: [], failed: [] });
    expect(service.deferStaleAttempt).not.toHaveBeenCalled();
    expect(service.compensateAttemptRecords).not.toHaveBeenCalled();
    expect(events).toEqual([`+${lockKeys.cart("cart_1")}`, `-${lockKeys.cart("cart_1")}`]);
  });
});
