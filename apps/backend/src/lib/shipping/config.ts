import { parseEnv, type GhnMode } from "../env";

/** Tham số giao vận (đặc tả §6.4): thời hạn có tên, đổi một chỗ. */
export const SHIPPING_CONFIG = {
  /** Báo phí GHN có hiệu lực 10 phút (bằng hạn quote checkout) — hết hạn thì hỏi lại hãng. */
  feeQuoteTtlMs: 10 * 60_000,
  /** Số mục tối đa giữ trong bộ nhớ đệm báo phí mỗi tiến trình. */
  feeCacheMaxEntries: 5_000,
  /** Hạn chờ một lời gọi GHN; quá hạn = kết quả mơ hồ (timeout) → tra lại theo client_order_code (S-303). */
  requestTimeoutMs: 10_000,
  /** Ghi chú giao hàng mặc định: cho xem hàng, không cho thử. */
  requiredNote: "CHOXEMHANGKHONGTHU" as const,
  /** Khối lượng tối thiểu gửi hãng (gram) khi giỏ không khai cân nặng. */
  minWeightGrams: 100,
  /** Mã dịch vụ ghi vào snapshot đơn. */
  service: "ghn-standard",
} as const;

export interface GhnRuntimeConfig {
  mode: GhnMode;
  baseUrl: string;
  token: string;
  shopId: string;
}

/**
 * Retry phía dịch vụ cho lời gọi GHN (T-093 — BE-REL-003): mặc định 3 lần/request (Google SRE "Handling Overload"),
 * backoff mũ 200 ms → trần 2 s, full jitter; tổng thời gian chờ ≤ 3 s (và ≤ một lần timeout — xem HttpGhnClient).
 * `Retry-After` của hãng kẹp ≤ 1 giờ; vượt ngân sách thì không chờ trong request mà ném lỗi kèm `retryAfterMs` để caller
 * hẹn lại (202/503 + Retry-After, outbox).
 */
export const GHN_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  jitter: "full",
  totalBudgetMs: 3_000,
  maxRetryAfterMs: 3600_000,
} as const;

let cached: GhnRuntimeConfig | null = null;

/** Cấu hình GHN từ env (đã kiểm khi khởi động ở medusa-config). Token chỉ đọc ở server, không bao giờ trả client. */
export function getGhnConfig(): GhnRuntimeConfig {
  if (cached) return cached;
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error("[shipping] Cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  cached = parsed.env.ghn;
  return cached;
}
