import { describe, expect, it } from "vitest";
import { IMAGE_FALLBACK_SRC, safeHref, safeImgSrc, safePaymentUrl, safeSrcSet, safeUrl } from "./safe-url";

describe("safeUrl", () => {
  it.each([
    ["https://shop.example/a?b=1#c", "https://shop.example/a?b=1#c"],
    ["http://shop.example/", "http://shop.example/"],
    ["mailto:cskh@shop.example", "mailto:cskh@shop.example"],
    ["tel:+84912345678", "tel:+84912345678"],
    ["/san-pham/ao-so-mi", "/san-pham/ao-so-mi"],
    ["/", "/"],
    ["  https://shop.example/  ", "https://shop.example/"],
    ["HTTPS://SHOP.example/x", "https://shop.example/x"],
    ["MAILTO:a@example.test", "mailto:a@example.test"],
  ])("cho phép %j", (input, expected) => {
    expect(safeUrl(input)).toBe(expected);
  });

  it.each([
    ["javascript:alert(1)"],
    ["JavaScript:alert(1)"],
    ["JAVASCRIPT:alert(1)"],
    ["  javascript:alert(1)"],
    ["java\tscript:alert(1)"],
    ["java\nscript:alert(1)"],
    ["java\rscript:alert(1)"],
    ["\u0000javascript:alert(1)"],
    ["\u0001javascript:alert(1)"],
    [" javascript:alert(1)"],
    [" javascript:alert(1)"],
    ["jav​ascript:alert(1)"],
    ["&#106;avascript:alert(1)"],
    ["%6Aavascript:alert(1)"],
    ["javascript%3Aalert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox(1)"],
    ["file:///etc/passwd"],
    ["ftp://shop.example/"],
    ["blob:https://shop.example/uuid"],
    ["//evil.example/x"],
    ["/\\evil.example/x"],
    ["/a\\b"],
    ["san-pham/ao"],
    ["../x"],
    ["https://exa mple.com"],
    ["https://shop.example/\u0007"],
    [""],
    ["   "],
    ["http://"],
    ["not a url"],
  ])("từ chối %j", (input) => {
    expect(safeUrl(input)).toBeNull();
  });

  it.each([[null], [undefined]])("từ chối %s", (input) => {
    expect(safeUrl(input)).toBeNull();
  });

  it("không ném lỗi với đầu vào không phải chuỗi", () => {
    expect(safeUrl(42 as unknown as string)).toBeNull();
  });
});

describe("safeUrl: scheme nguy hiểm biến thể", () => {
  it.each([
    ["DATA:text/html;base64,PHNjcmlwdD4="],
    ["Data:text/html,x"],
    ["VBScript:msgbox(1)"],
    ["VBSCRIPT:msgbox(1)"],
    ["\tjavascript:alert(1)"],
    ["\u001fjavascript:alert(1)"],
    ["\u0080javascript:alert(1)"],
    ["&#x6A;avascript:alert(1)"],
    ["&#106avascript:alert(1)"],
    ["&colon;javascript:alert(1)"],
    ["javascript&colon;alert(1)"],
    ["javascript&#58;alert(1)"],
    ["jav&Tab;ascript:alert(1)"],
    ["﻿javascript:alert(1)"],
    ["data&colon;text/html,x"],
  ])("từ chối %j", (input) => {
    expect(safeUrl(input)).toBeNull();
  });
});

describe("safeHref / safeImgSrc", () => {
  it("giữ URL an toàn, thay URL xấu bằng giá trị trung tính", () => {
    expect(safeHref("/san-pham/a")).toBe("/san-pham/a");
    expect(safeHref("javascript:alert(1)")).toBe("#");
    expect(safeHref("//evil.example")).toBe("#");
    expect(safeHref(null)).toBe("#");
    expect(safeHref("")).toBe("#");
  });

  it("ảnh: chỉ http(s)/đường dẫn cùng origin, còn lại dùng ảnh dự phòng", () => {
    expect(safeImgSrc("/demo/a.svg")).toBe("/demo/a.svg");
    expect(safeImgSrc("https://cdn.example/a.jpg")).toBe("https://cdn.example/a.jpg");
    expect(safeImgSrc("data:image/svg+xml,<svg onload=alert(1)>")).toBe(IMAGE_FALLBACK_SRC);
    expect(safeImgSrc("javascript:alert(1)")).toBe(IMAGE_FALLBACK_SRC);
    expect(safeImgSrc("mailto:a@b.test")).toBe(IMAGE_FALLBACK_SRC);
    expect(safeImgSrc("tel:+84")).toBe(IMAGE_FALLBACK_SRC);
    expect(safeImgSrc(undefined)).toBe(IMAGE_FALLBACK_SRC);
  });
});

describe("safeSrcSet", () => {
  it("giữ ứng viên an toàn, bỏ ứng viên xấu", () => {
    expect(safeSrcSet("/a.jpg 640w, /b.jpg 1280w")).toBe("/a.jpg 640w, /b.jpg 1280w");
    expect(safeSrcSet("/a.jpg 1x, javascript:alert(1) 2x")).toBe("/a.jpg 1x");
    expect(safeSrcSet("//evil.com/a.jpg 1x, https://cdn.example/b.jpg")).toBe("https://cdn.example/b.jpg");
  });
  it("không còn ứng viên hoặc đầu vào lạ thì dùng ảnh dự phòng", () => {
    expect(safeSrcSet("data:image/png;base64,AAAA 1x")).toBe(IMAGE_FALLBACK_SRC);
    expect(safeSrcSet("")).toBe(IMAGE_FALLBACK_SRC);
    expect(safeSrcSet(null)).toBe(IMAGE_FALLBACK_SRC);
    expect(safeSrcSet(undefined)).toBe(IMAGE_FALLBACK_SRC);
  });
});

describe("safePaymentUrl", () => {
  it.each([
    [
      "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?a=1",
      "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?a=1",
    ],
    ["https://vnpayment.vn/x", "https://vnpayment.vn/x"],
    ["HTTPS://SANDBOX.VNPAYMENT.VN/x", "https://sandbox.vnpayment.vn/x"],
    ["https://pay.vnpay.vn/x", "https://pay.vnpay.vn/x"],
  ])("cho phép %j", (input, expected) => {
    expect(safePaymentUrl(input)).toBe(expected);
  });

  it.each([
    ["https://vnpayment.vn.evil.com/x"],
    ["https://evil.com/?vnpayment.vn"],
    ["https://evil.com/vnpayment.vn"],
    ["https://evilvnpayment.vn/x"],
    ["https://vnpayment.vn@evil.com/x"],
    ["https://vnpay@evil.com/"],
    ["https://sandbox.vnpayment.vn:8443/x"],
    ["https://user:pw@sandbox.vnpayment.vn/x"],
    ["https://sandbox.vnpayment.vn.evil.com@evil.com/"],
    ["http://sandbox.vnpayment.vn/x"],
    ["//sandbox.vnpayment.vn/x"],
    ["/paymentv2/vpcpay.html"],
    ["evil.com/?vnpayment.vn"],
    ["javascript:alert(1)"],
    ["data:text/html,x"],
    ["not a url"],
    [""],
  ])("từ chối %j", (input) => {
    expect(safePaymentUrl(input)).toBeNull();
  });

  it("null/undefined cho null; allowlist tuỳ chỉnh", () => {
    expect(safePaymentUrl(null)).toBeNull();
    expect(safePaymentUrl(undefined)).toBeNull();
    expect(safePaymentUrl("https://pay.example.test/x", ["example.test"])).toBe("https://pay.example.test/x");
    expect(safePaymentUrl("https://sandbox.vnpayment.vn/x", ["example.test"])).toBeNull();
  });
});

describe("safePaymentUrl: origin bổ sung (D-131)", () => {
  const extra = ["http://localhost:3300"];
  it("nhận đúng origin (scheme+host+port)", () => {
    expect(safePaymentUrl("http://localhost:3300/pay?a=1", undefined, extra)).toBe(
      "http://localhost:3300/pay?a=1",
    );
  });
  it.each([
    ["http://localhost:3301/pay"],
    ["http://localhost/pay"],
    ["https://localhost:3300/pay"],
    ["http://127.0.0.1:3300/pay"],
    ["http://localhost:3300.evil.com/pay"],
    ["http://localhost:3300@evil.com/pay"],
    ["http://user@localhost:3300/pay"],
  ])("từ chối %j", (input) => {
    expect(safePaymentUrl(input, undefined, extra)).toBeNull();
  });
  it("mặc định (không extra) từ chối http localhost", () => {
    expect(safePaymentUrl("http://localhost:3300/pay", undefined, [])).toBeNull();
  });
});
