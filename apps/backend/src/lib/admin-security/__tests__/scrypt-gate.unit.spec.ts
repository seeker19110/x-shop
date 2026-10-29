import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type {
  AuthenticationInput,
  AuthenticationResponse,
  AuthIdentityDTO,
  AuthIdentityProviderService,
  Logger,
} from "@medusajs/framework/types";
import { MedusaError } from "@medusajs/framework/utils";
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";
import { AUTH_BUSY, xErrorHandler } from "../../errors/error-handler";
import { TimingSafeEmailPassAuthService } from "../emailpass";
import { EMAILPASS_HASH_CONFIG } from "../password-hash";
import {
  AUTH_BUSY_RETRY_AFTER_SECONDS,
  ConcurrencyGate,
  isAuthBusy,
  markAuthBusy,
  SCRYPT_QUEUE_MAX,
  ScryptBusyError,
  scryptConcurrency,
  scryptGate,
  uvThreadpoolSize,
  withAuthBusyContext,
} from "../scrypt-gate";

/**
 * Review T-181 🟠 (DoS thread pool): mọi phép scrypt của provider emailpass đi qua một semaphore chung — tối đa
 * max(1, UV_THREADPOOL_SIZE − 1) phép chạy, hàng chờ có trần + hạn chờ; quá → `ScryptBusyError` như nhau ở mọi nhánh và
 * HTTP 503 AUTH_BUSY + Retry-After.
 */

jest.setTimeout(120_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

describe("ConcurrencyGate", () => {
  it("giới hạn đúng số việc đồng thời, FIFO, xong hết", async () => {
    const gate = new ConcurrencyGate({ max: 2, queueMax: 10, waitTimeoutMs: 10_000 });
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = Array.from({ length: 5 }, () => deferred());
    const jobs = gates.map((d, i) =>
      gate.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        order.push(i);
        await d.promise;
        running -= 1;
        return i;
      }),
    );
    await tick();
    expect(gate.active).toBe(2);
    expect(gate.waiting).toBe(3);
    for (const d of gates) {
      d.resolve();
      await tick();
    }
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(gate.active).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("hàng chờ đầy → từ chối NGAY (queue_full), không chạy việc", async () => {
    const gate = new ConcurrencyGate({ max: 1, queueMax: 1, waitTimeoutMs: 10_000 });
    const hold = deferred();
    const a = gate.run(() => hold.promise);
    const b = gate.run(async () => "b");
    const ran = jest.fn(async () => "c");
    const t = performance.now();
    await expect(gate.run(ran)).rejects.toThrow(new ScryptBusyError("queue_full"));
    expect(performance.now() - t).toBeLessThan(50);
    expect(ran).not.toHaveBeenCalled();
    hold.resolve();
    await a;
    expect(await b).toBe("b");
    expect(gate.active).toBe(0);
  });

  it("chờ quá hạn → timeout, rời hàng chờ, không rò slot", async () => {
    const gate = new ConcurrencyGate({ max: 1, queueMax: 4, waitTimeoutMs: 30 });
    const hold = deferred();
    const a = gate.run(() => hold.promise);
    await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(ScryptBusyError);
    expect(gate.waiting).toBe(0);
    hold.resolve();
    await a;
    expect(gate.active).toBe(0);
    expect(await gate.run(async () => 2)).toBe(2);
  });

  it("việc ném lỗi → slot vẫn được trả, người chờ kế tiếp chạy", async () => {
    const gate = new ConcurrencyGate({ max: 1, queueMax: 4, waitTimeoutMs: 10_000 });
    const failing = gate.run(async () => {
      throw new Error("hỏng");
    });
    const next = gate.run(async () => "ok");
    await expect(failing).rejects.toThrow("hỏng");
    expect(await next).toBe("ok");
    expect(gate.active).toBe(0);
  });

  it("tham số sai → RangeError", () => {
    expect(() => new ConcurrencyGate({ max: 0, queueMax: 1, waitTimeoutMs: 1 })).toThrow(RangeError);
    expect(() => new ConcurrencyGate({ max: 1.5, queueMax: 1, waitTimeoutMs: 1 })).toThrow(RangeError);
    expect(() => new ConcurrencyGate({ max: 1, queueMax: -1, waitTimeoutMs: 1 })).toThrow(RangeError);
  });
});

describe("số phép scrypt đồng thời theo UV_THREADPOOL_SIZE", () => {
  it.each([
    [undefined, 4, 3],
    ["4", 4, 3],
    ["8", 8, 7],
    ["2", 2, 1],
    ["1", 1, 1],
    [" 6 ", 6, 5],
    ["0", 4, 3],
    ["-3", 4, 3],
    ["abc", 4, 3],
    ["1.5", 4, 3],
    ["2000", 4, 3],
    ["", 4, 3],
  ])("UV_THREADPOOL_SIZE=%p → pool %p, scrypt %p", (raw, pool, conc) => {
    const env = raw === undefined ? {} : { UV_THREADPOOL_SIZE: raw };
    expect(uvThreadpoolSize(env)).toBe(pool);
    expect(scryptConcurrency(env)).toBe(conc);
  });
});

describe("cờ bận theo request (AsyncLocalStorage)", () => {
  it("ngoài ngữ cảnh: đánh dấu không có tác dụng; trong ngữ cảnh: tách biệt giữa các request đồng thời", async () => {
    markAuthBusy();
    expect(isAuthBusy()).toBe(false);
    const results = await Promise.all([
      withAuthBusyContext(async () => {
        await tick();
        markAuthBusy();
        await tick();
        return isAuthBusy();
      }),
      withAuthBusyContext(async () => {
        await tick();
        await tick();
        return isAuthBusy();
      }),
    ]);
    expect(results).toEqual([true, false]);
  });

  it("handler lỗi toàn cục: cờ bận → 503 AUTH_BUSY problem+json + Retry-After; không cờ → 401 như cũ", () => {
    const call = (busy: boolean) => {
      const captured: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
      const res = {
        headersSent: false,
        status(c: number) {
          captured.status = c;
          return res;
        },
        setHeader(n: string, v: string) {
          captured.headers[n.toLowerCase()] = v;
          return res;
        },
        getHeader: (n: string) => captured.headers[n.toLowerCase()],
        send(b: string) {
          captured.body = b;
          return res;
        },
      };
      const req = { method: "POST", path: "/auth/user/emailpass", scope: { resolve: () => logger } };
      withAuthBusyContext(() => {
        if (busy) markAuthBusy();
        xErrorHandler(
          new MedusaError(MedusaError.Types.UNAUTHORIZED, "Authentication failed"),
          req as unknown as MedusaRequest,
          res as unknown as MedusaResponse,
          jest.fn() as unknown as MedusaNextFunction,
        );
      });
      return { ...captured, json: JSON.parse(captured.body ?? "{}") as Record<string, unknown> };
    };
    const busy = call(true);
    expect(busy.status).toBe(503);
    expect(busy.headers["retry-after"]).toBe(String(AUTH_BUSY_RETRY_AFTER_SECONDS));
    expect(busy.headers["content-type"]).toContain("application/problem+json");
    expect(busy.json).toMatchObject({ status: 503, code: AUTH_BUSY });
    const normal = call(false);
    expect(normal.status).toBe(401);
    expect(normal.headers["retry-after"]).toBeUndefined();
  });
});

type Provider = {
  authenticate(d: AuthenticationInput, s: AuthIdentityProviderService): Promise<AuthenticationResponse>;
  register(d: AuthenticationInput, s: AuthIdentityProviderService): Promise<AuthenticationResponse>;
  hashPassword(password: string): Promise<string>;
};
const Safe = TimingSafeEmailPassAuthService as unknown as new (
  deps: { logger: Logger },
  options: Record<string, unknown>,
) => Provider;
const logger = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Logger;
const body = (email: string, password: string) => ({ body: { email, password } }) as AuthenticationInput;

/** `null` = identity emailpass có thật nhưng không có hash mật khẩu. */
function store(hashes: Record<string, string | null>) {
  return {
    retrieve: async ({ entity_id }: { entity_id: string }) => {
      const h = hashes[entity_id];
      if (h === undefined) throw new MedusaError(MedusaError.Types.NOT_FOUND, "không có");
      return {
        id: `ai_${entity_id}`,
        provider_identities: [
          {
            id: `pi_${entity_id}`,
            provider: "emailpass",
            entity_id,
            provider_metadata: h === null ? {} : { password: h },
          },
        ],
      } as unknown as AuthIdentityDTO;
    },
    create: async () => {
      throw new Error("không dùng");
    },
    update: async () => {
      throw new Error("không dùng");
    },
    setState: async () => undefined,
    getState: async () => null,
  } as unknown as AuthIdentityProviderService;
}

describe("provider emailpass dùng semaphore chung (logN 17)", () => {
  const EXISTING = "co-that@example.test";
  let provider: Provider;
  let svc: AuthIdentityProviderService;

  beforeAll(async () => {
    provider = new Safe({ logger }, { hashConfig: { ...EMAILPASS_HASH_CONFIG } });
    svc = store({ [EXISTING]: await provider.hashPassword("SENTINEL-dung") });
    // Chờ hash mồi tính xong (đăng nhập email không tồn tại đi qua nhánh mồi).
    await provider.authenticate(body("khoi-dong@example.test", "SENTINEL-sai"), svc);
  });

  it("16 lần đăng nhập dồn dập: không bao giờ quá trần scrypt, thread pool còn luồng cho fs.readFile", async () => {
    const gate = scryptGate();
    let peak = 0;
    const iv = setInterval(() => (peak = Math.max(peak, gate.active)), 2);
    const burst = Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        provider.authenticate(body(i % 2 === 0 ? EXISTING : `khong-${i}@example.test`, "SENTINEL-sai"), svc),
      ),
    );
    await tick();
    const f0 = performance.now();
    await fs.readFile(__filename);
    const fsMs = performance.now() - f0;
    const results = await burst;
    clearInterval(iv);
    process.stdout.write(
      `[scrypt-gate] fs.readFile chờ ${Math.round(fsMs)} ms trong đợt 16 đăng nhập; trần ${scryptConcurrency()}\n`,
    );
    expect(results.every((r) => r.success === false && r.error === "Invalid email or password")).toBe(true);
    expect(peak).toBeLessThanOrEqual(scryptConcurrency());
    // Không có trần: ~3,3 s (review). Có trần: còn ≥ 1 luồng rảnh → vài ms; ngưỡng rộng cho máy CI tải nặng.
    expect(fsMs).toBeLessThan(1000);
    expect(gate.active).toBe(0);
  });

  it("semaphore đầy: email có thật và email không tồn tại đều nhận ScryptBusyError ngay + cờ bận (không lộ tài khoản)", async () => {
    const gate = scryptGate();
    const hold = deferred();
    const blockers = Array.from({ length: scryptConcurrency() + SCRYPT_QUEUE_MAX }, () =>
      gate.run(() => hold.promise),
    );
    await tick();
    expect(gate.waiting).toBe(SCRYPT_QUEUE_MAX);
    const attempt = (fn: () => Promise<unknown>) =>
      withAuthBusyContext(async () => {
        const t = performance.now();
        let error: unknown = null;
        try {
          await fn();
        } catch (e) {
          error = e;
        }
        return { error, busy: isAuthBusy(), ms: performance.now() - t };
      });
    try {
      const existing = await attempt(() => provider.authenticate(body(EXISTING, "SENTINEL-sai"), svc));
      const missing = await attempt(() =>
        provider.authenticate(body("khong-co@example.test", "SENTINEL-sai"), svc),
      );
      for (const r of [existing, missing]) {
        expect(r.error).toBeInstanceOf(ScryptBusyError);
        expect(r.busy).toBe(true);
        expect(r.ms).toBeLessThan(200);
      }
      // Đăng ký (email mới → hashPassword; email có → kiểm mật khẩu): cũng bận, cũng đánh dấu.
      const regNew = await attempt(async () => {
        const r = await provider.register(body("moi@example.test", "SENTINEL-moi"), svc);
        if (!r.success) throw new Error(r.error);
      });
      const regExisting = await attempt(async () => {
        const r = await provider.register(body(EXISTING, "SENTINEL-sai"), svc);
        if (!r.success) throw new Error(r.error);
      });
      expect(regNew.busy).toBe(true);
      expect(regExisting.busy).toBe(true);
    } finally {
      hold.resolve();
      await Promise.all(blockers);
    }
    expect(gate.active).toBe(0);
    expect(gate.waiting).toBe(0);
    // Hết bận → đăng nhập đúng hoạt động lại.
    expect((await provider.authenticate(body(EXISTING, "SENTINEL-dung"), svc)).success).toBe(true);
  });
});

describe("hash mồi và số lần qua cổng (review T-181 vòng 3)", () => {
  it("cổng đầy lúc khởi tạo: email lạ nhận bận + cờ bận; hết tải → tính lại hash mồi, 401 bình thường", async () => {
    const gate = scryptGate();
    const hold = deferred();
    const blockers = Array.from({ length: gate.options.max + gate.options.queueMax }, () =>
      gate.run(() => hold.promise),
    );
    await tick();
    // Hash mồi lúc khởi tạo bị từ chối (queue_full) — không được nhớ lỗi này.
    const p = new Safe({ logger }, { hashConfig: { ...EMAILPASS_HASH_CONFIG } });
    await tick();
    const svc = store({});
    const during = await withAuthBusyContext(async () => {
      try {
        await p.authenticate(body("la-1@example.test", "SENTINEL-sai"), svc);
        return { error: null as unknown, busy: isAuthBusy() };
      } catch (e) {
        return { error: e, busy: isAuthBusy() };
      }
    });
    expect(during.error).toBeInstanceOf(ScryptBusyError);
    expect(during.busy).toBe(true);
    hold.resolve();
    await Promise.all(blockers);
    expect(await p.authenticate(body("la-2@example.test", "SENTINEL-sai"), svc)).toEqual({
      success: false,
      error: "Invalid email or password",
    });
    expect(gate.active).toBe(0);
  });

  it("identity không có hash: chỉ qua cổng MỘT lần (phép mồi), như email không tồn tại", async () => {
    const p = new Safe({ logger }, { hashConfig: { ...EMAILPASS_HASH_CONFIG } });
    const svc = store({ "khong-hash@example.test": null });
    await p.authenticate(body("khoi-dong-2@example.test", "SENTINEL-sai"), svc); // hash mồi sẵn
    const run = jest.spyOn(scryptGate(), "run");
    try {
      const noHash = await p.authenticate(body("khong-hash@example.test", "SENTINEL-sai"), svc);
      expect(noHash).toEqual({ success: false, error: "Invalid email or password" });
      expect(run).toHaveBeenCalledTimes(1);
      run.mockClear();
      await p.authenticate(body("khong-ton-tai@example.test", "SENTINEL-sai"), svc);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  });
});
