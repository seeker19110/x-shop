// @vitest-environment node
import {
  getClientEnv,
  getServerEnv,
  parseClientEnv,
  parseServerEnv,
  resetEnvCacheForTests,
  shouldUseDefaults,
} from "./env";

const GOOD_CLIENT = {
  NEXT_PUBLIC_SITE_URL: "https://shop.example.vn/",
  NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: "pk_live_abc",
};

describe("parseClientEnv", () => {
  it("chuẩn hoá URL (bỏ dấu / cuối) và giữ key", () => {
    const env = parseClientEnv(GOOD_CLIENT, { useDefaults: false });
    expect(env.NEXT_PUBLIC_SITE_URL).toBe("https://shop.example.vn");
    expect(env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY).toBe("pk_live_abc");
  });

  it("thiếu biến + không mặc định → lỗi nêu tên biến", () => {
    expect(() => parseClientEnv({}, { useDefaults: false })).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it("chuỗi rỗng/khoảng trắng coi như thiếu: dùng mặc định khi cho phép", () => {
    const env = parseClientEnv(
      { NEXT_PUBLIC_SITE_URL: "  ", NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: "" },
      { useDefaults: true },
    );
    expect(env.NEXT_PUBLIC_SITE_URL).toBe("http://localhost:3000");
  });

  it("từ chối scheme không phải http(s)", () => {
    expect(() =>
      parseClientEnv({ ...GOOD_CLIENT, NEXT_PUBLIC_SITE_URL: "javascript:alert(1)" }, { useDefaults: false }),
    ).toThrow(/NEXT_PUBLIC_SITE_URL/);
    expect(() =>
      parseClientEnv({ ...GOOD_CLIENT, NEXT_PUBLIC_SITE_URL: "ftp://x.vn" }, { useDefaults: false }),
    ).toThrow(/http/);
  });

  it("không lộ biến lạ (kể cả biến server) vào client env", () => {
    const env = parseClientEnv(
      { ...GOOD_CLIENT, MEDUSA_BACKEND_URL: "http://secret" },
      { useDefaults: false },
    );
    expect(Object.keys(env).sort()).toEqual(["NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY", "NEXT_PUBLIC_SITE_URL"]);
  });
});

describe("parseServerEnv", () => {
  it("đọc MEDUSA_BACKEND_URL", () => {
    expect(parseServerEnv({ MEDUSA_BACKEND_URL: "http://medusa:9000/" }, { useDefaults: false })).toEqual({
      MEDUSA_BACKEND_URL: "http://medusa:9000",
    });
  });

  it("thiếu → lỗi; có cho phép mặc định → localhost", () => {
    expect(() => parseServerEnv({}, { useDefaults: false })).toThrow(/MEDUSA_BACKEND_URL/);
    expect(parseServerEnv({}, { useDefaults: true }).MEDUSA_BACKEND_URL).toBe("http://localhost:9000");
  });

  it("URL sai định dạng → lỗi", () => {
    expect(() => parseServerEnv({ MEDUSA_BACKEND_URL: "không phải url" }, { useDefaults: false })).toThrow();
  });
});

describe("shouldUseDefaults", () => {
  it("dev/test: có mặc định", () => {
    expect(shouldUseDefaults({ NODE_ENV: "development" })).toBe(true);
    expect(shouldUseDefaults({ NODE_ENV: "test" })).toBe(true);
  });
  it("build production: có mặc định (build không đòi env thật)", () => {
    expect(shouldUseDefaults({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" })).toBe(true);
  });
  it("runtime production: không mặc định", () => {
    expect(shouldUseDefaults({ NODE_ENV: "production" })).toBe(false);
  });
});

describe("getters lười + cache", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetEnvCacheForTests();
  });

  it("getServerEnv/getClientEnv dùng mặc định ở môi trường test và cache kết quả", () => {
    delete process.env.MEDUSA_BACKEND_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    resetEnvCacheForTests();
    const a = getServerEnv();
    expect(a.MEDUSA_BACKEND_URL).toBe("http://localhost:9000");
    expect(getServerEnv()).toBe(a);
    expect(getClientEnv().NEXT_PUBLIC_SITE_URL).toBe("http://localhost:3000");
  });
});
