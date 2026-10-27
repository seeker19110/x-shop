import path from "node:path";
import {
  DEV_CORS_DEFAULTS,
  DEV_PRIVATE_UPLOAD_DIRNAME,
  DEV_STOREFRONT_URL,
  GHN_REQUIRED,
  formatEnvProblems,
  loadEnvOrExit,
  parseEnv,
  PRODUCTION_REQUIRED,
  ORDER_LOOKUP_DEV_SECRET,
  VNPAY_DEV_DEFAULTS,
  VNPAY_REQUIRED,
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
  ORDER_LOOKUP_SECRET: "order-0123456789abcdef0123456789abcd",
  XS_TRUSTED_PROXIES: "10.0.0.0/8",
  STOREFRONT_URL: "https://shop.example.vn/",
  PRIVATE_UPLOAD_DIR: "/var/lib/xshop/private-uploads",
  STORE_CORS: "https://shop.example.vn",
  ADMIN_CORS: "https://admin.example.vn,http://localhost:9000",
  AUTH_CORS: "https://admin.example.vn,/\\.example\\.vn$/",
  VNPAY_TMN_CODE: "XSHOPPROD",
  VNPAY_HASH_SECRET: "vnpay-0123456789abcdef0123456789abcd",
  VNPAY_PAYMENT_URL: "https://pay.vnpay.example/paymentv2/vpcpay.html",
  VNPAY_API_URL: "https://pay.vnpay.example/merchant_webapi/api/transaction",
  VNPAY_RETURN_URL: "https://shop.example.vn/thanh-toan/ket-qua",
  VNPAY_MODE: "live",
  GHN_MODE: "live",
  GHN_BASE_URL: "https://ghn.example.vn/shiip/public-api",
  GHN_TOKEN: "ghn-token-0123456789abcdef",
  GHN_SHOP_ID: "123456",
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

  it("VNPAY: dev/test vắng biến → cấu hình giả mặc định; VNPAY_ENABLED sai định dạng → lỗi", () => {
    const result = parseEnv({ DATABASE_URL: DB, NODE_ENV: "test" });
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.vnpay).toEqual({
      tmnCode: VNPAY_DEV_DEFAULTS.VNPAY_TMN_CODE,
      hashSecret: VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET,
      hashSecretPrevious: null,
      paymentUrl: VNPAY_DEV_DEFAULTS.VNPAY_PAYMENT_URL,
      apiUrl: VNPAY_DEV_DEFAULTS.VNPAY_API_URL,
      returnUrl: VNPAY_DEV_DEFAULTS.VNPAY_RETURN_URL,
      mode: "mock",
    });
    expect(variablesOf({ DATABASE_URL: DB, VNPAY_ENABLED: "co" })).toEqual(["VNPAY_ENABLED"]);
    expect(variablesOf({ DATABASE_URL: DB, VNPAY_TMN_CODE: "mã có dấu" })).toEqual(["VNPAY_TMN_CODE"]);
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

describe("parseEnv — GHN ở dev/test", () => {
  it("vắng GHN_MODE → mock, không đòi token; sandbox thiếu token → lỗi", () => {
    const result = parseEnv({ DATABASE_URL: DB });
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.ghn.mode).toBe("mock");
    expect(variablesOf({ DATABASE_URL: DB, GHN_MODE: "sandbox" }).sort()).toEqual([...GHN_REQUIRED].sort());
    expect(variablesOf({ DATABASE_URL: DB, GHN_MODE: "that" })).toEqual(["GHN_MODE"]);
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

  it("vắng tất cả → liệt kê đủ mọi biến bắt buộc (VNPAY bật mặc định)", () => {
    expect(variablesOf({ NODE_ENV: "production", DATABASE_URL: DB }).sort()).toEqual(
      [...PRODUCTION_REQUIRED, ...VNPAY_REQUIRED, "VNPAY_MODE", "GHN_MODE"].sort(),
    );
  });

  it("vắng từng biến VNPAY khi bật → nêu đúng tên biến đó", () => {
    for (const key of VNPAY_REQUIRED) {
      expect(variablesOf({ ...production, [key]: undefined })).toEqual([key]);
    }
  });

  it("VNPAY_ENABLED=false → không đòi biến VNPAY, cấu hình vnpay = null", () => {
    const source: Record<string, string | undefined> = { ...production, VNPAY_ENABLED: "false" };
    for (const key of VNPAY_REQUIRED) source[key] = undefined;
    source.VNPAY_MODE = undefined;
    const result = parseEnv(source);
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.vnpay).toBeNull();
  });

  it("khoá VNPAY giả của dev hoặc URL không https bị từ chối", () => {
    expect(variablesOf({ ...production, VNPAY_HASH_SECRET: VNPAY_DEV_DEFAULTS.VNPAY_HASH_SECRET })).toEqual([
      "VNPAY_HASH_SECRET",
    ]);
    expect(variablesOf({ ...production, VNPAY_RETURN_URL: "http://shop.example.vn/ket-qua" })).toEqual([
      "VNPAY_RETURN_URL",
    ]);
  });

  it("đủ biến VNPAY → cấu hình đúng giá trị đã đặt", () => {
    const result = parseEnv(production);
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.vnpay).toEqual({
      tmnCode: production.VNPAY_TMN_CODE,
      hashSecret: production.VNPAY_HASH_SECRET,
      hashSecretPrevious: null,
      paymentUrl: production.VNPAY_PAYMENT_URL,
      apiUrl: production.VNPAY_API_URL,
      returnUrl: production.VNPAY_RETURN_URL,
      mode: "live",
    });
  });

  it("VNPAY_MODE: production thiếu hoặc mock → lỗi; sai giá trị → lỗi", () => {
    expect(variablesOf({ ...production, VNPAY_MODE: undefined })).toEqual(["VNPAY_MODE"]);
    expect(variablesOf({ ...production, VNPAY_MODE: "mock" })).toEqual(["VNPAY_MODE"]);
    expect(variablesOf({ ...production, VNPAY_MODE: "that" })).toEqual(["VNPAY_MODE"]);
    expect(parseEnv({ ...production, VNPAY_MODE: "sandbox" }).ok).toBe(true);
  });

  it("GHN: production thiếu mode hoặc mock → lỗi; live/sandbox thiếu token/shop/URL → nêu đúng tên; URL http → lỗi", () => {
    expect(variablesOf({ ...production, GHN_MODE: undefined })).toEqual(["GHN_MODE"]);
    expect(variablesOf({ ...production, GHN_MODE: "mock" })).toEqual(["GHN_MODE"]);
    for (const key of GHN_REQUIRED) {
      expect(variablesOf({ ...production, [key]: undefined })).toEqual([key]);
      expect(variablesOf({ ...production, GHN_MODE: "sandbox", [key]: undefined })).toEqual([key]);
    }
    expect(variablesOf({ ...production, GHN_BASE_URL: "http://ghn.example.vn/api" })).toEqual([
      "GHN_BASE_URL",
    ]);
    expect(variablesOf({ ...production, GHN_SHOP_ID: "abc" })).toEqual(["GHN_SHOP_ID"]);
    const result = parseEnv(production);
    if (!result.ok) throw new Error("mong đợi hợp lệ");
    expect(result.env.ghn).toEqual({
      mode: "live",
      baseUrl: production.GHN_BASE_URL,
      token: production.GHN_TOKEN,
      shopId: production.GHN_SHOP_ID,
    });
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

describe("ORDER_LOOKUP_SECRET (T-021)", () => {
  it("dev/test vắng → khoá giả của dev; production dùng đúng giá trị đã đặt", () => {
    const dev = parseEnv({ DATABASE_URL: DB });
    expect(dev.ok && dev.env.orderLookupSecret).toBe(ORDER_LOOKUP_DEV_SECRET);
    const prod = parseEnv(production);
    expect(prod.ok && prod.env.orderLookupSecret).toBe(production.ORDER_LOOKUP_SECRET);
  });

  it("production: thiếu, ngắn hoặc dùng khoá giả của dev → lỗi đúng tên biến", () => {
    expect(variablesOf({ ...production, ORDER_LOOKUP_SECRET: undefined })).toEqual(["ORDER_LOOKUP_SECRET"]);
    expect(variablesOf({ ...production, ORDER_LOOKUP_SECRET: "ngan-qua" })).toEqual(["ORDER_LOOKUP_SECRET"]);
    expect(variablesOf({ ...production, ORDER_LOOKUP_SECRET: ORDER_LOOKUP_DEV_SECRET })).toEqual([
      "ORDER_LOOKUP_SECRET",
    ]);
  });
});

describe("STOREFRONT_URL (T-149 — gốc liên kết gửi khách)", () => {
  it("dev/test vắng → localhost:3000; đặt thì bỏ `/` cuối, giữ tiền tố đường dẫn", () => {
    const dev = parseEnv({ DATABASE_URL: DB });
    expect(dev.ok && dev.env.storefrontUrl).toBe(DEV_STOREFRONT_URL);
    const prod = parseEnv(production);
    expect(prod.ok && prod.env.storefrontUrl).toBe("https://shop.example.vn");
    const prefixed = parseEnv({ DATABASE_URL: DB, STOREFRONT_URL: "http://localhost:8000/shop//" });
    expect(prefixed.ok && prefixed.env.storefrontUrl).toBe("http://localhost:8000/shop");
  });

  it("sai dạng (không phải http(s), có query/fragment/thông tin đăng nhập, không phải URL) → lỗi đúng tên, không lộ giá trị", () => {
    for (const bad of [
      "ftp://shop.example.vn",
      "javascript:alert(1)",
      "shop.example.vn",
      "https://shop.example.vn/?a=1",
      "https://shop.example.vn/?",
      "https://shop.example.vn/#x",
      "https://user:mat-khau@shop.example.vn",
      "https://@shop.example.vn",
    ]) {
      const problems = problemsOf({ DATABASE_URL: DB, STOREFRONT_URL: bad });
      expect(problems.map((p) => p.variable)).toEqual(["STOREFRONT_URL"]);
      expect(JSON.stringify(problems)).not.toContain("mat-khau");
    }
  });

  it("production: bắt buộc và phải https://", () => {
    expect(variablesOf({ ...production, STOREFRONT_URL: undefined })).toEqual(["STOREFRONT_URL"]);
    expect(variablesOf({ ...production, STOREFRONT_URL: "http://shop.example.vn" })).toEqual([
      "STOREFRONT_URL",
    ]);
  });

  it("review T-149 🟠1: khoảng trắng/xuống dòng/tab/`\\` trong giá trị thô → lỗi (WHATWG URL nuốt hoặc sửa được, link dựng ra thì không)", () => {
    for (const bad of [
      "https://shop.example.vn\n",
      "https://shop.example.vn ",
      " https://shop.example.vn",
      "https://shop.example.vn/\t",
      "https://shop.example.vn\\@evil.example",
      "https://shop.example.vn\\shop",
      "https://shop.example.vn/a b",
    ]) {
      expect(variablesOf({ ...production, STOREFRONT_URL: bad })).toEqual(["STOREFRONT_URL"]);
      expect(variablesOf({ DATABASE_URL: DB, STOREFRONT_URL: bad })).toEqual(["STOREFRONT_URL"]);
    }
  });

  it("gốc dựng từ bản ĐÃ PARSE (origin + pathname, bỏ `/` cuối): scheme/host chuẩn hoá, cổng mặc định bỏ", () => {
    const cases: Array<[string, string]> = [
      ["HTTPS://Shop.Example.VN", "https://shop.example.vn"],
      ["https://shop.example.vn:443/", "https://shop.example.vn"],
      ["https://shop.example.vn/cua-hang/", "https://shop.example.vn/cua-hang"],
      ["https://shop.example.vn/a%20b", "https://shop.example.vn/a%20b"],
    ];
    for (const [raw, base] of cases) {
      const r = parseEnv({ ...production, STOREFRONT_URL: raw });
      expect(r.ok && r.env.storefrontUrl).toBe(base);
    }
  });
});

describe("PRIVATE_UPLOAD_DIR (T-141 — file private ngoài thư mục công khai)", () => {
  const cwdStatic = path.join(process.cwd(), "static");

  it("dev/test vắng → `<cwd>/private-uploads` (cạnh static, không nằm trong); đặt → đường dẫn đã resolve", () => {
    const dev = parseEnv({ DATABASE_URL: DB });
    expect(dev.ok && dev.env.privateUploadDir).toBe(path.join(process.cwd(), DEV_PRIVATE_UPLOAD_DIRNAME));
    const rel = parseEnv({ DATABASE_URL: DB, PRIVATE_UPLOAD_DIR: "./tmp/../riêng tư" });
    expect(rel.ok && rel.env.privateUploadDir).toBe(path.resolve("riêng tư"));
    const prod = parseEnv(production);
    expect(prod.ok && prod.env.privateUploadDir).toBe("/var/lib/xshop/private-uploads");
    expect(parseEnv({ DATABASE_URL: DB, PRIVATE_UPLOAD_DIR: "   " }).ok).toBe(true); // rỗng = không đặt
  });

  it.each([
    ["trùng static", cwdStatic],
    ["trong static", path.join(cwdStatic, "private")],
    ["trong static (tương đối)", "static/private"],
    ["trong static (qua `..`)", path.join(cwdStatic, "a", "..", "b")],
    ["chứa static", process.cwd()],
    ["chứa static (gốc hệ thống)", "/"],
  ])("%s → lỗi đúng tên biến, không in giá trị", (_label, value) => {
    const problems = problemsOf({ DATABASE_URL: DB, PRIVATE_UPLOAD_DIR: value });
    expect(problems.map((p) => p.variable)).toEqual(["PRIVATE_UPLOAD_DIR"]);
    expect(formatEnvProblems(problems)).not.toContain(value === "/" ? "//" : value);
  });

  it.each(["/srv/a\u0000b", "/srv/a\nb", "/srv/\tx", "/srv/x\u007f"])(
    "ký tự điều khiển %j → lỗi",
    (value) => {
      expect(variablesOf({ DATABASE_URL: DB, PRIVATE_UPLOAD_DIR: value })).toEqual(["PRIVATE_UPLOAD_DIR"]);
    },
  );

  it("production: bắt buộc, phải tuyệt đối", () => {
    expect(PRODUCTION_REQUIRED).toContain("PRIVATE_UPLOAD_DIR");
    expect(variablesOf({ ...production, PRIVATE_UPLOAD_DIR: undefined })).toEqual(["PRIVATE_UPLOAD_DIR"]);
    expect(variablesOf({ ...production, PRIVATE_UPLOAD_DIR: "private-uploads" })).toEqual([
      "PRIVATE_UPLOAD_DIR",
    ]);
    expect(variablesOf({ ...production, PRIVATE_UPLOAD_DIR: path.join(cwdStatic, "p") })).toEqual([
      "PRIVATE_UPLOAD_DIR",
    ]);
  });
});
