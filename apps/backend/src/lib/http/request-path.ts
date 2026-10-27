import { parse as legacyUrlParse } from "node:url";

/**
 * Đường dẫn của request THEO ĐÚNG CÁCH ROUTER THẤY (T-145). Mọi kiểm tra bảo mật theo đường dẫn (RBAC admin, audit, kiểm
 * upload…) phải dùng helper này thay vì khớp chuỗi `req.originalUrl` thô: Express 4 định tuyến theo pathname đã parse
 * (`parseurl`) — request-target dạng tuyệt đối `GET http://host/admin/customers/1`, hay `/admin\customers/1#x` (rơi vào
 * `url.parse`, đổi `\` thành `/`) đều tới route `/admin/customers/:id`, trong khi chuỗi thô không khớp quy tắc quyền nào.
 *
 * Dùng `originalUrl` (request-target nguyên bản Express giữ lại) chứ không `req.url`: middleware gắn ở `app.use("/admin")`
 * thấy `req.url` đã bị cắt tiền tố mount.
 */

interface ReqLike {
  originalUrl?: unknown;
  url?: unknown;
}

/** Ký tự làm `parseurl` bỏ đường nhanh và chuyển sang `url.parse` (bản sao đúng `parseurl@1.3` mà Express 4 dùng). */
const SLOW_PATH_CHARS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x23, 0xa0, 0xfeff]);

/**
 * Pathname CHƯA giải mã mà router Express khớp route, hoặc `null` nếu không parse được. Thuật toán y như `parseurl`:
 * chuỗi bắt đầu bằng `/` và không có ký tự đặc biệt → cắt ở `?`; còn lại → `url.parse` (cùng hàm Express gọi, gồm cả
 * hành vi đổi `\` → `/` và bỏ `#…`).
 */
export function routerPathname(raw: string): string | null {
  if (raw.charCodeAt(0) === 0x2f) {
    let pathname: string | null = null;
    let fast = true;
    for (let i = 1; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c === 0x3f) {
        pathname ??= raw.slice(0, i);
      } else if (SLOW_PATH_CHARS.has(c)) {
        fast = false;
        break;
      }
    }
    if (fast) return pathname ?? raw;
  }
  try {
    const parsed = legacyUrlParse(raw).pathname;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Ký tự phải giữ dạng mã hoá sau khi giải mã một đoạn — để giải mã không đổi cấu trúc đường dẫn (số đoạn, query). */
const KEEP_ENCODED = /[%/?#]/g;

/**
 * Giải mã `%xx` TỪNG ĐOẠN của pathname; `null` nếu một đoạn mã hoá hỏng (`%zz`, `%C3` cụt, surrogate lẻ). Ký tự
 * `%`, `/`, `?`, `#` sau giải mã được mã hoá lại: `/admin/orders/x%2Fy/cancel` vẫn là 4 đoạn như Express khớp (tham số
 * `:id` = `x/y`), không thành `/admin/orders/x/y/cancel` (lệch quy tắc).
 */
export function decodePathSegments(pathname: string): string | null {
  const out: string[] = [];
  for (const segment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    out.push(decoded.replace(KEEP_ENCODED, (c) => encodeURIComponent(c)));
  }
  return out.join("/");
}

const rawTargetOf = (req: ReqLike): string | null =>
  typeof req.originalUrl === "string" ? req.originalUrl : typeof req.url === "string" ? req.url : null;

/** Pathname router thấy (chưa giải mã, không query); `null` nếu không có/không parse được/không bắt đầu bằng `/`. */
export function rawRequestPath(req: ReqLike): string | null {
  const raw = rawTargetOf(req);
  if (raw === null) return null;
  const pathname = routerPathname(raw);
  return pathname?.startsWith("/") === true ? pathname : null;
}

/**
 * `requestPath(req)` = pathname router thấy, bỏ query, đã giải mã từng đoạn (xem `decodePathSegments`). `null` = không
 * hợp lệ (mã hoá hỏng, không parse được, không bắt đầu bằng `/`) → nơi gọi trả 400 (`sendInvalidPath`).
 */
export function requestPath(req: ReqLike): string | null {
  const pathname = rawRequestPath(req);
  return pathname === null ? null : decodePathSegments(pathname);
}

export const INVALID_PATH = {
  status: 400,
  code: "INVALID_PATH",
  title: "Đường dẫn yêu cầu không hợp lệ",
} as const;
