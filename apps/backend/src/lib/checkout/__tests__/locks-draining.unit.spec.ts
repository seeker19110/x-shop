import { CheckoutError } from "../errors";
import { resetShutdownStateForTest, shutdownState } from "../../lifecycle/shutdown";
import { acquireOrdered, activeLeaseCount, releaseOwned, type LockingLike } from "../locks";

/**
 * T-174/D-081: vòng chờ khóa của JOB (`abortWhenDraining`) thôi chờ khi tiến trình đang tắt; đường request (không truyền
 * tuỳ chọn) vẫn chờ trọn (T-094). Dùng đồng hồ giả của Jest, không dùng đồng hồ thật.
 */

class FakeLocking implements LockingLike {
  readonly owners = new Map<string, string>();
  async acquire(keys: string | string[], args: { ownerId?: string | null } = {}): Promise<void> {
    const owner = args.ownerId ?? "*";
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const cur = this.owners.get(key);
      if (cur !== undefined && cur !== owner) throw new Error(`Failed to acquire lock for key "${key}"`);
      this.owners.set(key, owner);
    }
  }
  async release(keys: string | string[], args: { ownerId?: string | null } = {}): Promise<boolean> {
    let all = true;
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.owners.get(key) === (args.ownerId ?? "*")) this.owners.delete(key);
      else all = false;
    }
    return all;
  }
}

const WAIT = 15_000;
const opts = (ownerId: string) => ({ ownerId, waitMs: WAIT, ttlSeconds: 30, scope: "order" });

async function heldByOther(): Promise<FakeLocking> {
  const l = new FakeLocking();
  await l.acquire("k1", { ownerId: "OTHER" });
  return l;
}

/**
 * Tiến đồng hồ giả từng bước 10 ms tới khi `p` xong (tối đa `maxMs`): backoff của acquireOrdered có jitter ngẫu nhiên
 * (đến ~1,5 x 80 ms/lần), nên số mili giây cần tiến để thấy kết quả không cố định — không đoán một bước tiến cố định.
 */
async function settle<T>(p: Promise<T>, maxMs: number): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let t = 0; t < maxMs && !done; t += 10) await jest.advanceTimersByTimeAsync(10);
  expect(done).toBe(true);
  return p;
}

beforeEach(() => {
  resetShutdownStateForTest();
  jest.useFakeTimers();
  // Jitter backoff của acquireOrdered cố định (0,5 → đúng `delay`): thời điểm thử lại lặp lại được.
  jest.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetShutdownStateForTest();
  expect(activeLeaseCount()).toBe(0);
});

describe("acquireOrdered và tắt êm (T-174)", () => {
  it("abortWhenDraining: bật cờ tắt giữa lúc chờ → BUSY_RETRY sớm, xa hạn waitMs", async () => {
    const l = await heldByOther();
    const start = Date.now();
    const p = acquireOrdered(l, ["k1"], { ...opts("job"), abortWhenDraining: true }).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(300);
    shutdownState().draining = true;
    const err = await settle(p, 1_000);
    expect(err).toBeInstanceOf(CheckoutError);
    expect((err as CheckoutError).code).toBe("BUSY_RETRY");
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(l.owners.get("k1")).toBe("OTHER");
  });

  it("nhiều khoá: k2 bị giữ, bật cờ tắt → BUSY_RETRY, k1 đã lấy được nhả, không còn lease", async () => {
    const l = new FakeLocking();
    await l.acquire("k2", { ownerId: "OTHER" });
    const p = acquireOrdered(l, ["k1", "k2"], { ...opts("job"), abortWhenDraining: true }).catch(
      (e: unknown) => e,
    );
    await jest.advanceTimersByTimeAsync(100);
    expect(l.owners.get("k1")).toBe("job");
    shutdownState().draining = true;
    expect(((await settle(p, 1_000)) as CheckoutError).code).toBe("BUSY_RETRY");
    expect(l.owners.has("k1")).toBe(false);
    expect(l.owners.get("k2")).toBe("OTHER");
    expect(activeLeaseCount()).toBe(0);
  });

  it("không tắt → chờ như cũ tới hết waitMs rồi BUSY_RETRY", async () => {
    const l = await heldByOther();
    const start = Date.now();
    const p = acquireOrdered(l, ["k1"], { ...opts("job"), abortWhenDraining: true }).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(WAIT - 1_000);
    let settled = false;
    void p.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(((await p) as CheckoutError).code).toBe("BUSY_RETRY");
    expect(Date.now() - start).toBeGreaterThanOrEqual(WAIT);
  });

  it("đường request không truyền tuỳ chọn → đang tắt vẫn chờ, lấy được khi khóa nhả", async () => {
    const l = await heldByOther();
    const p = acquireOrdered(l, ["k1"], opts("req"));
    shutdownState().draining = true;
    await jest.advanceTimersByTimeAsync(5_000);
    await l.release("k1", { ownerId: "OTHER" });
    expect(await settle(p, 1_000)).toEqual(["k1"]);
    await releaseOwned(l, "req", null);
  });
});
