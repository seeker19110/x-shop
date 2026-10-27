import type { vnpay } from "@x-shop/domain";
import { parseEnv, type VnpayIpnKeys, type VnpayMode } from "../env";

/**
 * Tham số checkout (D-002): mọi thời hạn là cấu hình có tên, đổi một chỗ. Thời gian lưu UTC (DATA04).
 */
export const CHECKOUT_CONFIG = {
  /** Báo giá có hiệu lực 10 phút. */
  quoteTtlMs: 10 * 60_000,
  /** Giữ hàng đơn online (VNPAY) 15 phút — cũng là vnp_ExpireDate. */
  onlineHoldMs: 15 * 60_000,
  /** Hạn xác nhận đơn COD 24 giờ (D-004) — không dùng TTL online. */
  codConfirmMs: 24 * 60 * 60_000,
  /** Attempt `preparing` quá hạn này → job đối chiếu bù trừ (AT10). */
  attemptLeaseMs: 2 * 60_000,
  /** Chờ tối đa để lấy khóa (giỏ/tồn kho/mã giảm) trước khi trả 409 BUSY_RETRY. */
  lockWaitMs: 15_000,
  /** Thời hạn khóa Redis; được gia hạn mỗi 1/3 thời hạn khi còn giữ (§6.2 "có thời hạn, gia hạn"). */
  lockTtlSeconds: 30,
  /** Request trùng (cùng key/phiên bản giỏ) chờ attempt đang chạy tối đa bấy nhiêu trước khi trả 202. */
  replayWaitMs: 8_000,
  replayPollMs: 100,
  /** Chờ khóa đơn (`order:<id>`) ở IPN/recheck/job trước khi bỏ lượt (VNPAY gửi lại IPN). */
  orderLockWaitMs: 15_000,
  /** Hạn trả lời querydr của VNPAY trước khi coi là `unknown` (AT11). */
  queryTimeoutMs: 10_000,
  /** Khách bấm "Kiểm tra lại" tối đa 1 lần / 10 giây mỗi attempt. */
  recheckIntervalSeconds: 10,
  /** Ngoại lệ payment_unknown phải xử lý trong 30 phút. */
  paymentUnknownDueMs: 30 * 60_000,
  /** Phiên bản chính sách bán hàng (đổi trả, COD…) chụp vào đơn (DATA05). */
  policyVersion: "2026-10-24",
} as const;

/** Giới hạn cột tiền `integer` của Postgres (xem migration module checkout) — vượt → 422 LIMIT, không tràn số. */
export const MAX_MONEY_VND = 2_147_483_647;

/** `hashSecretPrevious`: khoá trước, CHỈ dùng xác minh trong cửa sổ xoay (lib/payment/vnpay-secrets.ts, T-099). */
export type VnpayRuntimeConfig = vnpay.VnpayConfig & { mode: VnpayMode; hashSecretPrevious: string | null };

let cachedVnpay: { value: VnpayRuntimeConfig | null } | null = null;
let cachedIpnKeys: { value: VnpayIpnKeys | null } | null = null;

/** Cấu hình VNPAY từ env (đã kiểm khi khởi động ở medusa-config); null = VNPAY tắt. */
export function getVnpayConfig(): VnpayRuntimeConfig | null {
  if (cachedVnpay) return cachedVnpay.value;
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error("[checkout] Cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  cachedVnpay = { value: parsed.env.vnpay };
  return cachedVnpay.value;
}

/**
 * Khoá xác minh IPN VNPAY (T-166) — có cả khi VNPAY_ENABLED=false (chỉ chặn tạo thanh toán mới) nếu khoá còn cấu hình;
 * null = không xác minh được (IPN trả 99, không ghi nhận). Đừng dùng để tạo thanh toán/querydr — dùng `getVnpayConfig`.
 */
export function getVnpayIpnKeys(): VnpayIpnKeys | null {
  if (cachedIpnKeys) return cachedIpnKeys.value;
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error("[checkout] Cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  cachedIpnKeys = { value: parsed.env.vnpayIpnKeys };
  return cachedIpnKeys.value;
}
