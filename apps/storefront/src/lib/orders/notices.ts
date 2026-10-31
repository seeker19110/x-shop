/** Thông báo trang tra cứu đơn theo tham số `?loi=`/`?tu=` (redirect nội bộ). */
const NOTICES: Record<string, string> = {
  "lien-ket": "Liên kết xem đơn đã hết hạn hoặc đã được dùng. Vui lòng tra cứu lại để nhận liên kết mới.",
  "thanh-toan":
    "Chúng tôi đang xác nhận thanh toán với cổng VNPAY — bạn không cần thanh toán lại. Tra cứu đơn để xem kết quả.",
};

/**
 * Tra thông báo theo khoá từ query. Chỉ nhận khoá riêng của bảng: `?loi=__proto__`/`constructor` không được trả
 * `Object.prototype` (React ném "Objects are not valid as a React child" → trang lỗi).
 */
export function lookupNotice(key: string | string[] | undefined): string | undefined {
  if (typeof key !== "string" || !Object.hasOwn(NOTICES, key)) return undefined;
  return NOTICES[key];
}
