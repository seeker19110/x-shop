import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CheckoutForm } from "../../../components/checkout/CheckoutForm";
import { loadCartView } from "../../../lib/cart/service";
import { getProvinces } from "../../../lib/checkout/address";

export const metadata: Metadata = {
  title: "Thanh toán",
  robots: { index: false, follow: false },
};

/** Riêng tư theo cookie giỏ: luôn dựng ở server, không cache (S-505; header ở next.config.ts). */
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const cart = await loadCartView();
  // Giỏ rỗng hoặc còn dòng lỗi chưa xử lý (CHK01) → về giỏ để sửa trước khi thanh toán.
  if (cart.lines.length === 0 || cart.blocked) redirect("/gio-hang");
  const provinces = await getProvinces();
  return (
    <CheckoutForm
      subtotal={cart.subtotal}
      provinces={provinces}
      lines={cart.lines.map((l) => ({
        id: l.id,
        itemId: l.handle,
        title: l.title,
        variantLabel: l.variantLabel,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
        thumbnail: l.thumbnail,
      }))}
    />
  );
}
