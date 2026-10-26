# SPEC-platform — Nền tảng và chất lượng vận hành

| Trường      | Giá trị                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID tính năng | F-001, F-012 (yêu cầu gốc: §7, §10, §11.3, §13.2, T01, T12, AT25, AT27–AT28)                                                                         |
| Trạng thái  | Approved (D-048, 2026-10-26) |
| approved_by | Phiên chính, tự duyệt theo AGENTS.md §5 (D-048) |
| approved_at | 2026-10-26 |
| Nguồn       | `docs/specs/DAC-TA-GOC.md`, `docs/adr/0001-stack.md`, `docs/adr/0002-kieu-kien-truc.md`, `docs/ops/RUNBOOK.md`, `docs/ops/perf/README.md`, `PROJECT.md` §5 |

## 1. User story

Là đội phát triển và vận hành, tôi muốn một nền tảng dựng lại được từ repo sạch và các ngưỡng chất lượng đo được, để mỗi thay đổi đi qua cùng một cổng và sự cố khôi phục được trong thời hạn đã cam kết.

## 2. Tiêu chí chấp nhận

### S-601 Dựng từ repo sạch (F-001)

- Given repo vừa clone, Node đúng `.nvmrc`
- When `pnpm install --frozen-lockfile` rồi chạy cổng của `xt.yaml` (lint, typecheck, test, build)
- Then mọi lệnh thoát 0; lockfile không đổi; CI chạy cùng lệnh với Postgres 16 và Redis 7.

### S-602 Hai đơn vị triển khai (F-001, ADR-0002)

- Given backend (Medusa) và storefront (Next.js)
- When khởi động bằng biến môi trường mẫu `.env.example` của từng app
- Then thiếu hoặc sai biến bắt buộc → tiến trình dừng với lỗi zod nêu rõ biến; khóa VNPAY/GHN không xuất hiện ở storefront.

### S-603 Ngân sách hiệu năng (F-012, §10)

- Given dữ liệu mẫu 10.000 sản phẩm / 50.000 SKU
- When `pnpm load:smoke` và `pnpm perf:budget`
- Then p95 đọc ≤ 300 ms, ghi ≤ 700 ms, checkout ≤ 2 s, lỗi < 0,5%; LCP median ≤ 2,5 s, CLS ≤ 0,1 (lab, không thay RUM).

### S-604 Tiếp cận (F-012, AT25)

- Given 6 màn hình cốt lõi
- When chạy E2E có axe (`pnpm e2e`)
- Then không lỗi serious/critical; điều hướng bàn phím trọn luồng mua (xem SPEC-storefront S-509).

### S-605 Khôi phục (F-012, AT28)

- Given bản sao lưu và bản diễn tập trong `docs/ops/RUNBOOK.md` §4
- When khôi phục sang DB trống
- Then RTO thực đo ≤ 2 giờ; số dòng và băm nội dung bảng trùng lúc snapshot; đối chiếu giao dịch đang dở không lệch. RPO ≤ 15 phút chỉ chứng minh được khi có hạ tầng production (chờ chủ dự án).

### S-606 Runbook sự cố (F-012)

- Given sự cố VNPAY, GHN, Redis/worker, DB, triển khai, ảnh/CDN, tiền đến sau khi hủy
- When người trực mở `docs/ops/RUNBOOK.md`
- Then có bước xử lý, người liên lạc và cách kiểm tra đã hồi phục cho từng loại.

## 3. Ca biên

| Nhóm                  | Ca                                                         | Hành vi                                                                                | Scenario   |
| --------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| Rỗng/null             | biến môi trường rỗng hoặc thiếu                            | dừng khởi động, nêu tên biến                                                            | S-602      |
| Cực đại               | tải gấp đôi (burst); catalog 10.000 sản phẩm               | ngưỡng latency ×2, lỗi vẫn < 0,5%                                                       | S-603      |
| Trùng/idempotency     | chạy lại `migrate`, `seed`, `dev-services.sh`              | không đổi bảng đã áp, không tạo bản ghi thứ hai                                         | S-601      |
| Song song             | 50 lượt đặt đồng thời cho SKU còn 1                        | đúng một đơn; tồn không âm                                                              | S-603      |
| Mất mạng giữa chừng   | Redis hoặc cổng thanh toán không phản hồi                  | theo RUNBOOK §1, §3: giữ endpoint IPN, tạm ẩn VNPAY, không hủy hàng loạt đơn `unknown`  | S-606      |
| Thời gian/múi giờ     | mốc phục hồi; cửa sổ đối chiếu `[mốc − 5 phút, hiện tại]` | mọi mốc UTC; biên cửa sổ có test đột biến (RUNBOOK §4)                          | S-605      |
| Quyền                 | CI không có khóa thật; secret trong repo                   | dev/CI chỉ mock; workflow `secret-scan` đỏ khi lộ                                       | S-601      |
| Tiền/đơn vị           | tải thử có đơn COD và VNPAY                                | tiền số nguyên VND; đối chiếu ledger khớp sau tải                                       | S-603      |
