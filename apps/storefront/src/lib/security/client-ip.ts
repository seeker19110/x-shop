import { headers } from "next/headers";
import { isNonEmpty } from "../presence";

/**
 * IP khách chuyển tiếp cho backend để rate limit theo IP (SEC03, AT20). App Router không thấy địa chỉ socket — chỉ có
 * header do proxy phía trước (LB/CDN) đặt. Khi storefront bị gọi THẲNG (không có proxy), các header này do client tự khai
 * → chuyển tiếp chúng là cho client chọn IP để lách giới hạn. Vì vậy chỉ tin khi `XS_TRUST_PROXY_HEADERS=true` (mặc định
 * KHÔNG tin; khi đó không gửi IP, backend thấy IP của storefront — xem docs/ops/ENV.md `XS_TRUSTED_PROXIES`).
 *
 * Khi tin: ưu tiên `x-real-ip` (proxy đặt đè), rồi mục CUỐI của `x-forwarded-for` (mục do proxy liền trước thêm — mục đầu
 * do client tự khai được).
 */
const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

export function trustProxyHeaders(env: Record<string, string | undefined> = process.env): boolean {
  return env.XS_TRUST_PROXY_HEADERS?.trim().toLowerCase() === "true";
}

export function forwardedClientIp(
  get: (name: string) => string | null | undefined,
  trust: boolean,
): string | null {
  if (!trust) return null;
  const real = get("x-real-ip")?.trim();
  const xff = get("x-forwarded-for")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // x-real-ip rỗng coi như thiếu → lấy hop cuối của x-forwarded-for (giữ hành vi cũ).
  const ip = isNonEmpty(real) ? real : xff?.[xff.length - 1];
  return isNonEmpty(ip) && IP_RE.test(ip) ? ip : null;
}

/** Header `x-forwarded-for` cho lời gọi backend từ server (rỗng khi không tin header hoặc ngoài ngữ cảnh request). */
export async function clientIpHeader(): Promise<Record<string, string>> {
  try {
    const h = await headers();
    const ip = forwardedClientIp((n) => h.get(n), trustProxyHeaders());
    return isNonEmpty(ip) ? { "x-forwarded-for": ip } : {};
  } catch {
    return {};
  }
}
