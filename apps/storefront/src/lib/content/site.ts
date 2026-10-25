/** Thông tin đơn vị bán và liên kết chính sách: CHƯA CÓ dữ liệu thật — chủ shop điền trước khi mở bán (đặc tả §11.2). */
export const SELLER = {
  name: "[Tên đơn vị bán — chủ shop điền]",
  address: "[Địa chỉ đơn vị bán — chủ shop điền]",
  taxCode: "[Mã số thuế / giấy phép kinh doanh — chủ shop điền]",
  contact: "[Email/điện thoại hỗ trợ — chủ shop điền]",
} as const;

export const POLICY_LINKS = [
  { href: "/giao-hang", label: "Chính sách giao hàng" },
  { href: "/doi-tra-hoan-tien", label: "Đổi trả và hoàn tiền" },
  { href: "/bao-mat", label: "Chính sách bảo mật" },
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

export const POLICY_PENDING_NOTICE =
  "Nội dung chờ chủ shop duyệt — trang này là bản giữ chỗ, chưa phải điều khoản chính thức.";

export interface PolicyPageContent {
  slug: "giao-hang" | "doi-tra-hoan-tien" | "bao-mat";
  title: string;
  description: string;
  sections: { heading: string; text: string }[];
}

export const POLICY_PAGES: readonly PolicyPageContent[] = [
  {
    slug: "giao-hang",
    title: "Chính sách giao hàng",
    description: "Thời gian, phí và phạm vi giao hàng của shop.",
    sections: [
      { heading: "Phạm vi và thời gian", text: "[Chủ shop điền: khu vực giao hàng và thời gian dự kiến.]" },
      {
        heading: "Phí giao hàng",
        text: "Phí giao hàng được tính và hiển thị ở bước thanh toán trước khi bạn xác nhận đơn.",
      },
      { heading: "Kiểm tra hàng khi nhận", text: "[Chủ shop điền: điều kiện kiểm hàng khi nhận.]" },
    ],
  },
  {
    slug: "doi-tra-hoan-tien",
    title: "Đổi trả và hoàn tiền",
    description: "Điều kiện đổi trả và cách hoàn tiền.",
    sections: [
      {
        heading: "Điều kiện đổi trả",
        text: "[Chủ shop điền: thời hạn, tình trạng sản phẩm, chi phí vận chuyển đổi trả.]",
      },
      {
        heading: "Hoàn tiền",
        text: "[Chủ shop điền: phương thức và thời gian hoàn tiền theo từng cách thanh toán.]",
      },
    ],
  },
  {
    slug: "bao-mat",
    title: "Chính sách bảo mật",
    description: "Cách shop thu thập và bảo vệ dữ liệu cá nhân.",
    sections: [
      {
        heading: "Dữ liệu chúng tôi thu thập",
        text: "[Chủ shop điền: danh mục dữ liệu, mục đích, thời gian lưu trữ.]",
      },
      {
        heading: "Quyền của bạn",
        text: "[Chủ shop điền: quyền truy cập, chỉnh sửa, xóa dữ liệu và cách liên hệ.]",
      },
    ],
  },
];
