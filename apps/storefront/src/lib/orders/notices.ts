import { t } from "../i18n";
/** Thông báo trang tra cứu đơn theo tham số `?loi=`/`?tu=` (redirect nội bộ). */
const NOTICES: Record<string, string> = {
  "lien-ket": t("orders.notice.link"),
  "thanh-toan": t("orders.notice.payment"),
};

/**
 * Tra thông báo theo khoá từ query. Chỉ nhận khoá riêng của bảng: `?loi=__proto__`/`constructor` không được trả
 * `Object.prototype` (React ném "Objects are not valid as a React child" → trang lỗi).
 */
export function lookupNotice(key: string | string[] | undefined): string | undefined {
  if (typeof key !== "string" || !Object.hasOwn(NOTICES, key)) return undefined;
  return NOTICES[key];
}
