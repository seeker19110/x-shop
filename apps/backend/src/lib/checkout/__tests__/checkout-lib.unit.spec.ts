import { CheckoutError, readCheckoutError, RETRYABLE_CODES, toProblem } from "../errors";
import {
  acquireOrdered,
  activeLeaseCount,
  releaseOwned,
  releaseOwnedOrWarn,
  releaseOwnedQuietly,
  sortLockKeys,
  tryAcquireExpiring,
  withOwnedLock,
  type LockingLike,
} from "../locks";
import { cartWeightGrams, quoteShipping, SHIPPING_FEE_TABLE } from "../shipping";

/** Khóa giả lập đúng ngữ nghĩa provider: SET NX theo owner, cùng owner = gia hạn; ghi lại thứ tự lấy. */
class FakeLocking implements LockingLike {
  readonly owners = new Map<string, string>();
  readonly log: string[] = [];
  async acquire(keys: string | string[], args: { ownerId?: string | null } = {}): Promise<void> {
    const owner = args.ownerId ?? "*";
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const cur = this.owners.get(key);
      if (cur !== undefined && cur !== owner) throw new Error(`Failed to acquire lock for key "${key}"`);
      if (cur === undefined) this.log.push(`${owner}+${key}`);
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

const opts = (ownerId: string, waitMs = 500) => ({ ownerId, waitMs, ttlSeconds: 30, scope: "inventory" });

describe("locks", () => {
  afterEach(async () => {
    expect(activeLeaseCount()).toBe(0);
  });

  it("sortLockKeys bỏ trùng và sắp tăng dần ổn định", () => {
    expect(sortLockKeys(["inventory_item:b", "inventory_item:a", "inventory_item:b"])).toEqual([
      "inventory_item:a",
      "inventory_item:b",
    ]);
    expect(sortLockKeys([])).toEqual([]);
  });

  it("lấy TUẦN TỰ theo thứ tự tăng dần, nhả đúng khóa của chủ", async () => {
    const l = new FakeLocking();
    const held = await acquireOrdered(l, ["k3", "k1", "k2"], opts("A"));
    expect(held).toEqual(["k1", "k2", "k3"]);
    expect(l.log).toEqual(["A+k1", "A+k2", "A+k3"]);
    await releaseOwned(l, "B", ["k1"]); // chủ khác không nhả được
    expect(l.owners.get("k1")).toBe("A");
    await releaseOwned(l, "A", null);
    expect(l.owners.size).toBe(0);
  });

  it("hai chủ xin tập khóa chồng nhau theo thứ tự ngược → không deadlock, lần lượt có khóa", async () => {
    const l = new FakeLocking();
    const order: string[] = [];
    const job = async (owner: string, keys: string[]) => {
      await acquireOrdered(l, keys, opts(owner, 2000));
      order.push(`${owner}:in`);
      await new Promise((r) => setTimeout(r, 30));
      order.push(`${owner}:out`);
      await releaseOwned(l, owner, null);
    };
    await Promise.all([job("A", ["x", "y"]), job("B", ["y", "x"])]);
    expect(order).toHaveLength(4);
    expect(order[0]!.split(":")[0]).toBe(order[1]!.split(":")[0]);
  });

  it("quá hạn chờ → BUSY_RETRY và trả lại mọi khóa đã lấy (không rò khóa)", async () => {
    const l = new FakeLocking();
    await l.acquire("k2", { ownerId: "OTHER" });
    const err = await acquireOrdered(l, ["k1", "k2"], opts("A", 60)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect((err as CheckoutError).code).toBe("BUSY_RETRY");
    expect(l.owners.has("k1")).toBe(false);
    expect(l.owners.get("k2")).toBe("OTHER");
  });

  it("lỗi không phải 'đang bận' (Redis mất kết nối) → LOCK_UNAVAILABLE 503 ngay (không chờ hết waitMs), nhả khóa đã lấy", async () => {
    const l = new FakeLocking();
    const cause = new Error("Connection is closed.");
    const broken: LockingLike = {
      acquire: async (keys, args) => {
        if (keys === "k2") throw cause;
        return l.acquire(keys, args);
      },
      release: (keys, args) => l.release(keys, args),
    };
    const started = Date.now();
    const err = await acquireOrdered(broken, ["k1", "k2"], opts("A", 5_000)).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err).toMatchObject({ code: "LOCK_UNAVAILABLE", status: 503, detail: { lock_scope: "inventory" } });
    // Nguyên nhân gốc chỉ để log server — không lọt vào thân problem.
    expect((err as CheckoutError).cause).toBe(cause);
    expect(JSON.stringify(toProblem(err as CheckoutError))).not.toContain("Connection is closed");
    expect(l.owners.size).toBe(0);
  });

  it("provider không trả lời → LOCK_UNAVAILABLE sau callTimeoutMs; lệnh tới muộn thì khóa được trả ngay", async () => {
    const l = new FakeLocking();
    let finishLate: (() => void) | undefined;
    const hanging: LockingLike = {
      acquire: (keys, args) =>
        new Promise<void>((resolve) => {
          // Lệnh nằm trong hàng đợi offline của client, chạy khi Redis trở lại.
          finishLate = () => void l.acquire(keys, args).then(resolve);
        }),
      release: (keys, args) => l.release(keys, args),
    };
    const started = Date.now();
    const err = await acquireOrdered(hanging, ["k1"], { ...opts("A", 10_000), callTimeoutMs: 50 }).catch(
      (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    finishLate?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(l.owners.size).toBe(0);
  });

  it("releaseOwned lỗi hạ tầng → LOCK_UNAVAILABLE; releaseOwnedQuietly không ném và vẫn ngừng gia hạn", async () => {
    const l = new FakeLocking();
    await acquireOrdered(l, ["k1"], opts("A"));
    const down: LockingLike = {
      acquire: () => Promise.reject(new Error("Connection is closed.")),
      release: () => Promise.reject(new Error("Connection is closed.")),
    };
    const quiet = await releaseOwnedQuietly(down, "A", null);
    expect(quiet).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(activeLeaseCount()).toBe(0);
    await acquireOrdered(l, ["k2"], opts("B"));
    await expect(releaseOwned(down, "B", null)).rejects.toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(await releaseOwnedQuietly(down, "khong-giu-gi", null)).toBeNull();
  });

  describe("tryAcquireExpiring (giới hạn tần suất bằng khóa tự hết hạn — T-056)", () => {
    it("lấy được → true (giữ với expire, không gia hạn); đang bị giữ → false", async () => {
      const l = new FakeLocking();
      const calls: Array<{ expire?: number }> = [];
      const spy: LockingLike = {
        acquire: (keys, args) => {
          calls.push({ expire: args?.expire });
          return l.acquire(keys, args);
        },
        release: (keys, args) => l.release(keys, args),
      };
      expect(await tryAcquireExpiring(spy, "r:1", { expireSeconds: 10, scope: "recheck" })).toBe(true);
      expect(await tryAcquireExpiring(spy, "r:1", { expireSeconds: 10, scope: "recheck" })).toBe(false);
      expect(calls).toEqual([{ expire: 10 }, { expire: 10 }]);
      expect(activeLeaseCount()).toBe(0); // không đăng ký gia hạn → khóa tự hết sau expire
    });

    it("provider treo → LOCK_UNAVAILABLE sau callTimeoutMs (không phải 'đang bận'); lỗi kết nối → LOCK_UNAVAILABLE ngay", async () => {
      const hanging: LockingLike = {
        acquire: () => new Promise<void>(() => undefined),
        release: async () => true,
      };
      const started = Date.now();
      const err = await tryAcquireExpiring(hanging, "r:2", {
        expireSeconds: 10,
        scope: "recheck",
        callTimeoutMs: 50,
      }).catch((e: unknown) => e);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(err).toMatchObject({ code: "LOCK_UNAVAILABLE", detail: { lock_scope: "recheck" } });
      const down: LockingLike = {
        acquire: () => Promise.reject(new Error("Connection is closed.")),
        release: async () => true,
      };
      await expect(
        tryAcquireExpiring(down, "r:3", { expireSeconds: 10, scope: "recheck" }),
      ).rejects.toMatchObject({
        code: "LOCK_UNAVAILABLE",
      });
    });
  });

  describe("withOwnedLock (thay locking.execute — T-056)", () => {
    it("nhiều khóa: lấy tuần tự tăng dần với tiền tố owner, nhả hết sau fn; fn lỗi → lỗi gốc, khóa vẫn được nhả", async () => {
      const l = new FakeLocking();
      const value = await withOwnedLock(l, ["b", "a"], { ...opts("x"), ownerPrefix: "import" }, async () => {
        expect([...l.owners.values()].every((o) => o.startsWith("import:"))).toBe(true);
        return 42;
      });
      expect(value).toBe(42);
      expect(l.log.map((e) => e.split("+")[1])).toEqual(["a", "b"]);
      expect(l.owners.size).toBe(0);
      const boom = new Error("lỗi nghiệp vụ");
      await expect(withOwnedLock(l, "a", opts("x"), () => Promise.reject(boom))).rejects.toBe(boom);
      expect(l.owners.size).toBe(0);
    });

    it("Redis câm khi giành khóa → LOCK_UNAVAILABLE trong hạn, KHÔNG chạy fn", async () => {
      const hanging: LockingLike = {
        acquire: () => new Promise<void>(() => undefined),
        release: async () => true,
      };
      let ran = false;
      const err = await withOwnedLock(hanging, "a", { ...opts("x", 10_000), callTimeoutMs: 50 }, async () => {
        ran = true;
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "LOCK_UNAVAILABLE" });
      expect(ran).toBe(false);
    });

    it("mất lease giữa chừng (gia hạn thấy chủ khác giữ): failOnLeaseLoss → LOCK_UNAVAILABLE lease_lost, không xoá khóa của chủ khác; không bật → trả kết quả", async () => {
      const run = async (failOnLeaseLoss: boolean) => {
        const l = new FakeLocking();
        const p = withOwnedLock(l, "imp", { ...opts("x"), ttlSeconds: 1, failOnLeaseLoss }, async () => {
          l.owners.set("imp", "OTHER"); // lease hết hạn khi Redis không trả lời, chủ khác lấy
          await new Promise((r) => setTimeout(r, 450)); // > 1/3 TTL → một lần gia hạn chạy
          return "xong";
        });
        const out = await p.catch((e: unknown) => e);
        expect(l.owners.get("imp")).toBe("OTHER");
        return out;
      };
      expect(await run(true)).toMatchObject({
        code: "LOCK_UNAVAILABLE",
        detail: { lock_scope: "inventory", lease_lost: true },
      });
      expect(await run(false)).toBe("xong");
    });

    it("gia hạn lỗi tạm (mạng) không bị coi là mất lease", async () => {
      const l = new FakeLocking();
      let renewals = 0;
      const flaky: LockingLike = {
        acquire: (keys, args) => {
          if (l.owners.get(keys as string) === args?.ownerId) {
            renewals += 1;
            return Promise.reject(new Error("Connection is closed."));
          }
          return l.acquire(keys, args);
        },
        release: (keys, args) => l.release(keys, args),
      };
      const out = await withOwnedLock(
        flaky,
        "k",
        { ...opts("x"), ttlSeconds: 1, failOnLeaseLoss: true },
        async () => {
          await new Promise((r) => setTimeout(r, 450));
          return "ok";
        },
      );
      expect(out).toBe("ok");
      expect(renewals).toBeGreaterThan(0);
    });
  });

  it("releaseOwnedOrWarn: nhả lỗi/treo → chỉ cảnh báo (không ném), ngừng gia hạn; nhả được → không cảnh báo", async () => {
    const l = new FakeLocking();
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m) };
    await acquireOrdered(l, ["k1"], opts("A"));
    const down: LockingLike = {
      acquire: () => Promise.reject(new Error("Connection is closed.")),
      release: () => Promise.reject(new Error("Connection is closed.")),
    };
    await expect(releaseOwnedOrWarn(down, "A", logger, "cancel")).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[cancel\] .*Connection is closed/);
    expect(activeLeaseCount()).toBe(0);
    await acquireOrdered(l, ["k2"], opts("B"));
    await releaseOwnedOrWarn(l, "B", logger, "cancel");
    expect(warnings).toHaveLength(1);
    expect(l.owners.has("k2")).toBe(false);
  });

  it("LOCK_UNAVAILABLE là lỗi tạm: cùng Idempotency-Key gửi lại được; BUSY_RETRY vẫn 409", () => {
    expect(RETRYABLE_CODES).toContain("LOCK_UNAVAILABLE");
    expect(new CheckoutError("BUSY_RETRY").status).toBe(409);
    expect(toProblem(new CheckoutError("LOCK_UNAVAILABLE"))).toMatchObject({
      status: 503,
      code: "LOCK_UNAVAILABLE",
      action: "retry_same_key",
      detail: "Hệ thống tạm thời không nhận đơn, vui lòng thử lại sau ít phút",
    });
  });
});

describe("quoteShipping (bảng phí P0)", () => {
  const addr = { provinceCode: "01", wardCode: "00004" };
  it.each([
    [0, 30_000],
    [1_000, 30_000],
    [1_001, 35_000],
    [1_500, 35_000],
    [1_501, 40_000],
    [5_000, 70_000],
  ])("%d gram → %d đồng", (grams, fee) => {
    expect(quoteShipping(addr, grams).fee).toBe(fee);
  });

  it("khối lượng âm/không nguyên → lỗi", () => {
    expect(() => quoteShipping(addr, -1)).toThrow(RangeError);
    expect(() => quoteShipping(addr, 1.5)).toThrow(RangeError);
  });

  it("cartWeightGrams: biến thể thiếu/0/null weight dùng mặc định", () => {
    expect(
      cartWeightGrams([
        { weightGrams: null, quantity: 2 },
        { weightGrams: 0, quantity: 1 },
        { weightGrams: 450, quantity: 2 },
      ]),
    ).toBe(SHIPPING_FEE_TABLE.defaultItemWeightGrams * 3 + 900);
    expect(cartWeightGrams([])).toBe(0);
  });
});

describe("CheckoutError qua tuần tự hoá của workflow engine", () => {
  it("serializeError (thuộc tính riêng) → đọc lại đúng mã, field, detail", () => {
    const original = new CheckoutError("PRICE_CHANGED", undefined, { detail: { quote: { total: 780_000 } } });
    const serialized: Record<string, unknown> = { message: original.message, name: original.name };
    for (const k of Object.getOwnPropertyNames(original)) serialized[k] = (original as never)[k];
    const back = readCheckoutError(JSON.parse(JSON.stringify(serialized)));
    expect(back?.code).toBe("PRICE_CHANGED");
    expect(back?.status).toBe(409);
    expect(back?.detail).toEqual({ quote: { total: 780_000 } });
  });

  it("đối tượng lạ / mã không hợp lệ → null", () => {
    expect(readCheckoutError(new Error("x"))).toBeNull();
    expect(readCheckoutError({ x_checkout_error: true, code: "KHONG_CO" })).toBeNull();
    expect(readCheckoutError(null)).toBeNull();
  });

  it("toProblem: RFC 9457 + code ổn định + hành động; detail không đè khóa chuẩn", () => {
    const p = toProblem(
      new CheckoutError("INSUFFICIENT_STOCK", undefined, { detail: { lines: [1], status: 200, code: "X" } }),
    );
    expect(p).toMatchObject({ status: 409, code: "INSUFFICIENT_STOCK", action: "update_cart", lines: [1] });
    expect(p.type).toBe("https://x-shop.vn/problems/insufficient-stock");
  });
});
