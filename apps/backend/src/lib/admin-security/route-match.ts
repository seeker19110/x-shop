/**
 * Khớp đường dẫn kiểu Express cho map quyền. Express mặc định KHÔNG phân biệt hoa thường và bỏ qua dấu `/` cuối
 * (`/ADMIN/X/Refunds/` vẫn tới route `/admin/x/refunds`) — nên chuẩn hoá giống vậy trước khi tra map, tránh lách quyền
 * bằng cách đổi hoa/thường.
 *
 * Mẫu: `:param` khớp đúng một đoạn khác rỗng; đoạn cuối `*` khớp 0..n đoạn còn lại.
 */
export function normalizeAdminPath(rawUrl: string): string {
  const q = rawUrl.indexOf("?");
  let path = (q >= 0 ? rawUrl.slice(0, q) : rawUrl).toLowerCase();
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

export function matchPath(pattern: string, path: string): boolean {
  const p = pattern.toLowerCase().split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] as string;
    if (seg === "*" && i === p.length - 1) return true;
    const actual = s[i];
    if (actual === undefined) return false;
    if (seg.startsWith(":")) continue;
    if (seg !== actual) return false;
  }
  return p.length === s.length;
}

/** HEAD đi cùng handler GET trong Express → kiểm như GET. */
export function normalizeMethod(method: string): string {
  const m = method.toUpperCase();
  return m === "HEAD" ? "GET" : m;
}
