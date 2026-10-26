/**
 * Chống CSRF cho request ghi tới storefront (SEC01): Server Action (POST kèm cookie giỏ/đơn) và route handler ghi
 * (`/api/analytics`). Next đã kiểm Origin cho Server Action; lớp này áp chung cho MỌI request ghi ở proxy:
 *
 *  - `Origin` có mặt → host phải trùng host của chính request (`x-forwarded-host` hoặc `host`) hoặc host của
 *    `NEXT_PUBLIC_SITE_URL`; `Origin: null` → từ chối.
 *  - Không có `Origin`: `Sec-Fetch-Site` = `cross-site`/`same-site` → từ chối; còn lại (client không phải trình duyệt) → qua.
 *
 * Storefront không có luồng POST hợp lệ từ site khác (cổng VNPAY trở về bằng GET, IPN đi thẳng backend).
 */
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type CsrfVerdict =
  { ok: true } | { ok: false; reason: "origin_null" | "origin_not_allowed" | "cross_site" };

export interface CsrfInput {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  /** Host được phép (chữ thường, có cổng nếu có). */
  allowedHosts: readonly string[];
}

function hostOf(origin: string): string | null {
  try {
    const u = new URL(origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function checkCsrf(input: CsrfInput): CsrfVerdict {
  if (!UNSAFE.has(input.method.toUpperCase())) return { ok: true };
  const site = input.secFetchSite?.trim().toLowerCase();
  const origin = input.origin?.trim();
  if (origin) {
    if (origin.toLowerCase() === "null") return { ok: false, reason: "origin_null" };
    const host = hostOf(origin);
    return host !== null && input.allowedHosts.includes(host)
      ? { ok: true }
      : { ok: false, reason: "origin_not_allowed" };
  }
  if (site === "cross-site" || site === "same-site") return { ok: false, reason: "cross_site" };
  return { ok: true };
}

/** Host được phép từ header request + URL site cấu hình (bỏ giá trị rỗng/lỗi). */
export function allowedHostsOf(headers: Headers, siteUrl: string | undefined): string[] {
  const out = new Set<string>();
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  const host = headers.get("host")?.trim().toLowerCase();
  if (forwarded) out.add(forwarded);
  if (host) out.add(host);
  if (siteUrl) {
    const h = hostOf(siteUrl);
    if (h) out.add(h);
  }
  return [...out];
}
