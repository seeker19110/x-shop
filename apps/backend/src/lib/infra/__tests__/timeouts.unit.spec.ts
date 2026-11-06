import { ModulesSdkUtils } from "@medusajs/framework/utils";
import Redis from "ioredis";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { adminFetch, ADMIN_FETCH_TIMEOUT_MS } from "../../../admin/lib/api";
import { CHECKOUT_CONFIG } from "../../checkout/config";
import { HttpVnpayGateway } from "../../checkout/vnpay-gateway";
import { parseEnv } from "../../env";
import { SHIPPING_CONFIG } from "../../shipping/config";
import { GhnError, HttpGhnClient } from "../../shipping/ghn-client";
import {
  databaseConfig,
  DB_TIMEOUTS,
  redisQueueOptions,
  redisRequestOptions,
  REDIS_TIMEOUTS,
  withStatementTimeout,
} from "../timeouts";

/**
 * T-092 (BASE-ERR-004, ARC-RES-001, BE-REL-001, DB-PERF-004): mọi client ra ngoài có timeout tường minh, và "phụ thuộc treo
 * → lỗi timeout trong giới hạn" được đo trên server treo THẬT (TCP/HTTP cục bộ chấp nhận kết nối nhưng không trả lời).
 */

jest.setTimeout(60_000);

const DB_URL = "postgres://xshop:p%40ss@db.internal:5432/xshop";

/** Server TCP nhận kết nối, ghi lại byte đầu tiên nhận được, KHÔNG BAO GIỜ trả lời. */
async function hangingTcp() {
  const sockets = new Set<net.Socket>();
  const received: Buffer[] = [];
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("data", (d) => received.push(d));
    s.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** HTTP treo: `mode=headers` gửi header 200 rồi treo thân; `mode=silent` không gửi gì. */
async function hangingHttp(mode: "silent" | "headers") {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    if (mode === "headers") {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    }
  });
  server.on("connection", (s) => sockets.add(s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

async function elapsed<T>(p: Promise<T>): Promise<{ ms: number; result: PromiseSettledResult<T> }> {
  const t0 = performance.now();
  const [result] = await Promise.allSettled([p]);
  return { ms: performance.now() - t0, result: result! };
}

/** Tham số trong gói startup Postgres (int32 len, int32 protocol, rồi cặp key\0value\0 … \0). */
function startupParams(buf: Buffer): Record<string, string> {
  const parts = buf.subarray(8).toString("utf8").split("\0");
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length && parts[i] !== ""; i += 2) out[parts[i]!] = parts[i + 1]!;
  return out;
}

describe("cấu hình timeout tường minh (giá trị)", () => {
  const env = { DATABASE_URL: DB_URL, DB_POOL_MAX: 10, DB_STATEMENT_TIMEOUT_MS: 30_000 };

  it("Postgres: pool có trần, connect timeout, idle_in_transaction, statement_timeout trên URL", () => {
    const c = databaseConfig(env);
    expect(c.databaseDriverOptions).toEqual({
      connectionTimeoutMillis: 5_000,
      idle_in_transaction_session_timeout: 60_000,
      pool: { min: 2, max: 10, idleTimeoutMillis: 30_000 },
    });
    const u = new URL(c.databaseUrl);
    expect(u.searchParams.get("statement_timeout")).toBe("30000");
    // Phần còn lại của URL giữ nguyên (mật khẩu đã mã hoá %40 không bị giải mã/đổi).
    expect(u.password).toBe("p%40ss");
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe("postgres://db.internal:5432/xshop");
  });

  it("URL đã khai statement_timeout → giữ của URL; các query param khác không mất", () => {
    const url = `${DB_URL}?sslmode=require&statement_timeout=5000`;
    expect(withStatementTimeout(url, 30_000)).toBe(url);
    const added = new URL(withStatementTimeout(`${DB_URL}?sslmode=require`, 12_000));
    expect(added.searchParams.get("sslmode")).toBe("require");
    expect(added.searchParams.get("statement_timeout")).toBe("12000");
  });

  it("giá trị không hợp lệ → ném lỗi (không âm thầm thành vô hạn)", () => {
    for (const ms of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withStatementTimeout(DB_URL, ms)).toThrow(/statement_timeout/);
    }
    expect(() => databaseConfig({ ...env, DB_POOL_MAX: 0 })).toThrow(/DB_POOL_MAX/);
    expect(databaseConfig({ ...env, DB_POOL_MAX: 1 }).databaseDriverOptions.pool).toMatchObject({
      min: 1,
      max: 1,
    });
  });

  it("env zod: DB_POOL_MAX/DB_STATEMENT_TIMEOUT_MS có mặc định, ngoài khoảng → lỗi nêu tên biến", () => {
    const DB = "postgres://u:p@localhost:5432/x";
    const ok = parseEnv({ DATABASE_URL: DB });
    expect(ok.ok && [ok.env.DB_POOL_MAX, ok.env.DB_STATEMENT_TIMEOUT_MS]).toEqual([10, 30_000]);
    const bad = (src: Record<string, string>) => {
      const r = parseEnv({ DATABASE_URL: DB, ...src });
      return r.ok ? [] : r.problems.map((p) => p.variable);
    };
    for (const v of ["0", "101", "abc", "-1", "1.5"])
      expect(bad({ DB_POOL_MAX: v })).toEqual(["DB_POOL_MAX"]);
    for (const v of ["0", "999", "3600001"])
      expect(bad({ DB_STATEMENT_TIMEOUT_MS: v })).toEqual(["DB_STATEMENT_TIMEOUT_MS"]);
  });

  it("Redis: connectTimeout mọi kết nối; commandTimeout chỉ cho kết nối không chặn (BullMQ không)", () => {
    expect(redisRequestOptions()).toEqual({ connectTimeout: 5_000, commandTimeout: 5_000 });
    expect(redisQueueOptions()).toEqual({ connectTimeout: 5_000 });
    expect(redisQueueOptions()).not.toHaveProperty("commandTimeout");
  });

  it("HTTP vendor/Admin: hạn hữu hạn, > 0", () => {
    for (const ms of [
      CHECKOUT_CONFIG.queryTimeoutMs,
      SHIPPING_CONFIG.requestTimeoutMs,
      ADMIN_FETCH_TIMEOUT_MS,
    ]) {
      expect(Number.isSafeInteger(ms) && ms > 0 && ms <= 60_000).toBe(true);
    }
  });
});

describe("phụ thuộc treo → lỗi timeout trong giới hạn (server treo thật)", () => {
  it("Postgres treo: kết nối qua đúng đường Medusa (createPgConnection) bỏ cuộc sau connectTimeout; gói startup mang statement_timeout + idle_in_transaction; pool max/acquire đúng cấu hình", async () => {
    const srv = await hangingTcp();
    const cfg = databaseConfig({
      DATABASE_URL: `postgres://xshop:xshop@127.0.0.1:${srv.port}/xshop`,
      DB_POOL_MAX: 7,
      DB_STATEMENT_TIMEOUT_MS: 30_000,
    });
    // Như @medusajs/framework pg-connection-loader: tách `pool` khỏi driverOptions rồi gọi createPgConnection.
    const { pool, ...driverOptions } = cfg.databaseDriverOptions;
    const knex = ModulesSdkUtils.createPgConnection({
      clientUrl: cfg.databaseUrl,
      schema: "public",
      driverOptions,
      pool,
    }) as unknown as {
      client: {
        acquireRawConnection(): Promise<unknown>;
        pool: { max: number; acquireTimeoutMillis: number };
      };
      destroy(): Promise<void>;
    };
    try {
      expect(knex.client.pool.max).toBe(7);
      expect(knex.client.pool.acquireTimeoutMillis).toBe(DB_TIMEOUTS.poolAcquireTimeoutMs);
      const { ms, result } = await elapsed(knex.client.acquireRawConnection());
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toMatch(/timeout/i);
      expect(ms).toBeGreaterThanOrEqual(DB_TIMEOUTS.connectTimeoutMs - 200);
      expect(ms).toBeLessThan(DB_TIMEOUTS.connectTimeoutMs + 3_000);
      const params = startupParams(Buffer.concat(srv.received));
      expect(params).toMatchObject({
        user: "xshop",
        database: "xshop",
        statement_timeout: "30000",
        idle_in_transaction_session_timeout: "60000",
      });
    } finally {
      await knex.destroy();
      await srv.close();
    }
  });

  it("Redis treo: lệnh bỏ cuộc sau commandTimeout (không chờ vô hạn)", async () => {
    const srv = await hangingTcp();
    const redis = new Redis(`redis://127.0.0.1:${srv.port}`, {
      ...redisRequestOptions(),
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      await redis.connect();
      const { ms, result } = await elapsed(redis.get("x"));
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toMatch(/timed out/i);
      expect(ms).toBeGreaterThanOrEqual(REDIS_TIMEOUTS.commandTimeoutMs - 200);
      expect(ms).toBeLessThan(REDIS_TIMEOUTS.commandTimeoutMs + 3_000);
    } finally {
      redis.disconnect();
      await srv.close();
    }
  });

  it.each(["silent", "headers"] as const)(
    "VNPAY querydr, server %s → unknown/timeout trong hạn (kể cả treo giữa thân)",
    async (mode) => {
      const srv = await hangingHttp(mode);
      try {
        const gw = new HttpVnpayGateway({ tmnCode: "T", hashSecret: "s".repeat(32), apiUrl: srv.url }, 300);
        const { ms, result } = await elapsed(
          gw.queryStatus({ txnRef: "PA1", amount: 1000, transactionDate: new Date(), orderInfo: "x" }),
        );
        expect(result).toEqual({
          status: "fulfilled",
          value: { outcome: "unknown", transactionNo: null, reason: "timeout" },
        });
        expect(ms).toBeLessThan(2_000);
      } finally {
        await srv.close();
      }
    },
  );

  it.each(["silent", "headers"] as const)("GHN, server %s → GhnError timeout trong hạn", async (mode) => {
    const srv = await hangingHttp(mode);
    try {
      const ghn = new HttpGhnClient(
        { mode: "sandbox", baseUrl: srv.url, token: "t-0123456789", shopId: "1" },
        300,
      );
      const { ms, result } = await elapsed(ghn.detail("GHN1"));
      expect(result.status).toBe("rejected");
      const err = (result as PromiseRejectedResult).reason as GhnError;
      expect(err).toBeInstanceOf(GhnError);
      // Treo trước header → timeout; treo giữa thân → timeout (AbortSignal phủ cả đọc thân) hoặc thân hỏng → unavailable.
      expect(["timeout", "unavailable"]).toContain(err.kind);
      if (mode === "silent") expect(err.kind).toBe("timeout");
      expect(ms).toBeLessThan(2_000);
    } finally {
      await srv.close();
    }
  });

  it.each(["silent", "headers"] as const)(
    "Admin UI → backend, server %s → TIMEOUT trong hạn",
    async (mode) => {
      const srv = await hangingHttp(mode);
      try {
        const { ms, result } = await elapsed(adminFetch(`${srv.url}/admin/x/refunds`, {}, 300));
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "TIMEOUT", status: 0 });
        expect(ms).toBeLessThan(2_000);
      } finally {
        await srv.close();
      }
    },
  );

  it("Admin UI: máy chủ từ chối kết nối → NETWORK (không nhầm với TIMEOUT)", async () => {
    const srv = await hangingHttp("silent");
    const url = srv.url;
    await srv.close();
    await expect(adminFetch(`${url}/admin/x/refunds`, {}, 1_000)).rejects.toMatchObject({ code: "NETWORK" });
  });
});
