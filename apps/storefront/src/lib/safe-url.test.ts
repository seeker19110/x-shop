import { describe, expect, it } from "vitest";
import { safeUrl } from "./safe-url";

describe("safeUrl", () => {
  it.each([
    ["https://shop.example/a?b=1#c", "https://shop.example/a?b=1#c"],
    ["http://shop.example/", "http://shop.example/"],
    ["mailto:cskh@shop.example", "mailto:cskh@shop.example"],
    ["tel:+84901234567", "tel:+84901234567"],
    ["/san-pham/ao-so-mi", "/san-pham/ao-so-mi"],
    ["/", "/"],
    ["  https://shop.example/  ", "https://shop.example/"],
    ["HTTPS://SHOP.example/x", "https://shop.example/x"],
    ["MAILTO:a@b.vn", "mailto:a@b.vn"],
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
