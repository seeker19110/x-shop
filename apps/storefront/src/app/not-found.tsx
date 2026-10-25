import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Không tìm thấy trang" };

export default function NotFound() {
  return (
    <section aria-labelledby="tieu-de-404">
      <h1 id="tieu-de-404">Không tìm thấy trang</h1>
      <p>Đường dẫn bạn mở không tồn tại hoặc đã được chuyển.</p>
      <p>
        <Link href="/">Về trang chủ</Link>
      </p>
    </section>
  );
}
