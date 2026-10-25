import type { Metadata } from "next";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";

export const metadata: Metadata = {
  title: "Bạn đang ngoại tuyến",
  robots: { index: false, follow: false },
};

/** Trang dự phòng khi mất mạng (service worker trả khi điều hướng thất bại). Tĩnh, không đọc dữ liệu riêng tư. */
export default function OfflinePage() {
  return (
    <>
      <h1 className="visually-hidden">Bạn đang ngoại tuyến</h1>
      <EmptyState
        title="Không có kết nối mạng"
        description="Bạn chưa thể xem trang này, đặt hàng hoặc thanh toán khi ngoại tuyến. Các trang công khai đã xem có thể hiển thị dữ liệu cũ. Hãy kiểm tra kết nối rồi thử lại — đơn hàng và giỏ hàng của bạn sẽ được xác nhận lại với hệ thống khi có mạng."
        action={<Button href="/">Thử lại</Button>}
      />
    </>
  );
}
