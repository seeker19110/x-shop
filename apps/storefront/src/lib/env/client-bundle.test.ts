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

  const byRel = new Map(files.map((f) => [f.rel, f]));
  const isClientRoot = (text: string): boolean => /^\s*["']use client["']/.test(text);

  const isServerActions = (text: string): boolean => /^\s*["']use server["']/.test(text);

  /** Giải import tương đối (`./x`, `../x`) về file nguồn: x.ts, x.tsx, x/index.ts(x). Bỏ qua gói ngoài và alias. */
  function resolveRelative(fromRel: string, spec: string): string | undefined {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base].find((c) =>
      byRel.has(c),
    );
  }

  const IMPORT_RE =
    /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

  /** Đồ thị import: mọi file client + phần bao đóng bắc cầu của chúng, kèm đường đi để báo lỗi dễ đọc. */
  function clientClosure(): Map<string, string[]> {
    const seen = new Map<string, string[]>();
    const queue: string[] = [];
    for (const f of files) {
      if (isClientRoot(f.text)) {
        seen.set(f.rel, [f.rel]);
        queue.push(f.rel);
      }
    }
    while (queue.length > 0) {
      const rel = queue.shift()!;
      // Module "use server": Next thay import từ client bằng stub gọi RPC, mã bên trong không vào bundle client.
      if (isServerActions(byRel.get(rel)!.text)) continue;
      for (const m of byRel.get(rel)!.text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? "";
        if (!spec.startsWith(".")) continue;
        const target = resolveRelative(rel, spec);
        if (target !== undefined && !seen.has(target)) {
          seen.set(target, [...seen.get(rel)!, target]);
          queue.push(target);
        }
      }
    }
    return seen;
  }

  it("bao đóng import của file client không chứa lib/env/index (mang schema + tên biến server)", () => {
    const closure = clientClosure();
    expect(closure.size).toBeGreaterThan(10); // bộ quét thật sự đi được qua nhiều file
    expect(closure.has("lib/analytics/track.ts")).toBe(true); // module trung gian được tính
    expect(closure.has("lib/env/public.ts")).toBe(true);
    const bad = [...closure].filter(([rel]) => rel === "lib/env/index.ts").map(([, p]) => p.join(" -> "));
    expect(bad).toEqual([]);
  });

  it('bao đóng import của file client không chứa file nào nhập "zod"', () => {
    const bad = [...clientClosure()]
      .filter(([rel]) => /from\s*["']zod["']/.test(byRel.get(rel)!.text))
      .map(([, p]) => p.join(" -> "));
    expect(bad).toEqual([]);
  });

  it("bộ quét bắt được vi phạm: track.ts mà nhập ../env sẽ bị phát hiện (kiểm chứng bộ quét)", () => {
    const track = byRel.get("lib/analytics/track.ts")!;
    expect(resolveRelative("lib/analytics/track.ts", "../env")).toBe("lib/env/index.ts");
    expect(track.text).not.toMatch(/from\s*["']\.\.\/env["']/);
  });

  it("file trong bao đóng client không tham chiếu tên biến server (serverEnvSchema)", () => {
    const offenders: string[] = [];
    for (const rel of clientClosure().keys()) {
      for (const k of Object.keys(serverEnvSchema.shape))
        if (byRel.get(rel)!.text.includes(k)) offenders.push(`${rel}:${k}`);
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

describe("BASE-SEC-010: storefront bind 127.0.0.1 mặc định", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "../package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("scripts dev/start truyền -H với HOST mặc định 127.0.0.1 (mặc định của Next là 0.0.0.0)", () => {
    for (const name of ["dev", "start"]) {
      expect(pkg.scripts[name]).toContain('-H "${HOST:-127.0.0.1}"');
    }
  });
});
