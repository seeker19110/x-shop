import { t } from "../i18n";

/** Thông tin đơn vị bán và liên kết chính sách: CHƯA CÓ dữ liệu thật — chủ shop điền trước khi mở bán (đặc tả §11.2). */
export const SELLER = {
  name: t("static.seller.name"),
  address: t("static.seller.address"),
  taxCode: t("static.seller.taxCode"),
  contact: t("static.seller.contact"),
} as const;

export const POLICY_LINKS = [
  { href: "/giao-hang", label: t("static.policy.shipping.linkLabel") },
  { href: "/doi-tra-hoan-tien", label: t("static.policy.returns.linkLabel") },
  { href: "/bao-mat", label: t("static.policy.privacy.linkLabel") },
] as const;

/** Tóm tắt giao hàng/đổi trả đặt gần CTA ở PDP (PDP05): chỉ nói điều đã chắc chắn, chi tiết ở trang chính sách. */
export const PDP_SUMMARY = [
  {
    title: "Giao hàng",
    text: "Phí và thời gian giao hàng hiển thị ở bước thanh toán, trước khi bạn xác nhận đơn.",
    href: "/giao-hang",
    linkLabel: "Chi tiết giao hàng",
  },
  {
    title: "Đổi trả",
    text: "Điều kiện đổi trả được công bố đầy đủ trước khi mua.",
    href: "/doi-tra-hoan-tien",
    linkLabel: "Chi tiết đổi trả",
  },
] as const;

export interface PolicyPageContent {
  slug: "giao-hang" | "doi-tra-hoan-tien" | "bao-mat";
  title: string;
  description: string;
  sections: { heading: string; text: string }[];
}

export const POLICY_PAGES: readonly PolicyPageContent[] = [
  {
    slug: "giao-hang",
    title: t("static.policy.shipping.title"),
    description: t("static.policy.shipping.description"),
    sections: [
      { heading: t("static.policy.shipping.scopeHeading"), text: t("static.policy.shipping.scopeText") },
      { heading: t("static.policy.shipping.feeHeading"), text: t("static.policy.shipping.feeText") },
      { heading: t("static.policy.shipping.inspectHeading"), text: t("static.policy.shipping.inspectText") },
    ],
  },
  {
    slug: "doi-tra-hoan-tien",
    title: t("static.policy.returns.title"),
    description: t("static.policy.returns.description"),
    sections: [
      {
        heading: t("static.policy.returns.conditionsHeading"),
        text: t("static.policy.returns.conditionsText"),
      },
      { heading: t("static.policy.returns.refundHeading"), text: t("static.policy.returns.refundText") },
    ],
  },
  {
    slug: "bao-mat",
    title: t("static.policy.privacy.title"),
    description: t("static.policy.privacy.description"),
    sections: [
      { heading: t("static.policy.privacy.dataHeading"), text: t("static.policy.privacy.dataText") },
      { heading: t("static.policy.privacy.rightsHeading"), text: t("static.policy.privacy.rightsText") },
    ],
  },
];
