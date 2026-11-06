import { BlockList, isIP } from "node:net";
import { isNonEmpty } from "@x-shop/domain";

/**
 * IP khách cho rate limit / nhật ký / vnp_IpAddr (SEC03, AT20).
 *
 * Express của Medusa đặt cứng `trust proxy = 1` nên `req.ip` lấy mục CUỐI của `X-Forwarded-For` của BẤT KỲ ai gọi thẳng
 * backend → giả IP tuỳ ý để lách giới hạn theo IP. Ở đây không dùng `req.ip`: đọc địa chỉ socket, và chỉ đi ngược chuỗi
 * `X-Forwarded-For` khi socket là proxy nằm trong `XS_TRUSTED_PROXIES` (mặc định RỖNG = không tin header nào).
 *
 * Thuật toán (như proxy-addr): danh sách = [socket, XFF đảo ngược]; bỏ dần các mục là proxy tin cậy; mục đầu tiên không
 * tin cậy là khách. Gặp mục không phải IP → dừng ở hop tin cậy cuối (không tin phần còn lại của chuỗi).
 */

/** Từ khoá dải được phép trong `XS_TRUSTED_PROXIES` (ngoài IP/CIDR cụ thể). */
const KEYWORDS: Record<string, ReadonlyArray<[string, number, "ipv4" | "ipv6"]>> = {
  loopback: [
    ["127.0.0.0", 8, "ipv4"],
    ["::1", 128, "ipv6"],
  ],
  private: [
    ["10.0.0.0", 8, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["fc00::", 7, "ipv6"],
  ],
  linklocal: [
    ["169.254.0.0", 16, "ipv4"],
    ["fe80::", 10, "ipv6"],
  ],
};

export const TRUSTED_PROXY_KEYWORDS = Object.keys(KEYWORDS);
const MAX_ENTRIES = 64;
/** Chuỗi XFF dài bất thường: chỉ xét chừng này hop tính từ phải (đủ cho LB + CDN + storefront). */
const MAX_HOPS = 16;

/** Chuẩn hoá một địa chỉ: bỏ `[]`/cổng/zone, IPv4 ánh xạ IPv6 → IPv4, IPv6 dạng nén chữ thường. `null` = không phải IP. */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s === "" || s.length > 64) return null;
  const bracket = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracket) s = bracket[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1]!;
  const family = isIP(s);
  if (family === 4) return s;
  if (family !== 6) return null;
  // WHATWG URL in IPv6 dạng chuẩn (nén, chữ thường) — cùng một địa chỉ luôn ra cùng một khoá.
  const canonical = new URL(`http://[${s}]/`).hostname.slice(1, -1);
  const tail = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (tail) {
    const hi = parseInt(tail[1]!, 16);
    const lo = parseInt(tail[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return canonical;
}

export interface TrustedProxies {
  readonly entries: readonly string[];
  has(ip: string): boolean;
}

export const NO_TRUSTED_PROXIES: TrustedProxies = { entries: [], has: () => false };

export type TrustedProxiesParse = { ok: true; value: TrustedProxies } | { ok: false; reason: string };

/**
 * Phân tích `XS_TRUSTED_PROXIES`: IP, CIDR (v4/v6) hoặc từ khoá loopback|private|linklocal, cách nhau dấu phẩy; `none`
 * (một mình) = không tin proxy nào.
 */
export function parseTrustedProxies(raw: string | undefined): TrustedProxiesParse {
  const list = new BlockList();
  const entries = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length > MAX_ENTRIES) return { ok: false, reason: `tối đa ${MAX_ENTRIES} mục` };
  // `none`: khai rõ "không có proxy tin cậy" (production bắt buộc khai biến) — phải đứng một mình.
  if (entries.some((e) => e.toLowerCase() === "none")) {
    return entries.length === 1
      ? { ok: true, value: NO_TRUSTED_PROXIES }
      : { ok: false, reason: "none phải đứng một mình" };
  }
  for (const entry of entries) {
    const keyword = KEYWORDS[entry.toLowerCase()];
    if (keyword) {
      for (const [net, prefix, family] of keyword) list.addSubnet(net, prefix, family);
      continue;
    }
    const [addr, prefixRaw, extra] = entry.split("/");
    const ip = normalizeIp(addr);
    if (!isNonEmpty(ip) || extra !== undefined) {
      return { ok: false, reason: `phải là IP, CIDR hoặc ${TRUSTED_PROXY_KEYWORDS.join("|")}` };
    }
    const family = isIP(ip) === 4 ? "ipv4" : "ipv6";
    if (prefixRaw === undefined) {
      list.addAddress(ip, family);
      continue;
    }
    const prefix = /^\d{1,3}$/.test(prefixRaw) ? Number(prefixRaw) : NaN;
    if (!(prefix >= 0 && prefix <= (family === "ipv4" ? 32 : 128))) {
      return { ok: false, reason: "độ dài tiền tố CIDR không hợp lệ" };
    }
    list.addSubnet(ip, prefix, family);
  }
  const frozen = Object.freeze([...entries]);
  return {
    ok: true,
    value: {
      entries: frozen,
      has: (ip) => frozen.length > 0 && list.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6"),
    },
  };
}

export interface ClientIp {
  /** IP khách đã chuẩn hoá; `null` khi socket không có địa chỉ hợp lệ. */
  ip: string | null;
  /**
   * `true` khi request xuất phát từ CHÍNH hạ tầng tin cậy (mọi hop đều là proxy tin cậy, không có khách đứng sau) — vd.
   * storefront gọi backend lấy dữ liệu công khai đã cache. Giới hạn theo IP bỏ qua loại này; giới hạn theo khoá nghiệp vụ
   * vẫn áp.
   */
  internal: boolean;
}

export interface IpSource {
  remoteAddress: string | null | undefined;
  forwardedFor: string | string[] | null | undefined;
}

export function resolveClientIp(src: IpSource, trusted: TrustedProxies): ClientIp {
  const peer = normalizeIp(src.remoteAddress);
  if (!isNonEmpty(peer)) return { ip: null, internal: false };
  if (!trusted.has(peer)) return { ip: peer, internal: false };
  const header = Array.isArray(src.forwardedFor) ? src.forwardedFor.join(",") : (src.forwardedFor ?? "");
  const all = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
  const hops = all.slice(0, MAX_HOPS);
  let current = peer;
  for (const raw of hops) {
    const ip = normalizeIp(raw);
    // Chuỗi hỏng: không tin phần bên trái; khách = hop tin cậy cuối, KHÔNG coi là nội bộ (không được miễn giới hạn IP).
    if (!isNonEmpty(ip)) return { ip: current, internal: false };
    if (!trusted.has(ip)) return { ip, internal: false };
    current = ip;
  }
  // Chuỗi bị cắt (quá MAX_HOPS mục đều tin cậy) → không chắc là nội bộ.
  return { ip: current, internal: all.length <= MAX_HOPS };
}

/**
 * Khoá giới hạn theo IP: IPv4 nguyên địa chỉ; IPv6 gộp theo /64 (một thuê bao thường có cả /64 — đổi địa chỉ trong dải
 * không lách được giới hạn).
 */
export function ipRateKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}
