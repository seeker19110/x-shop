import type { vnpay } from "@x-shop/domain";
import { parseEnv } from "../env";

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
  /** Phiên bản chính sách bán hàng (đổi trả, COD…) chụp vào đơn (DATA05). */
  policyVersion: "2026-10-24",
} as const;

/** Giới hạn cột tiền `integer` của Postgres (xem migration module checkout) — vượt → 422 LIMIT, không tràn số. */
export const MAX_MONEY_VND = 2_147_483_647;

export type VnpayRuntimeConfig = vnpay.VnpayConfig;

let cachedVnpay: { value: VnpayRuntimeConfig | null } | null = null;

/** Cấu hình VNPAY từ env (đã kiểm khi khởi động ở medusa-config); null = VNPAY tắt. */
export function getVnpayConfig(): VnpayRuntimeConfig | null {
  if (cachedVnpay) return cachedVnpay.value;
  const parsed = parseEnv(process.env);
  if (!parsed.ok) throw new Error("[checkout] Cấu hình môi trường không hợp lệ (đã báo khi khởi động)");
  cachedVnpay = { value: parsed.env.vnpay };
  return cachedVnpay.value;
}
