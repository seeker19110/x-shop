# Hiệu năng — ngân sách và lab (T-035)

Chạy: `pnpm perf:budget` (build production storefront với dữ liệu mẫu `XS_DATA_SOURCE=fixtures`, không cần backend/DB; tự dừng server). Hai bước, cả hai phải xanh:

1. **Ngân sách tài nguyên tải đầu** (đặc tả §10.2) — `scripts/perf/budget.mjs`: Chromium thật, viewport 390×844, cộng mọi phản hồi phát sinh (gồm RSC/prefetch). JS ≤ 200 KiB gzip, CSS ≤ 50 KiB gzip, font ≤ 100 KiB (woff2 tự host), tổng ≤ 900 KiB. Route: `/`, `/danh-muc/ao`, `/san-pham/ao-so-mi-lua`, `/gio-hang`, `/thanh-toan`, `/don-hang/XS-PERF0001`. Vượt → exit 1, bảng ghi route / đo được / ngân sách. Chi tiết: `budget-latest.json` (không commit).
2. **Lighthouse lab** (đặc tả §10.1) — `scripts/perf/lighthouse.mjs` (`lighthouse` 13.5.0, Apache-2.0): 390×844, CPU 4×, 1,6 Mbps xuống / 750 Kbps lên / RTT 150 ms (điều tiết áp dụng thật, hệ số 3,75× độ trễ và 0,9× băng thông theo quy ước Lighthouse), 5 lần mỗi trang (trang chủ, danh mục, PDP), cache lạnh, median + p75. Ngưỡng theo median: LCP ≤ 2,5 s, CLS ≤ 0,1. Kết quả: `lighthouse-latest.md` (commit làm mốc) và `lighthouse-latest.json` (không commit).

## Giới hạn của phép đo (đừng đọc quá mức)

- Lab, không phải Core Web Vitals thực: không tuyên bố đạt CWV từ đây; INP (≤ 200 ms) chỉ đo bằng interaction test/RUM (TBT ghi để tham khảo, không làm ngưỡng).
- Ảnh demo là SVG nhỏ (~1 KiB) → LCP lab và tổng truyền tải **không** đại diện ảnh sản xuất; đo lại với ảnh thật khi có (§10.2: hero < 200 KiB, card 40–90 KiB, PDP ~180 KiB).
- `/gio-hang`, `/thanh-toan` đo ở trạng thái giỏ rỗng; `/don-hang/<mã>` đo màn "cần xác thực" (không có cookie phiên đơn, không gọi backend).
- Máy chạy là sandbox/CI chung: TBT dao động theo tải CPU. Chưa đo cache ấm, Android tầm trung và iPhone Safari thật (§10.1).
- Font hiện chiếm ~98,6 KiB / 100 KiB: dư địa ~1,4 KiB. Thêm một subset/weight mới sẽ làm đỏ ngân sách.
- Điều tiết `simulate` của Lighthouse trên localhost (HTTP/1.1, không CDN) cho LCP dao động ±0,3 s quanh ngưỡng nên không dùng làm cổng; xem câu hỏi mở trong báo cáo T-035.

## Đề xuất (không tự sửa `xt.yaml`)

Khoá `perf` của `xt.yaml` (dùng cho `release-check`) đang rỗng; đề xuất đặt `perf: "pnpm perf:budget"` khi phiên chính duyệt.
