/** Số di động Việt Nam 10 số: 0xxxxxxxxx hoặc +84xxxxxxxxx, đầu số 3/5/7/8/9. */
export const VN_MOBILE_RE = /^(0|\+84)(3|5|7|8|9)\d{8}$/;

/** Số di động VN (cho phép khoảng trắng, chấm, ngoặc, gạch) → dạng chuẩn 0xxxxxxxxx; sai → null. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s.()-]/g, "");
  if (!VN_MOBILE_RE.test(s)) return null;
  return s.startsWith("+84") ? `0${s.slice(3)}` : s;
}
