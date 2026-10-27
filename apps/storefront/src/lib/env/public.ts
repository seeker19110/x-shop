/**
 * Phần CÔNG KHAI của cấu hình, an toàn cho bundle client: KHÔNG import zod hay `./index` (module đó mang cả tên biến server
 * vào chunk trình duyệt). Module client (vd. analytics/track.ts) chỉ được nhập từ file này; test `client-bundle.test.ts`
 * quét đồ thị import để giữ ràng buộc.
 */

export const ANALYTICS_TRANSPORTS = ["none", "beacon"] as const;
export type AnalyticsTransport = (typeof ANALYTICS_TRANSPORTS)[number];

/**
 * Transport analytics, đọc KHÔNG qua cache (đổi được trong test). Giá trị sai/thiếu → `none`: telemetry không được làm hỏng
 * trang (giá trị sai vẫn làm `getClientEnv()` ở layout fail theo FE-BUILD-005).
 */
export function getAnalyticsTransport(): AnalyticsTransport {
  // Tham chiếu tĩnh để Next nhúng giá trị vào bundle client.
  const raw = process.env.NEXT_PUBLIC_ANALYTICS_TRANSPORT;
  return (ANALYTICS_TRANSPORTS as readonly string[]).includes(raw ?? "")
    ? (raw as AnalyticsTransport)
    : "none";
}
