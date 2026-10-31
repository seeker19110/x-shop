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

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * Origin bổ sung được phép làm cổng thanh toán (D-131) — CHỈ cho dev/E2E (cổng giả lập `http://localhost:<port>`).
 * `NEXT_PUBLIC_VNPAY_EXTRA_ORIGINS` = danh sách origin (scheme://host[:port]) phân tách dấu phẩy; so khớp chính xác.
 * Origin http hoặc host localhost/127.0.0.1/[::1] CHỈ được nhận khi `NEXT_PUBLIC_SITE_URL` cũng là localhost (máy dev/E2E);
 * triển khai thật (site URL công khai) thì bị từ chối — schema ném lỗi lúc khởi động. Không dùng NODE_ENV làm dấu hiệu:
 * E2E chạy `next start` với NODE_ENV=production (và bundle client luôn là production) nên không phân biệt được.
 * Trả về danh sách origin đã chuẩn hoá; ném Error nêu lý do nếu một mục sai.
 */
export function parseVnpayExtraOrigins(raw: string | undefined, siteUrl: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const devSite = isLocalHost(hostOf(siteUrl));
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      let url: URL;
      try {
        url = new URL(item);
      } catch {
        throw new Error(`"${item}" không phải URL hợp lệ`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`"${item}" phải là http(s)`);
      if (url.username !== "" || url.password !== "") throw new Error(`"${item}" không được chứa userinfo`);
      if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
        throw new Error(`"${item}" phải là origin thuần (không đường dẫn/query/hash)`);
      if (!devSite && (url.protocol !== "https:" || isLocalHost(url.hostname)))
        throw new Error(
          `"${item}": triển khai thật (NEXT_PUBLIC_SITE_URL không phải localhost) không nhận origin http hoặc localhost`,
        );
      return url.origin;
    });
}

/** Origin thanh toán bổ sung hiện hành. Sai cấu hình → [] (an toàn: không nới allowlist); lỗi được schema client báo. */
export function getVnpayExtraOrigins(): string[] {
  try {
    // Tham chiếu tĩnh để Next nhúng giá trị vào bundle client.
    return parseVnpayExtraOrigins(
      process.env.NEXT_PUBLIC_VNPAY_EXTRA_ORIGINS,
      process.env.NEXT_PUBLIC_SITE_URL,
    );
  } catch {
    return [];
  }
}
