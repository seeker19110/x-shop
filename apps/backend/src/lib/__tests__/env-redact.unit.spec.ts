import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { DEFAULT_BIND_HOST, formatEffectiveConfig, parseEnv, REDACTED, redactConfig, type Env } from "../env";
import { SECRET_ENV_KEYS, SECRET_LOOKING_NAME, isSecretName } from "../env/redact";

const base = { DATABASE_URL: "postgres://xshop:xshop@localhost:5432/xshop" };

/** Mọi biến bí mật đều được đặt giá trị nhận diện được. */
const withAllSecrets: Record<string, string> = {
  ...base,
  DATABASE_URL: "postgres://xshop:SENTINEL-db-pass@localhost:5432/xshop",
  REDIS_URL: "redis://default:SENTINEL-redis-pass@localhost:6379",
  JWT_SECRET: "SENTINEL-jwt_secret-0123456789abcdef0123456789",
  COOKIE_SECRET: "SENTINEL-cookie_secret-0123456789abcdef0123456",
  AUTH_MFA_ENCRYPTION_KEY: "SENTINEL-auth_mfa_encryption_key-0123456789abcdef",
  ORDER_LOOKUP_SECRET: "SENTINEL-order_lookup_secret-0123456789abcdef",
  VNPAY_HASH_SECRET: "SENTINEL-vnpay_hash_secret-0123456789abcdef0123",
  VNPAY_HASH_SECRET_PREVIOUS: "SENTINEL-vnpay_hash_secret_previous-0123456789ab",
  GHN_MODE: "sandbox",
  GHN_BASE_URL: "https://ghn.example.vn",
  GHN_TOKEN: "SENTINELtokenghn0123456789",
  GHN_SHOP_ID: "123",
};

const SENTINEL_VALUES = [
  "SENTINEL-db-pass",
  "SENTINEL-redis-pass",
  "SENTINEL-jwt_secret",
  "SENTINEL-cookie_secret",
  "SENTINEL-auth_mfa_encryption_key",
  "SENTINEL-order_lookup_secret",
  "SENTINEL-vnpay_hash_secret",
  "SENTINEL-vnpay_hash_secret_previous",
  "SENTINELtokenghn",
];

function parse(source: Record<string, string>): Env {
  const r = parseEnv(source);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.env;
}

const expectNoSecret = (text: string): void => {
  for (const s of SENTINEL_VALUES) expect(text).not.toContain(s);
};

describe("BASE-CFG-005: che bí mật khi in/dump cấu hình", () => {
  const env = parse(withAllSecrets);

  it("mọi giá trị nhận diện đều có mặt trong đối tượng thật (test không rỗng)", () => {
    expect(env.JWT_SECRET).toContain("SENTINEL-jwt_secret");
    expect(env.vnpay?.hashSecretPrevious).toContain("SENTINEL-vnpay_hash_secret_previous");
    expect(env.ghn.token).toContain("SENTINELtokenghn");
  });

  it("JSON.stringify(env) không chứa bí mật nào", () => {
    const text = JSON.stringify(env);
    expectNoSecret(text);
    expect(JSON.parse(text)).toMatchObject({
      JWT_SECRET: REDACTED,
      DATABASE_URL: REDACTED,
      REDIS_URL: REDACTED,
      VNPAY_HASH_SECRET: REDACTED,
      GHN_TOKEN: REDACTED,
      orderLookupSecret: REDACTED,
      vnpay: { hashSecret: REDACTED, hashSecretPrevious: REDACTED },
      ghn: { token: REDACTED },
    });
  });

  it("util.inspect / formatEffectiveConfig không lộ bí mật", () => {
    expectNoSecret(inspect(env, { depth: 10 }));
    expectNoSecret(formatEffectiveConfig(env));
  });

  it("che đủ MỌI biến trong SECRET_ENV_KEYS", () => {
    for (const key of SECRET_ENV_KEYS) {
      const out = redactConfig({ [key]: "gia-tri-that", other: "ok" }) as Record<string, string>;
      expect(out[key]).toBe(REDACTED);
      expect(out.other).toBe("ok");
    }
  });

  it("hàng rào: mọi trường (kể cả lồng) tên giống bí mật phải đã đăng ký", () => {
    const names: string[] = [];
    const visit = (o: unknown): void => {
      if (o === null || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        names.push(k);
        visit(v);
      }
    };
    visit(env);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => SECRET_LOOKING_NAME.test(n) && !isSecretName(n))).toEqual([]);
  });

  it("không sửa đối tượng gốc; giữ null/undefined; cắt vòng tham chiếu", () => {
    const src: Record<string, unknown> = {
      JWT_SECRET: "x",
      GHN_TOKEN: null,
      REDIS_URL: undefined,
      nested: [{ token: "t" }],
    };
    src.self = src;
    const out = redactConfig(src) as Record<string, unknown>;
    expect(src.JWT_SECRET).toBe("x");
    expect(out.JWT_SECRET).toBe(REDACTED);
    expect(out.GHN_TOKEN).toBeNull();
    expect(out.REDIS_URL).toBeUndefined();
    expect(out.nested).toEqual([{ token: REDACTED }]);
    expect(out.self).toBe("[Circular]");
  });

  it("truy cập trường trực tiếp vẫn trả giá trị thật", () => {
    expect(env.JWT_SECRET).toContain("SENTINEL-jwt_secret");
    expect(env.vnpay?.hashSecret).toContain("SENTINEL-vnpay_hash_secret");
  });

  it("Unicode trong khoá/giá trị không làm hỏng việc che", () => {
    const out = redactConfig({ "ghi-chú": "đ", JWT_SECRET: "bí-mật-đ" });
    expect(out).toEqual({ "ghi-chú": "đ", JWT_SECRET: REDACTED });
  });
});

describe("BASE-CFG-007 / BASE-SEC-010: mặc định an toàn", () => {
  it("vắng HOST → bind 127.0.0.1 (mọi NODE_ENV)", () => {
    expect(parse(base).host).toBe(DEFAULT_BIND_HOST);
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    expect(parse({ ...base, NODE_ENV: "test" }).host).toBe("127.0.0.1");
  });

  it("HOST rỗng/khoảng trắng coi như vắng; đặt tường minh được tôn trọng", () => {
    expect(parse({ ...base, HOST: "  " }).host).toBe("127.0.0.1");
    expect(parse({ ...base, HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(parse({ ...base, HOST: "::1" }).host).toBe("::1");
  });

  it.each(["http://0.0.0.0", "a b", "host/x", "a@b", "0.0.0.0:9000"])(
    "HOST sai định dạng %j bị từ chối",
    (HOST) => {
      const r = parseEnv({ ...base, HOST });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problems.map((p) => p.variable)).toContain("HOST");
    },
  );

  it("DEBUG tắt khi vắng/rỗng/false/0", () => {
    expect(parse(base).DEBUG).toBe(false);
    for (const v of ["", "false", "FALSE", "0", "off", " no "]) {
      expect(parse({ ...base, DEBUG: v }).DEBUG).toBe(false);
    }
  });

  it("DEBUG bật được ở dev (true/1/namespace) nhưng bị từ chối ở production", () => {
    for (const v of ["true", "1", "medusa:*"]) {
      expect(parse({ ...base, DEBUG: v }).DEBUG).toBe(true);
    }
    const prodNoDebug = parseEnv({ ...base, NODE_ENV: "production" });
    expect(prodNoDebug.ok).toBe(false); // thiếu biến bắt buộc, nhưng KHÔNG vì DEBUG
    if (!prodNoDebug.ok) expect(prodNoDebug.problems.map((p) => p.variable)).not.toContain("DEBUG");
    const prodDebug = parseEnv({ ...base, NODE_ENV: "production", DEBUG: "true" });
    expect(prodDebug.ok).toBe(false);
    if (!prodDebug.ok) {
      expect(prodDebug.problems.find((p) => p.variable === "DEBUG")?.reason).toBe(
        "phải tắt khi NODE_ENV=production",
      );
    }
  });

  it("cấu hình hiệu lực in ra (đã che) khớp bảng mặc định an toàn", () => {
    const printed = JSON.parse(formatEffectiveConfig(parse(base))) as Record<string, unknown>;
    expect(printed).toMatchObject({ host: "127.0.0.1", DEBUG: false, DATABASE_URL: REDACTED });
    expect(JSON.stringify(printed)).not.toContain("xshop:xshop");
  });

  it("scripts dev/start truyền -H ${HOST:-127.0.0.1} cho Medusa", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const name of ["dev", "start"]) {
      expect(pkg.scripts[name]).toContain("-H ${HOST:-127.0.0.1}");
    }
  });
});
