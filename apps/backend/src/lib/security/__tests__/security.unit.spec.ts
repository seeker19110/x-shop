import { parseEnv } from "../../env";
import {
  ipRateKey,
  NO_TRUSTED_PROXIES,
  normalizeIp,
  parseTrustedProxies,
  resolveClientIp,
  type TrustedProxies,
} from "../client-ip";
import { checkCsrf, type CsrfInput } from "../csrf";
import { apiSecurityHeaders, HSTS_VALUE } from "../headers";
import { consume, consumeDistinct, retryAfterSeconds, STORE_RATE_LIMITS } from "../rate-limit";
import { checkUploadedFile, sniffImageType, UPLOAD_LIMITS } from "../upload";
import { MemoryCounter } from "./memory-counter";

const trusted = (raw: string): TrustedProxies => {
  const r = parseTrustedProxies(raw);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};

describe("normalizeIp", () => {
  it.each([
    ["1.2.3.4", "1.2.3.4"],
    [" 1.2.3.4 ", "1.2.3.4"],
    ["1.2.3.4:8080", "1.2.3.4"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["::FFFF:1.2.3.4", "1.2.3.4"],
    ["[::ffff:1.2.3.4]:443", "1.2.3.4"],
    ["::ffff:102:304", "1.2.3.4"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    ["[2001:db8::1]:8443", "2001:db8::1"],
    ["fe80::1%eth0", "fe80::1"],
    ["::1", "::1"],
  ])("%p → %p", (raw, expected) => expect(normalizeIp(raw)).toBe(expected));

  it.each([
    undefined,
    null,
    "",
    "   ",
    "unknown",
    "1.2.3",
    "999.1.1.1",
    "1.2.3.4.5",
    "abc::xyz",
    "x".repeat(100),
  ])("%p → null", (raw) => expect(normalizeIp(raw as string)).toBeNull());
});

describe("parseTrustedProxies", () => {
  it("rỗng/vắng → không tin ai", () => {
    for (const raw of [undefined, "", " , "]) {
      const r = parseTrustedProxies(raw);
      expect(r.ok && r.value.entries).toEqual([]);
      expect(r.ok && r.value.has("127.0.0.1")).toBe(false);
    }
  });

  it("IP, CIDR v4/v6, từ khoá", () => {
    const t = trusted("loopback, 10.1.2.3, 192.168.0.0/16, 2001:db8::/32, private");
    expect(t.has("127.0.0.1")).toBe(true);
    expect(t.has("127.9.9.9")).toBe(true);
    expect(t.has("::1")).toBe(true);
    expect(t.has("10.1.2.3")).toBe(true);
    expect(t.has("192.168.44.1")).toBe(true);
    expect(t.has("2001:db8:ffff::1")).toBe(true);
    expect(t.has("172.20.0.1")).toBe(true); // private
    expect(t.has("fd00::1")).toBe(true); // private (fc00::/7)
    expect(t.has("8.8.8.8")).toBe(false);
    expect(t.has("2001:db9::1")).toBe(false);
  });

  it("none (một mình) = không tin ai", () => {
    const r = parseTrustedProxies(" NONE ");
    expect(r.ok && r.value.has("127.0.0.1")).toBe(false);
    expect(parseTrustedProxies("none,loopback").ok).toBe(false);
  });

  it.each([
    "abc",
    "1.2.3.4/33",
    "::1/129",
    "10.0.0.0/8/1",
    "1.2.3.4/-1",
    "1.2.3.4/x",
    Array(65).fill("1.1.1.1").join(","),
  ])("%p → lỗi", (raw) => expect(parseTrustedProxies(raw).ok).toBe(false));
});

describe("resolveClientIp", () => {
  const lb = trusted("10.0.0.0/8, loopback");

  it("mặc định không tin: XFF bị bỏ qua, IP = socket", () => {
    expect(
      resolveClientIp({ remoteAddress: "203.0.113.5", forwardedFor: "1.1.1.1" }, NO_TRUSTED_PROXIES),
    ).toEqual({ ip: "203.0.113.5", internal: false });
    expect(
      resolveClientIp({ remoteAddress: "::ffff:127.0.0.1", forwardedFor: "1.1.1.1" }, NO_TRUSTED_PROXIES),
    ).toEqual({ ip: "127.0.0.1", internal: false });
  });

  it("socket không tin cậy: XFF bị bỏ qua dù danh sách có", () => {
    expect(resolveClientIp({ remoteAddress: "203.0.113.5", forwardedFor: "10.0.0.1" }, lb)).toEqual({
      ip: "203.0.113.5",
      internal: false,
    });
  });

  it("đi ngược chuỗi: bỏ proxy tin cậy, mục đầu không tin cậy là khách; mục trái do client tự khai bị bỏ qua", () => {
    expect(
      resolveClientIp({ remoteAddress: "10.0.0.2", forwardedFor: "6.6.6.6, 198.51.100.7, 10.0.0.9" }, lb),
    ).toEqual({ ip: "198.51.100.7", internal: false });
    // Nhiều header XFF.
    expect(
      resolveClientIp({ remoteAddress: "10.0.0.2", forwardedFor: ["6.6.6.6", "198.51.100.8"] }, lb),
    ).toEqual({
      ip: "198.51.100.8",
      internal: false,
    });
  });

  it("không XFF / XFF rỗng / mọi hop tin cậy → nội bộ (request của chính hạ tầng)", () => {
    for (const forwardedFor of [undefined, null, "", " , ", "10.1.1.1", "10.1.1.1, 127.0.0.1"]) {
      const r = resolveClientIp({ remoteAddress: "127.0.0.1", forwardedFor }, lb);
      expect(r.internal).toBe(true);
    }
  });

  it("XFF hỏng → dừng ở hop tin cậy cuối, KHÔNG nội bộ", () => {
    expect(
      resolveClientIp({ remoteAddress: "10.0.0.2", forwardedFor: "1.1.1.1, garbage, 10.0.0.3" }, lb),
    ).toEqual({
      ip: "10.0.0.3",
      internal: false,
    });
  });

  it("IPv6 và socket thiếu địa chỉ", () => {
    expect(resolveClientIp({ remoteAddress: "::1", forwardedFor: "2001:DB8::5" }, lb)).toEqual({
      ip: "2001:db8::5",
      internal: false,
    });
    expect(resolveClientIp({ remoteAddress: undefined, forwardedFor: "1.1.1.1" }, lb)).toEqual({
      ip: null,
      internal: false,
    });
  });

  it("chuỗi dài bất thường: chỉ xét 16 hop từ phải, bị cắt thì không coi là nội bộ", () => {
    const xff = Array.from({ length: 40 }, () => "10.9.9.9").join(",");
    expect(resolveClientIp({ remoteAddress: "10.0.0.2", forwardedFor: `1.1.1.1,${xff}` }, lb)).toEqual({
      ip: "10.9.9.9",
      internal: false,
    });
  });
});

describe("ipRateKey", () => {
  it("IPv4 nguyên địa chỉ; IPv6 gộp /64", () => {
    expect(ipRateKey("1.2.3.4")).toBe("1.2.3.4");
    expect(ipRateKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipRateKey("2001:db8:1:2:ffff:ffff:ffff:fffe")).toBe("2001:db8:1:2::/64");
    expect(ipRateKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipRateKey("::1")).toBe("0:0:0:0::/64");
    expect(ipRateKey("2001:db8:1:3::1")).not.toBe(ipRateKey("2001:db8:1:2::1"));
  });
});

describe("checkCsrf", () => {
  const base: CsrfInput = {
    method: "POST",
    cookie: "connect.sid=x",
    origin: undefined,
    secFetchSite: undefined,
    allowed: ["https://shop.example.vn", /^https:\/\/[a-z]+\.example\.vn$/],
  };
  const v = (patch: Partial<CsrfInput>) => checkCsrf({ ...base, ...patch });

  it("phương thức an toàn / không cookie → qua", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"])
      expect(v({ method, origin: "https://evil.example" }).ok).toBe(true);
    expect(v({ cookie: undefined, origin: "https://evil.example" }).ok).toBe(true);
    expect(v({ cookie: "  ", origin: "null" }).ok).toBe(true);
  });

  it("origin trong allowlist (chuỗi hoặc regex) → qua; lạ → từ chối", () => {
    expect(v({ origin: "https://shop.example.vn" }).ok).toBe(true);
    expect(v({ origin: "https://admin.example.vn" }).ok).toBe(true);
    expect(v({ origin: "https://shop.example.vn.evil.example" })).toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
    expect(v({ method: "delete", origin: "http://shop.example.vn" })).toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
  });

  it('origin "null" luôn từ chối, kể cả Sec-Fetch-Site same-origin', () => {
    expect(v({ origin: "null" })).toEqual({ ok: false, reason: "origin_null" });
    expect(v({ origin: " Null ", secFetchSite: "same-origin" })).toEqual({
      ok: false,
      reason: "origin_null",
    });
  });

  it("Sec-Fetch-Site", () => {
    expect(v({ origin: "https://khac.example", secFetchSite: "same-origin" }).ok).toBe(true);
    expect(v({ secFetchSite: "cross-site" })).toEqual({ ok: false, reason: "cross_site" });
    expect(v({ secFetchSite: "SAME-SITE" })).toEqual({ ok: false, reason: "cross_site" });
    expect(v({ secFetchSite: "none" }).ok).toBe(true);
    expect(v({ origin: "", secFetchSite: undefined }).ok).toBe(true);
  });
});

describe("apiSecurityHeaders", () => {
  it("HSTS chỉ ở production", () => {
    expect(apiSecurityHeaders(true)["Strict-Transport-Security"]).toBe(HSTS_VALUE);
    expect(apiSecurityHeaders(false)["Strict-Transport-Security"]).toBeUndefined();
    expect(apiSecurityHeaders(false)["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });
});

describe("rate limit", () => {
  const T0 = new Date("2026-10-25T03:00:00.000Z");

  it("retryAfterSeconds: tới lúc lượt kế tiếp được cho qua theo cửa sổ trượt, tối thiểu 1", () => {
    // 61/60 ở đầu cửa sổ, cửa sổ trước rỗng: lượt kế tiếp qua khi 1 + 61·(còn lại) ≤ 60 ở cửa sổ sau (≈ 2 s sau ranh giới).
    expect(retryAfterSeconds("searchIp", { current: 61, previous: 0, elapsedMs: 0 })).toBe(62);
    // Vừa chạm ngưỡng nhưng cửa sổ trước sắp trôi hết → ≥ 1.
    expect(retryAfterSeconds("searchIp", { current: 0, previous: 60, elapsedMs: 59_999 })).toBe(1);
  });

  it("consume: song song → đúng limit lượt lọt; ngay sau ranh giới vẫn chặn, hết hai cửa sổ thì đếm lại", async () => {
    const c = new MemoryCounter();
    const { limit, windowMs } = STORE_RATE_LIMITS.searchIp;
    const results = await Promise.all(
      Array.from({ length: limit + 7 }, () => consume(c, "searchIp", "1.2.3.4", T0)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
    const denied = results.find((r) => !r.allowed);
    expect(denied).toEqual({ allowed: false, policy: "searchIp", retryAfterSeconds: 62 });
    // Cửa sổ cố định cũ cho qua ở đây (đếm về 0) — cửa sổ trượt vẫn tính 67 lượt của cửa sổ trước.
    expect((await consume(c, "searchIp", "1.2.3.4", new Date(T0.getTime() + windowMs))).allowed).toBe(false);
    expect((await consume(c, "searchIp", "1.2.3.4", new Date(T0.getTime() + 2 * windowMs))).allowed).toBe(
      true,
    );
    expect((await consume(c, "searchIp", "5.6.7.8", T0)).allowed).toBe(true);
  });

  it("consumeDistinct: giá trị lặp không tốn lượt; vượt → chặn cả giá trị đã thấy tới khi hiệu dụng hạ", async () => {
    const c = new MemoryCounter();
    const { limit, windowMs } = STORE_RATE_LIMITS.couponCart;
    for (let i = 0; i < 20; i++)
      expect((await consumeDistinct(c, "couponCart", "cart_1", "A", T0)).allowed).toBe(true);
    for (let i = 1; i < limit; i++) {
      expect((await consumeDistinct(c, "couponCart", "cart_1", `C${i}`, T0)).allowed).toBe(true);
    }
    expect((await consumeDistinct(c, "couponCart", "cart_1", "MOI", T0)).allowed).toBe(false);
    expect((await consumeDistinct(c, "couponCart", "cart_1", "A", T0)).allowed).toBe(false);
    expect((await consumeDistinct(c, "couponCart", "cart_2", "A", T0)).allowed).toBe(true);
    const boundary = new Date(T0.getTime() + windowMs);
    expect((await consumeDistinct(c, "couponCart", "cart_1", "A", boundary)).allowed).toBe(false);
    const later = new Date(T0.getTime() + 2 * windowMs);
    expect((await consumeDistinct(c, "couponCart", "cart_1", "A", later)).allowed).toBe(true);
  });

  it("consumeDistinct song song: đúng limit giá trị mới lọt", async () => {
    const c = new MemoryCounter();
    const { limit } = STORE_RATE_LIMITS.submitCart;
    const results = await Promise.all(
      Array.from({ length: limit + 5 }, (_, i) => consumeDistinct(c, "submitCart", "cart_x", `k${i}`, T0)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
  });

  it("bảng đếm không chứa khoá thô", async () => {
    const c = new MemoryCounter();
    await consumeDistinct(c, "couponIp", "203.0.113.9", "GIAM50", T0);
    for (const k of c.data.keys()) {
      expect(k).not.toContain("203.0.113.9");
      expect(k).not.toContain("GIAM50");
    }
  });
});

describe("upload: magic bytes", () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0]);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(4)]);

  it.each([
    [png, "image/png"],
    [jpeg, "image/jpeg"],
    [webp, "image/webp"],
    [avif, "image/avif"],
  ])("nhận %#", (buf, type) => expect(sniffImageType(buf)).toBe(type));

  it.each([
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["svg có BOM + xml", Buffer.from('﻿<?xml version="1.0"?><svg/>')],
    ["html", Buffer.from("<!DOCTYPE html><script>")],
    ["gif", Buffer.from("GIF89a")],
    ["pdf", Buffer.from("%PDF-1.7")],
    ["rỗng", Buffer.alloc(0)],
    ["PNG cụt", png.subarray(0, 4)],
    ["RIFF không WEBP", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")])],
  ])("từ chối %s", (_l, buf) => expect(sniffImageType(buf)).toBeNull());

  it("đuôi phải khớp loại thật, không phân biệt hoa thường; quá cỡ → 413", () => {
    const f = (originalname: string, buffer: Buffer) => ({
      originalname,
      mimetype: "image/png",
      size: buffer.length,
      buffer,
    });
    expect(checkUploadedFile(f("A.PNG", png))).toEqual({ ok: true, type: "image/png" });
    expect(checkUploadedFile(f("anh.jpeg", jpeg))).toEqual({ ok: true, type: "image/jpeg" });
    expect(checkUploadedFile(f("thu-muc/../anh.png", png)).ok).toBe(true);
    expect(checkUploadedFile(f("anh.png.html", png))).toMatchObject({ ok: false, status: 415 });
    expect(checkUploadedFile(f(".png", png))).toMatchObject({ ok: false, status: 415 });
    expect(checkUploadedFile(f("anh.jpg", png))).toMatchObject({ ok: false, status: 415 });
    const big = Buffer.concat([png, Buffer.alloc(UPLOAD_LIMITS.maxFileBytes)]);
    expect(checkUploadedFile(f("lon.png", big))).toMatchObject({ ok: false, status: 413 });
  });
});

describe("env: XS_TRUSTED_PROXIES và CORS", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost:5432/x" };

  it("XS_TRUSTED_PROXIES hợp lệ / sai → báo tên biến, không in giá trị", () => {
    expect(parseEnv({ ...base, XS_TRUSTED_PROXIES: "loopback,10.0.0.0/8" }).ok).toBe(true);
    expect(parseEnv({ ...base, XS_TRUSTED_PROXIES: "" }).ok).toBe(true);
    const bad = parseEnv({ ...base, XS_TRUSTED_PROXIES: "bi-mat-khong-phai-ip" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.map((p) => p.variable)).toEqual(["XS_TRUSTED_PROXIES"]);
      expect(JSON.stringify(bad.problems)).not.toContain("bi-mat-khong-phai-ip");
    }
  });

  it('CORS: regex khớp origin "null" hoặc regex hỏng → từ chối', () => {
    expect(parseEnv({ ...base, STORE_CORS: "/\\.example\\.vn$/" }).ok).toBe(true);
    for (const STORE_CORS of ["/.*/", "/^n/", "/nu(ll)?/", "/[/", "null"]) {
      expect(parseEnv({ ...base, STORE_CORS }).ok).toBe(false);
    }
  });
});
