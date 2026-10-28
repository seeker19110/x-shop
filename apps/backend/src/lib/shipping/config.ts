import { parseEnv, type GhnMode } from "../env";
import { hoursToMs, minutesToMs, secondsToMs } from "@x-shop/domain";

/** Tham số giao vận (đặc tả §6.4): thời hạn có tên, đổi một chỗ. */
export const SHIPPING_CONFIG = {
  /**
   * Báo phí GHN có hiệu lực 10 phút (bằng hạn quote checkout): lưu cùng quote, submit trong hạn dùng lại (T-153); hết
   * hạn hoặc đầu vào định phí đổi thì hỏi lại hãng.
   */
  feeQuoteTtlMs: minutesToMs(10),
  /** Hạn chờ một lời gọi GHN; quá hạn = kết quả mơ hồ (timeout) → tra lại theo client_order_code (S-303). */
  requestTimeoutMs: secondsToMs(10),
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
  maxDelayMs: secondsToMs(2),
  jitter: "full",
  totalBudgetMs: secondsToMs(3),
  maxRetryAfterMs: hoursToMs(1),
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
