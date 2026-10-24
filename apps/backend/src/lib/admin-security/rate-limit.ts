import { createHash } from "node:crypto";
import { AUTH_RATE_LIMITS } from "./config";
import type { SecurityStore } from "./store";

/**
 * Rate limit đăng nhập/MFA theo nhiều tín hiệu (SEC03). Khóa trong kho là băm — không lưu email/IP thô.
 *
 * "Giữ chỗ trước, hoàn lại khi thành công": mỗi lần thử TĂNG mọi bộ đếm (INCR nguyên tử) TRƯỚC khi kiểm mật khẩu/mã;
 * vượt ngưỡng ở bất kỳ tín hiệu nào → 429 ngay. Nhờ vậy loạt request song song không lọt qua ngưỡng (kiểm-rồi-ghi sẽ
 * để N request cùng thấy "chưa đủ ngưỡng"). Thành công → xoá bộ đếm (định danh + IP) và hoàn 1 cho hai bộ đếm còn lại.
 */
export type LimitScope = "login" | "mfa";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

interface Bucket {
  kind: "ip" | "idip" | "id";
  key: string;
  limit: number;
}

function buckets(scope: LimitScope, identity: string | null, ip: string): Bucket[] {
  const id = (identity ?? "").trim().toLowerCase();
  const limits = AUTH_RATE_LIMITS[scope];
  const out: Bucket[] = [{ kind: "ip", key: `rl:${scope}:ip:${h(ip)}`, limit: limits.perIp }];
  if (id) {
    out.push({ kind: "idip", key: `rl:${scope}:idip:${h(`${id}|${ip}`)}`, limit: limits.perIdentityIp });
    out.push({ kind: "id", key: `rl:${scope}:id:${h(id)}`, limit: limits.perIdentity });
  }
  return out;
}

/** Ghi nhận một lần thử; `allowed=false` khi đã vượt ngưỡng (request không được xử lý tiếp). */
export async function registerAttempt(
  store: SecurityStore,
  scope: LimitScope,
  identity: string | null,
  ip: string,
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  let blocked: Bucket | null = null;
  for (const b of buckets(scope, identity, ip)) {
    const n = await store.incr(b.key, AUTH_RATE_LIMITS.windowSeconds);
    if (n > b.limit && !blocked) blocked = b;
  }
  if (!blocked) return { allowed: true };
  const ttl = await store.ttl(blocked.key);
  return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : AUTH_RATE_LIMITS.windowSeconds };
}

/** Lần thử thành công: không tính là thất bại. */
export async function registerSuccess(
  store: SecurityStore,
  scope: LimitScope,
  identity: string | null,
  ip: string,
): Promise<void> {
  for (const b of buckets(scope, identity, ip)) {
    if (b.kind === "idip") await store.del(b.key);
    else await store.decr(b.key);
  }
}

/** Lỗi hệ thống (5xx): hoàn lại lần thử, không xoá bộ đếm thất bại trước đó. */
export async function registerRefund(
  store: SecurityStore,
  scope: LimitScope,
  identity: string | null,
  ip: string,
): Promise<void> {
  for (const b of buckets(scope, identity, ip)) await store.decr(b.key);
}
