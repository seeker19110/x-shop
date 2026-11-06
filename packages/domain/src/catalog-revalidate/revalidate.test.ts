import { describe, expect, it } from "vitest";
import {
  CATALOG_LIST_TAG,
  CATALOG_TAG,
  isRevalidateTag,
  MAX_TAG_LENGTH,
  productTag,
  REVALIDATE_TOLERANCE_S,
  signRevalidate,
  verifyRevalidate,
} from "./revalidate.js";

const SECRET = "khoa-thu-nghiem-0123456789abcdef-0123";
const TS = "1793000000";
const NONCE = "nonce-0123456789abcdef";
const BODY = '{"id":"w1","tags":["catalog:list","product:ao-so-mi"]}';
const NOW = Number(TS) * 1000;
/** Tính độc lập bằng `openssl dgst -sha256 -hmac <khoá>` trên `v1:<ts>:<nonce>:<thân>` — khoá chuỗi ký hai phía. */
const VECTOR = "v1=43cd8c3c83ee1efe836d9fb8b9902895b4db0b6c0a977ab2553ce3d7b6c771f7";

const headers = (over: Partial<Record<"timestamp" | "nonce" | "signature", string | null>> = {}) => ({
  timestamp: TS,
  nonce: NONCE,
  signature: VECTOR,
  ...over,
});

describe("chữ ký webhook revalidate", () => {
  it("khớp vector tính độc lập (openssl)", () => {
    expect(signRevalidate(SECRET, TS, NONCE, BODY)).toBe(VECTOR);
  });

  it("chữ ký đúng → ok, trả mốc + nonce", () => {
    expect(verifyRevalidate(SECRET, headers(), BODY, NOW)).toEqual({
      ok: true,
      timestamp: Number(TS),
      nonce: NONCE,
    });
  });

  it("sai khoá / sửa thân / sửa nonce / sửa mốc → bad_signature", () => {
    expect(verifyRevalidate(`${SECRET}x`, headers(), BODY, NOW)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyRevalidate(SECRET, headers(), BODY.replace("w1", "w2"), NOW)).toMatchObject({
      reason: "bad_signature",
    });
    expect(verifyRevalidate(SECRET, headers({ nonce: "nonce-0123456789abcdeX" }), BODY, NOW)).toMatchObject({
      reason: "bad_signature",
    });
    expect(verifyRevalidate(SECRET, headers({ timestamp: "1793000001" }), BODY, NOW)).toMatchObject({
      reason: "bad_signature",
    });
  });

  it("thiếu header → missing_header; sai định dạng → malformed", () => {
    expect(verifyRevalidate(SECRET, headers({ signature: null }), BODY, NOW)).toMatchObject({
      reason: "missing_header",
    });
    expect(verifyRevalidate(SECRET, headers({ nonce: null }), BODY, NOW)).toMatchObject({
      reason: "missing_header",
    });
    for (const bad of [
      { signature: VECTOR.toUpperCase() },
      { signature: "v2=" + VECTOR.slice(3) },
      { signature: VECTOR.slice(0, -1) },
      { timestamp: "-1" },
      { timestamp: "1.5" },
      { timestamp: "" },
      { nonce: "ngan" },
      { nonce: "nonce có dấu cách 0123456" },
    ]) {
      expect(verifyRevalidate(SECRET, headers(bad), BODY, NOW)).toMatchObject({ reason: "malformed" });
    }
  });

  it("lệch giờ quá ngưỡng theo cả hai chiều → expired; đúng biên vẫn nhận", () => {
    const tol = REVALIDATE_TOLERANCE_S * 1000;
    expect(verifyRevalidate(SECRET, headers(), BODY, NOW + tol).ok).toBe(true);
    expect(verifyRevalidate(SECRET, headers(), BODY, NOW - tol).ok).toBe(true);
    expect(verifyRevalidate(SECRET, headers(), BODY, NOW + tol + 1000)).toMatchObject({ reason: "expired" });
    expect(verifyRevalidate(SECRET, headers(), BODY, NOW - tol - 1000)).toMatchObject({ reason: "expired" });
  });

  it("thân Unicode: ký trên chuỗi UTF-8 thô", () => {
    const body = '{"id":"w","tags":["product:%C3%A1o"]}';
    const sig = signRevalidate(SECRET, TS, NONCE, body);
    expect(verifyRevalidate(SECRET, headers({ signature: sig }), body, NOW).ok).toBe(true);
  });
});

describe("tag", () => {
  it("productTag encode handle; rỗng/quá dài → null", () => {
    expect(productTag("ao-so-mi")).toBe("product:ao-so-mi");
    expect(productTag("áo sơ mi/x")).toBe("product:%C3%A1o%20s%C6%A1%20mi%2Fx");
    expect(productTag("")).toBeNull();
    const longest = "a".repeat(MAX_TAG_LENGTH - "product:".length);
    expect(productTag(longest)).toHaveLength(MAX_TAG_LENGTH);
    expect(productTag(`${longest}a`)).toBeNull();
  });

  it("isRevalidateTag: chỉ nhận ba dạng đã khai", () => {
    for (const ok of [CATALOG_TAG, CATALOG_LIST_TAG, "product:ao-so-mi", productTag("áo sơ mi") as string]) {
      expect(isRevalidateTag(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "catalogx",
      "product:",
      "product:a b",
      "product:a/b",
      "_N_T_/",
      "orders",
      `product:${"a".repeat(MAX_TAG_LENGTH)}`,
      42,
      null,
    ]) {
      expect(isRevalidateTag(bad)).toBe(false);
    }
  });
});
