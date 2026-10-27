// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientEnvSchema,
  getServerEnv,
  parseClientEnv,
  resetEnvCacheForTests,
  serverEnvSchema,
} from "./index";

/**
 * FE-BUILD-005: biến server không được lọt vào bundle client; không đọc `process.env.X` ngoài module env.
 * Bundle client chỉ chứa giá trị của `NEXT_PUBLIC_*` được Next nhúng; test dưới chặn các đường để biến server lọt vào.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listSources(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = listSources(SRC).map((p) => ({
  rel: path.relative(SRC, p).split(path.sep).join("/"),
  text: fs.readFileSync(p, "utf8"),
}));

describe("schema client/server tách bạch", () => {
  const clientKeys = Object.keys(clientEnvSchema.shape);
  const serverKeys = Object.keys(serverEnvSchema.shape);

  it("mọi khoá schema client đều có tiền tố NEXT_PUBLIC_, không khoá server nào có", () => {
    expect(clientKeys.length).toBeGreaterThan(0);
    for (const k of clientKeys) expect(k).toMatch(/^NEXT_PUBLIC_/);
    for (const k of serverKeys) expect(k).not.toMatch(/^NEXT_PUBLIC_/);
  });

  it("hai tập khoá không giao nhau; transport analytics nằm ở client", () => {
    expect(clientKeys.filter((k) => serverKeys.includes(k))).toEqual([]);
    expect(clientKeys).toContain("NEXT_PUBLIC_ANALYTICS_TRANSPORT");
  });

  it("parseClientEnv loại mọi biến server khỏi kết quả dù có trong nguồn", () => {
    const source: Record<string, string> = {
      NEXT_PUBLIC_SITE_URL: "https://shop.example.vn",
      NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: "pk_x",
      MEDUSA_BACKEND_URL: "http://internal-backend:9000",
      XS_DATA_SOURCE: "backend",
      XS_TRUST_PROXY_HEADERS: "true",
      JWT_SECRET: "khong-duoc-lot",
    };
    const env = parseClientEnv(source, { useDefaults: false });
    expect(Object.keys(env).sort()).toEqual([...clientKeys].sort());
    const text = JSON.stringify(env);
    expect(text).not.toContain("internal-backend");
    expect(text).not.toContain("khong-duoc-lot");
  });
});

describe("biến server không lọt vào bundle client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEnvCacheForTests();
  });

  it("getServerEnv() ném lỗi khi chạy ở trình duyệt (có window)", () => {
    vi.stubGlobal("window", {});
    expect(() => getServerEnv()).toThrow(/chỉ được gọi ở server/);
  });

  it('file "use client" chỉ được nhập getClientEnv/getAnalyticsTransport từ module env', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/^\s*["']use client["']/.test(f.text)) continue;
      for (const m of f.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*\/lib\/env["']/g)) {
        const names = m[1]!.split(",").map((n) => n.trim().replace(/^type\s+/, ""));
        if (names.some((n) => n !== "" && !["getClientEnv", "getAnalyticsTransport"].includes(n)))
          offenders.push(f.rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('file "use client" không tham chiếu biến server (tên trong serverEnvSchema)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/^\s*["']use client["']/.test(f.text)) continue;
      for (const k of Object.keys(serverEnvSchema.shape))
        if (f.text.includes(k)) offenders.push(`${f.rel}:${k}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("không đọc process.env ngoài module env", () => {
  // NODE_ENV là cấu hình công cụ (Next nhúng sẵn); client-ip.ts nhận `env` qua tham số mặc định process.env để test được.
  const ALLOWED = new Set(["lib/security/client-ip.ts"]);

  it("mọi `process.env.X` (X ≠ NODE_ENV) nằm trong lib/env/", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (f.rel.startsWith("lib/env/") || ALLOWED.has(f.rel)) continue;
      for (const m of f.text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (m[1] !== "NODE_ENV") offenders.push(`${f.rel}:${m[1]}`);
      }
      if (/process\.env\[/.test(f.text) || /=\s*process\.env\s*[;,)]/.test(f.text))
        offenders.push(`${f.rel}:[dynamic]`);
    }
    expect(offenders).toEqual([]);
  });

  it("proxy.ts lấy NEXT_PUBLIC_SITE_URL qua getClientEnv()", () => {
    const proxy = files.find((f) => f.rel === "proxy.ts")!;
    expect(proxy.text).toContain("getClientEnv().NEXT_PUBLIC_SITE_URL");
    expect(proxy.text).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
  });
});
