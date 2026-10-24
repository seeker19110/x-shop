import {
  DEV_CORS_DEFAULTS,
  formatEnvProblems,
  loadEnvOrExit,
  parseEnv,
  PRODUCTION_REQUIRED,
  type ExitHooks,
} from "../env";

const DB = "postgres://user:pa55-db-secret@localhost:5432/xshop";
const JWT = "jwt-0123456789abcdef0123456789abcdef";
const COOKIE = "cookie-0123456789abcdef0123456789abcd";
const MFA = "mfa-0123456789abcdef0123456789abcdef0";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: DB,
  REDIS_URL: "rediss://default:redis-pass@cache.example.vn:6380",
  JWT_SECRET: JWT,
  COOKIE_SECRET: COOKIE,
  AUTH_MFA_ENCRYPTION_KEY: MFA,
  STORE_CORS: "https://shop.example.vn",
  ADMIN_CORS: "https://admin.example.vn,http://localhost:9000",
  AUTH_CORS: "https://admin.example.vn,/\\.example\\.vn$/",
};

const problemsOf = (source: Record<string, string | undefined>) => {
  const result = parseEnv(source);
  if (result.ok) throw new Error("mong đợi lỗi cấu hình");
  return result.problems;
};

const variablesOf = (source: Record<string, string | undefined>) => problemsOf(source).map((p) => p.variable);

describe("parseEnv — development/test", () => {
  it("chỉ cần DATABASE_URL; còn lại lấy mặc định", () => {
    const result = parseEnv({ DATABASE_URL: DB });
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env).toMatchObject({
      NODE_ENV: "development",
      DATABASE_URL: DB,
      MEDUSA_WORKER_MODE: "shared",
      DISABLE_MEDUSA_ADMIN: false,
    });
    expect(result.env.REDIS_URL).toBeUndefined();
    expect(result.env.JWT_SECRET).toBeUndefined();
    expect(result.env).toMatchObject(DEV_CORS_DEFAULTS);
  });

  it("CORS đã đặt thì giữ nguyên, không bị mặc định dev đè", () => {
    const result = parseEnv({ DATABASE_URL: DB, STORE_CORS: "https://shop.example.vn" });
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.STORE_CORS).toBe("https://shop.example.vn");
    expect(result.env.ADMIN_CORS).toBe(DEV_CORS_DEFAULTS.ADMIN_CORS);
  });

  it.each([
    ["vắng", undefined],
    ["rỗng", ""],
    ["toàn khoảng trắng", "   "],
  ])("DATABASE_URL %s → lỗi 'bắt buộc'", (_label, value) => {
    expect(problemsOf({ NODE_ENV: "test", DATABASE_URL: value })).toEqual([
      { variable: "DATABASE_URL", reason: "bắt buộc" },
    ]);
  });

  it.each(["mysql://u:p@localhost/db", "localhost:5432/xshop", "postgres://"])(
    "DATABASE_URL sai giao thức/định dạng (%s) → lỗi",
    (value) => {
      expect(variablesOf({ DATABASE_URL: value })).toEqual(["DATABASE_URL"]);
    },
  );

  it("biến tùy chọn CÓ đặt thì vẫn phải đúng định dạng", () => {
    expect(
      variablesOf({
        DATABASE_URL: DB,
        REDIS_URL: "http://localhost:6379",
        JWT_SECRET: "ngan",
        STORE_CORS: "http://localhost:8000/duong-dan",
        NODE_ENV: "staging",
        MEDUSA_WORKER_MODE: "both",
        DISABLE_MEDUSA_ADMIN: "yes",
      }).sort(),
    ).toEqual(
      [
        "DISABLE_MEDUSA_ADMIN",
        "JWT_SECRET",
        "MEDUSA_WORKER_MODE",
        "NODE_ENV",
        "REDIS_URL",
        "STORE_CORS",
      ].sort(),
    );
  });

  it("biến rỗng được coi như không đặt", () => {
    const result = parseEnv({ DATABASE_URL: DB, REDIS_URL: "", JWT_SECRET: "", DISABLE_MEDUSA_ADMIN: "" });
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.REDIS_URL).toBeUndefined();
    expect(result.env.JWT_SECRET).toBeUndefined();
    expect(result.env.DISABLE_MEDUSA_ADMIN).toBe(false);
  });

  it("CORS: nhận danh sách origin và /regex/; từ chối mục rỗng", () => {
    expect(parseEnv({ DATABASE_URL: DB, STORE_CORS: "http://localhost:8000,/\\.vercel\\.app$/" }).ok).toBe(
      true,
    );
    expect(variablesOf({ DATABASE_URL: DB, STORE_CORS: "http://a.vn,,http://b.vn" })).toEqual(["STORE_CORS"]);
  });

  it("DISABLE_MEDUSA_ADMIN=true → true", () => {
    const result = parseEnv({ DATABASE_URL: DB, DISABLE_MEDUSA_ADMIN: "true" });
    expect(result.ok && result.env.DISABLE_MEDUSA_ADMIN).toBe(true);
  });

  it("bí mật Unicode đủ 32 ký tự được chấp nhận", () => {
    const unicode = "mậtkhẩuđủdàiđểkýjwtchoxshopViệtNam";
    expect(unicode.length).toBeGreaterThanOrEqual(32);
    expect(parseEnv({ DATABASE_URL: DB, JWT_SECRET: unicode }).ok).toBe(true);
  });
});

describe("parseEnv — production", () => {
  it("đủ biến hợp lệ → ok, giữ đúng CORS đã đặt", () => {
    const result = parseEnv(production);
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.STORE_CORS).toBe(production.STORE_CORS);
    expect(result.env.AUTH_CORS).toBe(production.AUTH_CORS);
  });

  it("vắng từng biến bắt buộc → nêu đúng tên biến đó", () => {
    for (const key of PRODUCTION_REQUIRED) {
      expect(variablesOf({ ...production, [key]: undefined })).toEqual([key]);
    }
  });

  it("vắng tất cả → liệt kê đủ mọi biến bắt buộc", () => {
    expect(variablesOf({ NODE_ENV: "production", DATABASE_URL: DB }).sort()).toEqual(
      [...PRODUCTION_REQUIRED].sort(),
    );
  });

  it("bí mật mặc định công khai/quá ngắn bị từ chối", () => {
    expect(variablesOf({ ...production, JWT_SECRET: "supersecret" })).toEqual(["JWT_SECRET"]);
  });

  it("COOKIE_SECRET trùng JWT_SECRET bị từ chối", () => {
    expect(variablesOf({ ...production, COOKIE_SECRET: JWT })).toEqual(["COOKIE_SECRET"]);
  });
});

describe("thông báo lỗi không lộ giá trị", () => {
  it("formatEnvProblems chỉ có tên biến + lý do", () => {
    const leaky = {
      ...production,
      DATABASE_URL: "mysql://root:db-password-leak@db/x",
      JWT_SECRET: "short-jwt-leak",
      COOKIE_SECRET: "short-cookie-leak",
      REDIS_URL: "ftp://redis-leak",
      STORE_CORS: "not a url leak",
    };
    const message = formatEnvProblems(problemsOf(leaky));
    for (const value of Object.values(leaky)) {
      if (value === "production") continue;
      if (Object.values(production).includes(value)) continue; // giá trị hợp lệ không có trong lỗi đã kiểm riêng
      expect(message).not.toContain(value);
    }
    expect(message).not.toMatch(/leak/);
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("JWT_SECRET");
  });
});

describe("loadEnvOrExit", () => {
  const hooks = () => {
    const writes: string[] = [];
    const exits: number[] = [];
    const h: ExitHooks = {
      writeError: (m) => {
        writes.push(m);
      },
      exit: (code) => {
        exits.push(code);
        throw new Error(`exit ${code}`);
      },
    };
    return { h, writes, exits };
  };

  it("sai → in tên biến ra stderr và thoát mã 1", () => {
    const { h, writes, exits } = hooks();
    expect(() => loadEnvOrExit({ NODE_ENV: "production", DATABASE_URL: DB }, h)).toThrow("exit 1");
    expect(exits).toEqual([1]);
    expect(writes).toHaveLength(1);
    for (const key of PRODUCTION_REQUIRED) expect(writes[0]).toContain(key);
    expect(writes[0]).not.toContain("pa55-db-secret");
  });

  it("đúng → trả cấu hình, không thoát", () => {
    const { h, writes, exits } = hooks();
    expect(loadEnvOrExit(production, h).NODE_ENV).toBe("production");
    expect(writes).toEqual([]);
    expect(exits).toEqual([]);
  });
});
