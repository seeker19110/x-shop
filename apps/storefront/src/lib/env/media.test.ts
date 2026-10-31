// @vitest-environment node
import { buildCsp } from "../security/csp";
import { parseServerEnv } from "./index";
import { imageRemotePatterns, MEDIA_URL_ENV } from "./media";

/** T-154 — ảnh từ kho S3 dùng chung: `XS_MEDIA_URL` → `images.remotePatterns` của next/image. */

describe("imageRemotePatterns", () => {
  it("vắng XS_MEDIA_URL → chỉ `/static/**` của backend (như trước T-154)", () => {
    expect(imageRemotePatterns({ MEDUSA_BACKEND_URL: "http://localhost:9000" })).toEqual([
      { protocol: "http", hostname: "localhost", port: "9000", pathname: "/static/**" },
    ]);
    expect(imageRemotePatterns({})).toEqual([]);
    expect(imageRemotePatterns({ [MEDIA_URL_ENV]: "   " })).toEqual([]); // rỗng = vắng
  });

  it("CDN/website endpoint (https, gốc) → host đó, mọi đường dẫn", () => {
    expect(
      imageRemotePatterns({
        NODE_ENV: "production",
        MEDUSA_BACKEND_URL: "https://api.shop.example.vn",
        XS_MEDIA_URL: "https://media.shop.example.vn/",
      }),
    ).toEqual([
      { protocol: "https", hostname: "api.shop.example.vn", pathname: "/static/**" },
      { protocol: "https", hostname: "media.shop.example.vn", pathname: "/**" },
    ]);
  });

  it("path-style `<endpoint>/<bucket>` (dev) → giữ cổng + tiền tố bucket, không mở cả host", () => {
    expect(imageRemotePatterns({ XS_MEDIA_URL: "http://127.0.0.1:3900/xshop-public" })).toEqual([
      { protocol: "http", hostname: "127.0.0.1", port: "3900", pathname: "/xshop-public/**" },
    ]);
  });

  it("production + http → ném lỗi nêu tên biến (build/start dừng)", () => {
    expect(() =>
      imageRemotePatterns({ NODE_ENV: "production", XS_MEDIA_URL: "http://media.shop.example.vn" }),
    ).toThrow(/XS_MEDIA_URL: phải dùng https:\/\/ ở production/);
  });

  it.each([
    "ftp://media.example",
    "javascript:alert(1)",
    "https://u:p@media.example",
    "https://media.example/?q=1",
    "https://media.example/#x",
    "https://media.example\\@evil.example",
    "khong-phai-url",
  ])("%j → ném lỗi nêu tên biến, không in giá trị", (value) => {
    let message = "";
    try {
      imageRemotePatterns({ XS_MEDIA_URL: value });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("XS_MEDIA_URL");
    expect(message).not.toContain(value);
  });
});

describe("XS_MEDIA_URL trong schema server", () => {
  const base = { MEDUSA_BACKEND_URL: "https://api.shop.example.vn" };
  it("chuẩn hoá (bỏ `/` cuối); vắng/rỗng = undefined; sai → lỗi nêu tên biến", () => {
    expect(
      parseServerEnv({ ...base, XS_MEDIA_URL: "https://media.example/p/" }, { useDefaults: false })
        .XS_MEDIA_URL,
    ).toBe("https://media.example/p");
    expect(
      parseServerEnv({ ...base, XS_MEDIA_URL: " " }, { useDefaults: false }).XS_MEDIA_URL,
    ).toBeUndefined();
    expect(() => parseServerEnv({ ...base, XS_MEDIA_URL: "ftp://x" }, { useDefaults: false })).toThrow(
      /XS_MEDIA_URL/,
    );
  });
});

describe("CSP không nới img-src cho kho ảnh (ảnh đi qua /_next/image cùng origin)", () => {
  it("img-src vẫn chỉ 'self' data: blob:", () => {
    const csp = buildCsp({ nonce: "n", dev: false, production: true });
    expect(csp).toContain("img-src 'self' data: blob:;");
  });
});
