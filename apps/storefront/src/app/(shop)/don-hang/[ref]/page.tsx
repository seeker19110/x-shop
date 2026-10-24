import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "../../../../components/ui/Button";

export const metadata: Metadata = {
  title: "Đã nhận đơn hàng",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Mã đơn hiển thị (XS-xxxxxx). Định dạng kiểm chặt để chuỗi lạ trên URL không được hiển thị. */
export const ORDER_REF_RE = /^XS-[A-Z0-9]{4,12}$/;

/**
 * Trang xác nhận TỐI THIỂU sau khi đặt đơn (T-020). Chi tiết đơn, trạng thái thanh toán/giao hàng và tra cứu bảo mật
 * (cookie phiên đơn, S-505) làm ở T-021 — trang này chỉ ghi nhận kết quả "đặt đơn" và KHÔNG khẳng định đã thanh toán.
 */
export default async function OrderPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  if (!ORDER_REF_RE.test(ref)) notFound();
  return (
    <section aria-labelledby="don-hang-tieu-de">
      <h1 id="don-hang-tieu-de">Chúng tôi đã nhận đơn hàng của bạn</h1>
      <p>
        Mã đơn hàng: <strong>{ref}</strong>
      </p>
      <p>
        Hãy giữ mã này để tra cứu. Với đơn thanh toán khi nhận hàng, nhân viên sẽ gọi xác nhận qua số điện
        thoại bạn đã cung cấp. Trạng thái thanh toán và giao hàng sẽ được hiển thị riêng tại trang này.
      </p>
      <Button href="/tim-kiem">Tiếp tục mua sắm</Button>
    </section>
  );
}
