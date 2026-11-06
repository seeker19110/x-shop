import { z } from "zod";

/**
 * Nguồn ảnh cho `next/image` (T-154). Backend production lưu ảnh ở kho S3-compatible dùng chung (FILE_STORAGE=s3) — URL ảnh
 * là `<S3_FILE_URL>/<khoá>`, KHÔNG còn `<MEDUSA_BACKEND_URL>/static/…`. `XS_MEDIA_URL` (chỉ server, đặt = S3_FILE_URL của
 * backend) mở đúng host + tiền tố đường dẫn đó cho bộ tối ưu ảnh của Next (`images.remotePatterns`).
 *
 * CSP `img-src` KHÔNG cần nới: mọi ảnh sản phẩm đi qua `next/image`/`getImageProps` → trình duyệt tải từ `/_next/image`
 * cùng origin; server storefront mới là bên tải từ kho (theo remotePatterns, bộ chặn SSRF của Next vẫn bật ở production).
 *
 * Module này chỉ phụ thuộc zod để `next.config.ts` nhập được.
 */

export const MEDIA_URL_ENV = "XS_MEDIA_URL";

/** Gốc URL ảnh: http(s), có host, không query/fragment/thông tin đăng nhập; `/` cuối bị bỏ. */
export const mediaUrlSchema = z
  .string()
  .trim()
  .refine((raw) => {
    if (/[\s\\@?#]/.test(raw)) return false;
    try {
      const u = new URL(raw);
      return (
        (u.protocol === "http:" || u.protocol === "https:") &&
        u.hostname !== "" &&
        u.search === "" &&
        u.hash === "" &&
        u.username === "" &&
        u.password === ""
      );
    } catch {
      return false;
    }
  }, "phải là URL gốc http(s) (không khoảng trắng, \\, query, fragment hay thông tin đăng nhập)")
  .transform((raw) => {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  });

export interface ImageRemotePattern {
  protocol: "http" | "https";
  hostname: string;
  port?: string;
  pathname: string;
}

type Source = Record<string, string | undefined>;

function patternOf(url: URL, pathname: string): ImageRemotePattern {
  return {
    protocol: url.protocol === "https:" ? "https" : "http",
    hostname: url.hostname,
    ...(url.port ? { port: url.port } : {}),
    pathname,
  };
}

/**
 * `images.remotePatterns` của storefront:
 *  - `<MEDUSA_BACKEND_URL>/static/**` — ảnh của backend chạy FILE_STORAGE=local (dev) và ảnh cũ trước T-154;
 *  - `<XS_MEDIA_URL>/**` — kho ảnh dùng chung. Sai định dạng, hoặc `NODE_ENV=production` mà không phải https → NÉM LỖI
 *    (build/start dừng, không âm thầm bỏ ảnh). Lỗi nêu tên biến, không in giá trị.
 */
export function imageRemotePatterns(source: Source = process.env): ImageRemotePattern[] {
  const out: ImageRemotePattern[] = [];
  const backend = source.MEDUSA_BACKEND_URL?.trim();
  if (backend !== undefined && backend !== "") {
    try {
      out.push(patternOf(new URL(backend), "/static/**"));
    } catch {
      // MEDUSA_BACKEND_URL sai do schema server báo (lib/env) — ở đây chỉ bỏ qua như trước.
    }
  }
  const raw = source[MEDIA_URL_ENV];
  if (raw === undefined || raw.trim() === "") return out;
  const parsed = mediaUrlSchema.safeParse(raw);
  const fail = (reason: string) =>
    new Error(`Cấu hình môi trường server không hợp lệ:\n  - ${MEDIA_URL_ENV}: ${reason}`);
  if (!parsed.success) throw fail(parsed.error.issues[0]?.message ?? "không hợp lệ");
  const url = new URL(parsed.data);
  if (source.NODE_ENV === "production" && url.protocol !== "https:") {
    throw fail("phải dùng https:// ở production");
  }
  const prefix = url.pathname.replace(/\/+$/, "");
  out.push(patternOf(url, `${prefix}/**`));
  return out;
}
