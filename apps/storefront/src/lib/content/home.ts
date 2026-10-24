/**
 * Nội dung trang chủ là DỮ LIỆU cấu hình (WEB01/WEB02), không hardcode trong JSX.
 * Hiện là bản demo cục bộ; khi có quản trị nội dung, thay nguồn ở đây.
 */
export interface HomeImage {
  src: string;
  width: number;
  height: number;
}

export interface HomeContent {
  hero: {
    title: string;
    subtitle: string;
    cta: { label: string; href: string };
    /** Chữ nằm ở HTML; ảnh chỉ trang trí nên alt rỗng. */
    imageMobile: HomeImage;
    imageDesktop: HomeImage;
  };
  categories: {
    title: string;
    items: { handle: string; title: string; image: HomeImage & { alt: string } }[];
  };
  newArrivals: { title: string; limit: number; linkLabel: string; href: string };
  lookbook: {
    title: string;
    description: string;
    items: { title: string; href: string; image: HomeImage & { alt: string } }[];
  };
  info: {
    title: string;
    items: { title: string; text: string; href: string; linkLabel: string }[];
  };
}

const img = (name: string, alt: string) => ({ src: `/demo/${name}.svg`, width: 800, height: 1000, alt });

export const HOME_CONTENT: HomeContent = {
  hero: {
    title: "Tủ đồ gọn, mặc được nhiều dịp",
    subtitle: "Chất liệu thoáng, đường cắt đơn giản — dễ phối từ đi làm đến cuối tuần.",
    cta: { label: "Xem hàng mới", href: "/tim-kiem" },
    imageMobile: { src: "/demo/hero-mobile.svg", width: 750, height: 938 },
    imageDesktop: { src: "/demo/hero-desktop.svg", width: 1920, height: 800 },
  },
  categories: {
    title: "Mua theo danh mục",
    items: [
      { handle: "ao", title: "Áo", image: img("cat-ao", "Bộ sưu tập áo") },
      { handle: "quan", title: "Quần", image: img("cat-quan", "Bộ sưu tập quần") },
      { handle: "vay", title: "Váy và đầm", image: img("cat-vay", "Bộ sưu tập váy và đầm") },
      { handle: "phu-kien", title: "Phụ kiện", image: img("cat-phu-kien", "Bộ sưu tập phụ kiện") },
    ],
  },
  newArrivals: { title: "Hàng mới", limit: 8, linkLabel: "Xem tất cả", href: "/tim-kiem" },
  lookbook: {
    title: "Phối đồ",
    description: "Ba cách mặc từ cùng một tủ đồ cơ bản.",
    items: [
      { title: "Đi làm", href: "/danh-muc/ao", image: img("look-1", "Phối đồ đi làm") },
      { title: "Cuối tuần", href: "/danh-muc/quan", image: img("look-2", "Phối đồ cuối tuần") },
      { title: "Dạo phố", href: "/danh-muc/vay", image: img("look-3", "Phối đồ dạo phố") },
    ],
  },
  info: {
    title: "Mua hàng yên tâm",
    items: [
      {
        title: "Giao hàng",
        text: "Phí và thời gian giao hàng hiển thị rõ ở bước thanh toán, trước khi bạn xác nhận.",
        href: "/giao-hang",
        linkLabel: "Chính sách giao hàng",
      },
      {
        title: "Đổi trả",
        text: "Điều kiện đổi trả và hoàn tiền được công bố đầy đủ trước khi mua.",
        href: "/doi-tra-hoan-tien",
        linkLabel: "Chính sách đổi trả",
      },
      {
        title: "Hỗ trợ",
        text: "Cần tư vấn chọn size hoặc theo dõi đơn hàng? Liên hệ shop theo thông tin ở cuối trang.",
        href: "/bao-mat",
        linkLabel: "Chính sách bảo mật",
      },
    ],
  },
};
