import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { msToSecondsFloor, secondsToMs } from "../units.js";

/** JSON chuẩn hóa (khóa sắp xếp, bỏ undefined) — cùng nội dung → cùng hash, không phụ thuộc thứ tự khóa. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** DATA01: hash payload gắn với key; cùng key khác payload → 409 IDEMPOTENCY_CONFLICT. */
export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidIdempotencyKey(key: string | null | undefined): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

export type IdempotencyDecision = "new" | "replay" | "conflict";

export function decideIdempotency(
  existing: { payloadHash: string } | null,
  incomingHash: string,
): IdempotencyDecision {
  if (existing === null) return "new";
  return existing.payloadHash === incomingHash ? "replay" : "conflict";
}

/**
 * Token tra cứu đơn ngắn hạn (POST01): HMAC-SHA256(secret, orderId.exp) dạng base64url — dùng primitive chuẩn,
 * không tự chế mật mã. Token được đổi thành phiên rồi loại khỏi URL ở storefront.
 */
export function signLookupToken(secret: string, orderId: string, expiresAt: Date): string {
  const exp = msToSecondsFloor(expiresAt.getTime());
  const body = `${orderId}.${exp}`;
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${mac}`;
}

export function verifyLookupToken(
  secret: string,
  token: string,
  now: Date,
): { ok: true; orderId: string } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" } {
  const [b64, mac] = token.split(".");
  if (b64 === undefined || b64 === "" || mac === undefined || mac === "" || token.length > 512) {
    return { ok: false, reason: "MALFORMED" };
  }
  const body = Buffer.from(b64, "base64url").toString("utf8");
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{1,12})$/.exec(body);
  if (!m) return { ok: false, reason: "MALFORMED" };
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("base64url"));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  if (secondsToMs(Number(m[2])) <= now.getTime()) return { ok: false, reason: "EXPIRED" };
  return { ok: true, orderId: m[1] as string };
}
