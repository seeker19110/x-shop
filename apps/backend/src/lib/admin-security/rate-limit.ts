import { createHash } from "node:crypto";
import { ipRateKey } from "../security/client-ip";
import { AUTH_RATE_LIMITS } from "./config";
import {
  exceedsLimit,
  NEXT_HIT,
  sampleAt,
  slidingRetryAfterSeconds,
  windowStartMs,
} from "../security/sliding-window";
import type { SecurityStore } from "./store";

/**
 * Rate limit đăng nhập/MFA theo nhiều tín hiệu (SEC03). Khóa trong kho là băm — không lưu email/IP thô.
 *
 * "Giữ chỗ trước, hoàn lại khi thành công": mỗi lần thử TĂNG mọi bộ đếm (INCR nguyên tử) TRƯỚC khi kiểm mật khẩu/mã;
 * vượt ngưỡng ở bất kỳ tín hiệu nào → 429 ngay. Nhờ vậy loạt request song song không lọt qua ngưỡng (kiểm-rồi-ghi sẽ
 * để N request cùng thấy "chưa đủ ngưỡng"). Thành công → xoá bộ đếm (định danh + IP) và hoàn 1 cho hai bộ đếm còn lại.
 *
 * Bộ đếm lưu theo cửa sổ cố định theo đồng hồ (khoá `…:w<chỉ số cửa sổ>`), quyết định theo xấp xỉ cửa sổ trượt (cửa sổ
 * hiện tại + cửa sổ trước × phần còn lại, lib/security/sliding-window.ts, T-055) — không còn 2× ngưỡng qua ranh giới.
 *
 * Tín hiệu IP (và cặp định danh + IP) dùng `ipRateKey` (T-148): IPv4 nguyên địa chỉ, IPv6 gộp theo /64 — một thuê bao
 * thường có cả /64, xoay địa chỉ trong dải không lách được giới hạn (như mọi limiter khác, lib/security/rate-limit.ts).
 */
export type LimitScope = "login" | "mfa" | "register";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 40);

interface Bucket {
  kind: "ip" | "idip" | "id";
  key: string;
  limit: number;
}

function buckets(scope: LimitScope, identity: string | null, rawIp: string): Bucket[] {
  const id = (identity ?? "").trim().toLowerCase();
  const limits = AUTH_RATE_LIMITS[scope];
  const ip = ipRateKey(rawIp);
  const out: Bucket[] = [{ kind: "ip", key: `rl:${scope}:ip:${h(ip)}`, limit: limits.perIp }];
  if (id) {
    out.push({ kind: "idip", key: `rl:${scope}:idip:${h(`${id}|${ip}`)}`, limit: limits.perIdentityIp });
    out.push({ kind: "id", key: `rl:${scope}:id:${h(id)}`, limit: limits.perIdentity });
  }
  return out;
}

const windowMs = () => AUTH_RATE_LIMITS.windowSeconds * 1000;
/** Khoá Redis của bucket trong cửa sổ cố định số `index` (bội của cửa sổ từ epoch). */
const windowKey = (b: Bucket, index: number) => `${b.key}:w${index}`;
const windowIndex = (now: Date) => windowStartMs(windowMs(), now.getTime()) / windowMs();
/** Giữ cửa sổ đủ lâu để còn đọc được khi nó là "cửa sổ trước" (+ biên lệch đồng hồ giữa instance). */
const keyTtlSeconds = () => 2 * AUTH_RATE_LIMITS.windowSeconds + 60;

/**
 * Ghi nhận một lần thử tại `now` (tiêm được — test tất định); `allowed=false` khi số hiệu dụng cửa sổ trượt
 * (sliding-window.ts, T-055) của bất kỳ tín hiệu nào vượt ngưỡng (request không được xử lý tiếp). Mọi tín hiệu đều được
 * đếm (giữ chỗ) kể cả khi đã bị chặn; `retryAfterSeconds` = mốc muộn nhất mà mọi tín hiệu bị chặn cho lượt kế tiếp qua.
 * Truyền CÙNG `now` cho `registerSuccess`/`registerRefund` của lần thử này để hoàn đúng cửa sổ đã giữ chỗ.
 */
export async function registerAttempt(
  store: SecurityStore,
  scope: LimitScope,
  identity: string | null,
  ip: string,
  now: Date = new Date(),
): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  const idx = windowIndex(now);
  let retryAfterSeconds = 0;
  for (const b of buckets(scope, identity, ip)) {
    const counts = await store.incrPeek(windowKey(b, idx), keyTtlSeconds(), windowKey(b, idx - 1));
    const sample = sampleAt(counts, windowMs(), now);
    if (exceedsLimit(sample, b.limit, windowMs())) {
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        slidingRetryAfterSeconds(sample, b.limit, windowMs(), NEXT_HIT),
      );
    }
  }
  return retryAfterSeconds > 0 ? { allowed: false, retryAfterSeconds } : { allowed: true };
}

/** Lần thử thành công (`now` = mốc của `registerAttempt`): không tính là thất bại. */
export async function registerSuccess(
  store: SecurityStore,
  scope: LimitScope,
  identity: string | null,
  ip: string,
  now: Date = new Date(),
): Promise<void> {
  const idx = windowIndex(now);
  for (const b of buckets(scope, identity, ip)) {
    if (b.kind === "idip") {
      // Đăng nhập đúng từ (định danh, IP) này xoá sạch thất bại của nó — cả phần còn tính từ cửa sổ trước.
      await store.del(windowKey(b, idx));
      await store.del(windowKey(b, idx - 1));
    } else await store.decr(windowKey(b, idx));
  }
}

/** Lỗi hệ thống (5xx, `now` = mốc của `registerAttempt`): hoàn lại lần thử, không xoá bộ đếm thất bại trước đó. */
export async function registerRefund(
  store: SecurityStore,
  scope: LimitScope,
  identity: string | null,
  ip: string,
  now: Date = new Date(),
): Promise<void> {
  const idx = windowIndex(now);
  for (const b of buckets(scope, identity, ip)) await store.decr(windowKey(b, idx));
}
