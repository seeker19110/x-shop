import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { generateJwtToken } from "@medusajs/framework/utils";

jest.setTimeout(420 * 1000);

/**
 * T-094 (BE-REL-004, ARC-RES-009): tắt êm trên TIẾN TRÌNH THẬT — `medusa start` (đúng lệnh production/E2E, có nạp
 * instrumentation.ts) trên DB tạm đã migrate + Redis cục bộ. Request chậm thật: test giữ khoá `ACCESS EXCLUSIVE` trên bảng
 * `provider_identity` nên `POST /auth/user/emailpass` (đăng nhập) chờ trong Postgres tới khi test nhả khoá.
 */

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
const { Client } = createRequire(require.resolve("@medusajs/framework"))("pg") as {
  Client: new (opts: { connectionString: string }) => PgClient;
};

const BACKEND_DIR = join(__dirname, "../..");
const CLI = require.resolve("@medusajs/cli/cli.js", { paths: [BACKEND_DIR] });
const ADMIN_DB_URL = process.env.DATABASE_URL!;
const SHUTDOWN_JWT_SECRET = "x-shop-shutdown-test-only-jwt-secret-0123456789";
const DB_NAME = `xshop_shutdown_${process.pid}`;
const DB_URL = (() => {
  const u = new URL(ADMIN_DB_URL);
  u.pathname = `/${DB_NAME}`;
  return u.toString();
})();

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: DB_URL,
    NODE_ENV: "development",
    DISABLE_MEDUSA_ADMIN: "true",
    // Bí mật JWT biết trước để test ký được token mời hợp lệ cho tiến trình con (T-138) — CHỈ cho test.
    JWT_SECRET: SHUTDOWN_JWT_SECRET,
    ...extra,
  };
  // Tuỳ chọn Node của Jest (vm-modules, heap) không dành cho tiến trình Medusa.
  delete env.NODE_OPTIONS;
  delete env.TEST_TYPE;
  return env;
}

function runCli(args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: BACKEND_DIR, env: childEnv({}) });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (output += c.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`medusa ${args.join(" ")} quá ${timeoutMs} ms\n${output.slice(-2000)}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

async function adminQuery(sql: string, params: unknown[] = []): Promise<void> {
  const c = new Client({ connectionString: ADMIN_DB_URL });
  await c.connect();
  try {
    await c.query(sql, params);
  } finally {
    await c.end();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Res {
  status: number;
  json: Record<string, unknown>;
}

/** Một request trên kết nối MỚI (agent: false) — lỗi kết nối (ECONNREFUSED…) reject với `code`. */
function request(port: number, method: string, path: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        agent: false,
        headers: payload === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          } catch {
            // không phải JSON
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, timeoutMs: number, fn: () => Promise<T | undefined>): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`hết ${timeoutMs} ms chờ: ${what}`);
    await sleep(100);
  }
}

interface Backend {
  child: ChildProcess;
  port: number;
  output: () => string;
  /** Chỉ stdout (log ứng dụng). */
  stdout: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

let running: Backend | null = null;

async function startBackend(extra: Record<string, string>): Promise<Backend> {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: BACKEND_DIR,
    env: childEnv(extra),
  });
  let output = "";
  let stdout = "";
  child.stdout?.on("data", (c: Buffer) => {
    output += c.toString("utf8");
    stdout += c.toString("utf8");
  });
  child.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })),
  );
  const backend: Backend = { child, port, output: () => output, stdout: () => stdout, exited };
  running = backend;
  let dead = false;
  void exited.then(() => (dead = true));
  await waitFor("backend sẵn sàng", 120_000, async () => {
    if (dead) throw new Error(`backend thoát sớm\n${output.slice(-3000)}`);
    const r = await request(port, "GET", "/x/readyz");
    return r.status === 200 ? true : undefined;
  }).catch((err: unknown) => {
    if (dead) throw new Error(`backend thoát sớm\n${output.slice(-3000)}`);
    throw err;
  });
  return backend;
}

/** Đăng ký identity emailpass rồi giữ khoá bảng provider_identity → đăng nhập kế tiếp bị chặn trong Postgres. */
async function slowLogin(port: number) {
  const email = `shutdown-${randomUUID()}@x-shop.test`;
  const password = `pw-${randomUUID()}`;
  // Đăng ký `user` chỉ qua cổng khi có token mời hợp lệ đúng email (T-138, D-075) — tiến trình con không chung container
  // với test nên ghi lời mời thẳng vào DB, token ký bằng bí mật JWT đã đặt cho tiến trình con (như User Module).
  const inviteId = `invite_shutdown_${randomUUID()}`;
  const inviteToken = generateJwtToken({ id: inviteId }, { secret: SHUTDOWN_JWT_SECRET, expiresIn: "1h" });
  const invite = new Client({ connectionString: DB_URL });
  await invite.connect();
  try {
    await invite.query(
      `INSERT INTO invite (id, email, accepted, token, expires_at) VALUES ($1, $2, false, $3, now() + interval '1 hour')`,
      [inviteId, email, inviteToken],
    );
  } finally {
    await invite.end();
  }
  const reg = await request(port, "POST", "/auth/user/emailpass/register", {
    email,
    password,
    invite_token: inviteToken,
  });
  expect(reg.status).toBe(200);
  const lock = new Client({ connectionString: DB_URL });
  await lock.connect();
  await lock.query("BEGIN");
  await lock.query("LOCK TABLE provider_identity IN ACCESS EXCLUSIVE MODE");
  let settled = false;
  const pending = request(port, "POST", "/auth/user/emailpass", { email, password });
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  return {
    pending,
    isSettled: () => settled,
    release: async () => {
      await lock.query("COMMIT").catch(() => undefined);
      await lock.end().catch(() => undefined);
    },
  };
}

const shutdownLines = (out: string) =>
  out
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((l) => l.event === "shutdown");

describe("tắt êm — tiến trình medusa start thật (T-094)", () => {
  beforeAll(async () => {
    await adminQuery(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [DB_NAME],
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    await adminQuery(`CREATE DATABASE "${DB_NAME}"`);
    const mig = await runCli(["db:migrate"], 240_000);
    if (mig.code !== 0) throw new Error(`db:migrate thất bại (${mig.code})\n${mig.output.slice(-3000)}`);
  });

  afterEach(async () => {
    if (running !== null && running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill("SIGKILL");
      await running.exited;
    }
    running = null;
  });

  afterAll(async () => {
    await adminQuery(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [DB_NAME],
    );
    await adminQuery(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  });

  it("SIGTERM khi có request chậm: readiness 503 nhưng vẫn phục vụ → đóng listener → request chậm hoàn tất 200 → thoát 0 trong trần", async () => {
    const DRAIN = 2_000;
    const TIMEOUT = 20_000;
    const be = await startBackend({
      SHUTDOWN_DRAIN_DELAY_MS: String(DRAIN),
      SHUTDOWN_TIMEOUT_MS: String(TIMEOUT),
    });
    const slow = await slowLogin(be.port);
    try {
      await sleep(500);
      expect(slow.isSettled()).toBe(false); // đúng là đang chờ khoá

      const t0 = Date.now();
      be.child.kill("SIGTERM");
      // (a) readiness lỗi ngay, (b) request mới vẫn được phục vụ trong pha drain.
      await waitFor("readyz 503", 1_500, async () => {
        const r = await request(be.port, "GET", "/x/readyz");
        return r.status === 503 ? r : undefined;
      }).then((r) => expect(r.json).toMatchObject({ code: "NOT_READY" }));
      expect((await request(be.port, "GET", "/x/health")).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(DRAIN);

      // (c) hết drain → listener đóng: kết nối mới bị từ chối, request chậm vẫn chờ, tiến trình còn sống.
      const refused = await waitFor("listener đóng", DRAIN + 5_000, async () => {
        try {
          await request(be.port, "GET", "/x/health");
          return undefined;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code;
        }
      });
      expect(refused).toBe("ECONNREFUSED");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(DRAIN);
      expect(slow.isSettled()).toBe(false);
      expect(be.child.exitCode).toBeNull();

      // (d) nhả khoá → request chậm hoàn tất 200 (có token) → tiến trình đóng pool/Redis và thoát 0 trong trần.
      await slow.release();
      const done = await slow.pending;
      expect(done.status).toBe(200);
      expect(typeof done.json.token).toBe("string");
      const exit = await be.exited;
      expect(exit).toMatchObject({ code: 0, signal: null });
      expect(exit.at - t0).toBeLessThan(TIMEOUT);

      const lines = shutdownLines(be.output());
      expect(lines[0]).toMatchObject({
        level: "info",
        signal: "SIGTERM",
        drain_delay_ms: DRAIN,
        timeout_ms: TIMEOUT,
      });
      expect(lines.some((l) => l.level === "error")).toBe(false);
      expect(be.output()).toContain("Gracefully shutting down server");
    } finally {
      await slow.release();
    }
  });

  it("log của tiến trình thật (T-090): MỌI dòng stdout là một JSON đủ trường; không PII/bí mật từ request; có log truy cập", async () => {
    const be = await startBackend({ SHUTDOWN_DRAIN_DELAY_MS: "0", SHUTDOWN_TIMEOUT_MS: "15000" });
    const email = `khach-${randomUUID()}@x-shop.test`;
    // Dữ liệu nhạy cảm đi vào qua query, thân, header — không được xuất hiện trong log.
    await request(be.port, "GET", "/store/x/products?q=0912345678&token=bi-mat-query");
    await request(be.port, "POST", "/auth/user/emailpass", { email, password: "mat-khau-sai-0123" });
    await request(be.port, "GET", "/x/khong-co-route?sdt=0987654321");
    // Bị middleware lõi Medusa từ chối TRƯỚC middleware dự án: vẫn phải có đúng 1 bản ghi truy cập (SEC-LOG-001).
    const base = `http://127.0.0.1:${be.port}`;
    expect((await fetch(`${base}/admin/users/me`)).status).toBe(401);
    const bad = await fetch(`${base}/admin/products`, { headers: { authorization: "Bearer rac-token-xyz" } });
    expect(bad.status).toBe(401);
    expect((await request(be.port, "GET", "/auth/user/%FF")).status).toBeLessThan(500);
    be.child.kill("SIGTERM");
    expect((await be.exited).code).toBe(0);

    const lines = be
      .stdout()
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(5);
    const records = lines.map((l) => {
      let r: Record<string, unknown> | null = null;
      try {
        r = JSON.parse(l) as Record<string, unknown>;
      } catch {
        // so sánh bên dưới sẽ báo dòng không phải JSON
      }
      expect({ line: l.slice(0, 200), json: r !== null }).toEqual({ line: l.slice(0, 200), json: true });
      return r!;
    });
    for (const r of records) {
      expect(String(r.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(r).toMatchObject({ service: "x-shop-backend", version: "0.1.0", env: "development" });
      expect(typeof r.level).toBe("string");
      expect(typeof r.severity_number).toBe("number");
      expect(typeof r.message).toBe("string");
    }
    const access = records.filter((r) => r.message === "http.server.request");
    const count = (path: string) => access.filter((r) => r["url.path"] === path).length;
    // Mỗi request đúng một bản ghi (không thiếu cho request bị chặn sớm, không trùng cho route thường).
    for (const path of [
      "/store/x/products",
      "/auth/user/emailpass",
      "/x/khong-co-route",
      "/admin/users/me",
      "/admin/products",
      "/auth/user/%FF",
    ])
      expect({ path, n: count(path) }).toEqual({ path, n: 1 });
    expect(access.find((r) => r["url.path"] === "/admin/products")).toMatchObject({
      "http.response.status_code": 401,
    });
    for (const r of access) {
      expect(typeof r.trace_id).toBe("string");
      expect(String(r.span_id)).toMatch(/^[0-9a-f]{16}$/);
    }
    const out = be.stdout();
    for (const secret of ["0912345678", "bi-mat-query", email, "mat-khau-sai-0123", "0987654321"])
      expect(out).not.toContain(secret);
  });

  it("hồi quy T-090: URL mã hoá hỏng / dạng tuyệt đối → 4xx, tiến trình KHÔNG chết (không unhandledRejection)", async () => {
    const be = await startBackend({ SHUTDOWN_DRAIN_DELAY_MS: "0", SHUTDOWN_TIMEOUT_MS: "15000" });
    /** Gửi request thô (đường dẫn nguyên văn, không qua chuẩn hoá của client). */
    const raw = (target: string) =>
      new Promise<number>((resolve, reject) => {
        const sock = net.connect(be.port, "127.0.0.1", () => {
          sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        sock.on("data", (c: Buffer) => (data += c.toString("latin1")));
        sock.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? 0)));
        sock.on("error", reject);
      });
    for (const target of [
      "/auth/user/%FF",
      "/store/products/%E0%A4%A",
      "/x/webhooks/%",
      "http://xn--a.com/",
      "http://127.0.0.1/x/health",
    ]) {
      const status = await raw(target);
      expect({ target, ok: status >= 200 && status < 500 }).toEqual({ target, ok: true });
      await sleep(200);
      expect({ target, alive: be.child.exitCode === null }).toEqual({ target, alive: true });
    }
    expect((await request(be.port, "GET", "/x/readyz")).status).toBe(200);
    expect(be.output()).not.toMatch(/unhandledRejection|uncaughtException/);
    be.child.kill("SIGTERM");
    expect((await be.exited).code).toBe(0);
  });

  it("request treo quá trần → thoát mã 1 trong khoảng trần (không chờ SIGKILL của nền tảng)", async () => {
    const TIMEOUT = 4_000;
    const be = await startBackend({ SHUTDOWN_DRAIN_DELAY_MS: "300", SHUTDOWN_TIMEOUT_MS: String(TIMEOUT) });
    const slow = await slowLogin(be.port);
    try {
      await sleep(300);
      const t0 = Date.now();
      be.child.kill("SIGTERM");
      const exit = await be.exited;
      expect(exit).toMatchObject({ code: 1, signal: null });
      expect(exit.at - t0).toBeGreaterThanOrEqual(TIMEOUT - 100);
      expect(exit.at - t0).toBeLessThan(TIMEOUT + 3_000);
      expect(shutdownLines(be.output()).at(-1)).toMatchObject({ level: "error", timeout_ms: TIMEOUT });
    } finally {
      await slow.release();
    }
  });

  /**
   * T-137 / D-081: lượt xả read model hẹn sau sự kiện đang CHỜ khoá catalog (chủ khác giữ) khi SIGTERM tới; khoá nhả
   * ngay sau tín hiệu. Lượt chờ không được giành khoá rồi đồng bộ giữa lúc tắt (bảng read model bị khoá → việc đó treo,
   * tiến trình vượt trần, khoá bỏ lại tới hết lease) — phải thôi chờ, thoát 0 trong trần, dấu bẩn còn lại cho lần sau.
   */
  it("SIGTERM khi lượt xả catalog đang chờ khoá: không giành khoá/đồng bộ giữa lúc tắt → thoát 0 trong trần", async () => {
    const TIMEOUT = 15_000;
    const redisUrl = process.env.REDIS_URL!;
    type RedisClient = {
      set(k: string, v: string, mode: "EX", s: number): Promise<unknown>;
      get(k: string): Promise<string | null>;
      del(k: string): Promise<number>;
      quit(): Promise<unknown>;
    };
    const Redis = createRequire(join(BACKEND_DIR, "package.json"))("ioredis") as new (
      url: string,
      opts?: Record<string, unknown>,
    ) => RedisClient;
    const { Queue } = createRequire(require.resolve("@medusajs/framework"))("bullmq") as {
      Queue: new (
        name: string,
        opts: Record<string, unknown>,
      ) => {
        add(name: string, data: unknown, opts: Record<string, unknown>): Promise<unknown>;
        close(): Promise<void>;
      };
    };
    const LOCK = "medusa_lock:x-shop:catalog-index";
    const FOREIGN = `foreign-${randomUUID()}`;
    const PRODUCT = `prod_t137_${randomUUID().slice(0, 8)}`;
    const be = await startBackend({ SHUTDOWN_DRAIN_DELAY_MS: "1000", SHUTDOWN_TIMEOUT_MS: String(TIMEOUT) });
    const redis = new Redis(redisUrl);
    const queueConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue("events-queue", { prefix: "RedisEventBusService", connection: queueConn });
    const db = new Client({ connectionString: DB_URL });
    await db.connect();
    const tableLock = new Client({ connectionString: DB_URL });
    await tableLock.connect();
    const dirty = async () =>
      Number(
        (
          await db.query("SELECT count(*)::int AS n FROM catalog_index_dirty WHERE product_id = $1", [
            PRODUCT,
          ])
        ).rows[0]!.n,
      );
    try {
      await redis.set(LOCK, FOREIGN, "EX", 600);
      // Sự kiện thật qua event bus của tiến trình con → subscriber đánh dấu + hẹn lượt xả (lượt này chờ khoá).
      await queue.add(
        "product.updated",
        { data: { id: PRODUCT }, metadata: {} },
        { removeOnComplete: true, attempts: 1 },
      );
      await waitFor("dấu bẩn", 10_000, async () => ((await dirty()) > 0 ? true : undefined));
      await sleep(1_500); // lượt hẹn (250 ms) đã chạy và đang chờ khoá
      // Giả lập đồng bộ chậm: lượt xả nào bắt đầu ghi read model sẽ treo tới khi test nhả.
      await tableLock.query("BEGIN");
      await tableLock.query("LOCK TABLE catalog_variant_index IN ACCESS EXCLUSIVE MODE");
      const t0 = Date.now();
      be.child.kill("SIGTERM");
      await sleep(300);
      await redis.del(LOCK); // khoá nhả ngay sau tín hiệu — lượt chờ giành được nếu không biết đang tắt
      const exit = await Promise.race([be.exited, sleep(TIMEOUT + 5_000).then(() => null)]);
      expect(exit).toMatchObject({ code: 0, signal: null });
      expect(exit!.at - t0).toBeLessThan(TIMEOUT);
      expect(await redis.get(LOCK)).toBeNull(); // không bỏ lại khoá tới hết lease
      await tableLock.query("COMMIT");
      expect(await dirty()).toBe(1); // dấu còn cho tiến trình khác/lần chạy sau
      expect(shutdownLines(be.output()).some((l) => l.level === "error")).toBe(false);
    } finally {
      await tableLock.query("ROLLBACK").catch(() => undefined);
      await tableLock.end().catch(() => undefined);
      await db.end().catch(() => undefined);
      await redis.del(LOCK).catch(() => 0);
      await queue.close().catch(() => undefined);
      await queueConn.quit().catch(() => undefined);
      await redis.quit().catch(() => undefined);
    }
  });
});
