import type { Metadata } from "next";
import { CartContents } from "../../../components/cart/CartContents";
import { loadCartView } from "../../../lib/cart/service";
import { t } from "../../../lib/i18n";

export const metadata: Metadata = {
  title: t("cart.pageTitle"),
  robots: { index: false, follow: false },
};

/** Giỏ là dữ liệu riêng tư theo cookie: luôn dựng lại ở server, không cache (S-505; header ở next.config.ts). */
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const cart = await loadCartView();
  return <CartContents cart={cart} />;
}
