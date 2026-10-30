"use client";

/**
 * Biên lỗi cuối cùng (lỗi ở root layout): tự dựng <html>/<body>, không phụ thuộc layout/CSS module/component khác
 * (chúng có thể chính là nguồn lỗi). Không lộ chi tiết lỗi (UX-STATE-005).
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="vi">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: "2rem", color: "#191919" }}>
        <main role="alert" style={{ maxWidth: "32rem", margin: "0 auto" }}>
          <h1>Đã có sự cố</h1>
          <p>Hệ thống gặp sự cố tạm thời. Vui lòng thử lại; nếu vẫn lỗi, hãy quay lại sau ít phút.</p>
          <button
            type="button"
            onClick={reset}
            style={{ minHeight: "2.75rem", padding: "0 1.25rem", fontSize: "1rem", cursor: "pointer" }}
          >
            Thử lại
          </button>
        </main>
      </body>
    </html>
  );
}
