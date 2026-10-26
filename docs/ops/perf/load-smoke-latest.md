# Kiểm tải smoke — kết quả mới nhất (T-036)

Kết quả: **ĐẠT** · 2026-10-26T14:31:40.122Z · `pnpm load:smoke` · commit `10b120ceec5789c6eb561de6ec05d8ff3611f551`

> Máy dev dùng chung, một tiến trình Node vừa phát tải vừa chạy cạnh backend + PostgreSQL + Redis: đây là **cổng hồi quy ở tỷ lệ thu nhỏ**, không phải năng lực production và không thay thế chạy đầy đủ §10.3 trên staging (xem `README.md` và `load-dataset.md`).

## Điều kiện tái lập

- Máy: 4 CPU (Intel(R) Xeon(R) Processor @ 2.80GHz), 15.7 GiB RAM, tải hệ thống đầu/cuối: 10.91/6.78/4.37 → 5.63/6.30/4.43; Node v22.22.0; PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1).
- Backend: Medusa 2.22.1 `medusa start` (1 tiến trình, worker shared), `NODE_ENV=development` (production từ chối mock GHN), GHN mock, chỉ COD, `XS_TRUSTED_PROXIES=loopback`; kết nối DB theo mặc định Medusa (không đặt pool).
- Dataset: dùng lại DB đã dựng (LOAD_REUSE=1) + 24 sản phẩm demo; seed 20260101; DB `xshop_load`, Redis DB 13, cổng 9200.
- Tải (§10.3 khởi điểm = 100 đọc/s + 10 ghi/s; smoke = 20× nhỏ hơn): **5 request đọc/s + 0.5 thao tác ghi/s**; pha lạnh 8 s → steady 40 s → burst gấp đôi 12 s.
- Read mix 60% listing (lọc theo danh mục/màu/size/chất liệu/giá/sắp xếp/trang, kèm facet) · 20% PDP · 20% search; write mix 60% sửa giỏ · 20% quote · 20% submit COD (Idempotency-Key riêng; 15% submit gửi lại cùng khoá để kiểm idempotency). Mỗi khách ảo một IP qua X-Forwarded-For.
- Ngưỡng (§10.1): p95 đọc ≤ 300 ms, ghi ≤ 700 ms, checkout ≤ 2000 ms; lỗi server < 0.5%; burst: latency ≤ 2× ngưỡng. Pha lạnh chỉ báo cáo (không làm cổng).

## Dựng môi trường

| Bước | Thời gian |
|---|---:|
| build domain | 4.8 s |
| reused | dùng lại |
| build backend | 43.9 s |

## Pha lạnh (8 s, hệ số ngưỡng ×1) — chỉ báo cáo

Đã phát: 39 đọc, 3 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 39 | 181.0 | 471.0 | 486.4 | ≤ 300 | 0 | 0.00% | 0 | VƯỢT |
| write | 3 | 1028.5 | 1246.9 | 1246.9 | ≤ 700 | 0 | 0.00% | 0 | VƯỢT |
| checkout | 1 | 1843.5 | 1843.5 | 1843.5 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 48 | 201.4 | 1028.5 | 1843.5 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 1 | 1247 | 1247 | 0 |
| cart_create | 1 | 1028 | 1028 | 0 |
| listing | 24 | 150 | 387 | 0 |
| pdp | 8 | 376 | 486 | 0 |
| quote | 1 | 51 | 51 | 0 |
| search | 7 | 304 | 448 | 0 |
| setup_cart_add | 2 | 653 | 911 | 0 |
| setup_cart_create | 2 | 571 | 696 | 0 |
| setup_quote | 1 | 140 | 140 | 0 |
| submit | 1 | 1843 | 1843 | 0 |

## Pha steady (40 s, hệ số ngưỡng ×1) — đạt

Đã phát: 199 đọc, 19 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 199 | 86.9 | 191.4 | 329.9 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 22 | 317.5 | 595.2 | 680.3 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 4 | 525.8 | 647.6 | 647.6 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 225 | 96.7 | 344.4 | 624.1 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 9 | 414 | 680 | 0 |
| cart_create | 7 | 202 | 565 | 0 |
| cart_update | 3 | 304 | 331 | 0 |
| listing | 119 | 70 | 128 | 0 |
| pdp | 39 | 131 | 330 | 0 |
| quote | 3 | 68 | 103 | 0 |
| search | 41 | 119 | 220 | 0 |
| submit | 4 | 526 | 648 | 0 |

## Pha burst (gấp đôi) (12 s, hệ số ngưỡng ×2) — đạt

Đã phát: 119 đọc, 11 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 119 | 88.3 | 224.7 | 386.7 | ≤ 600 | 0 | 0.00% | 0 | đạt |
| write | 10 | 444.9 | 754.4 | 754.4 | ≤ 1400 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 642.2 | 642.2 | 642.2 | ≤ 4000 | 0 | 0.00% | 0 | đạt |
| (chung) | 130 | 92.4 | 436.8 | 642.2 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 4 | 531 | 575 | 0 |
| cart_update | 3 | 382 | 754 | 0 |
| listing | 71 | 66 | 159 | 0 |
| pdp | 25 | 157 | 387 | 0 |
| quote | 3 | 84 | 141 | 0 |
| search | 23 | 129 | 199 | 0 |
| submit | 1 | 642 | 642 | 0 |

## Cache PostgreSQL

Hit ratio vùng đệm trong lúc tải: 99.79% (3052888 hit / 6275 read). Không phải hit ratio CDN: smoke đo origin, không CDN.

## Tính đúng sau tải

| Kiểm tra | Kết quả | Chi tiết |
|---|---|---|
| Không bán âm tồn (mọi inventory_level: 0 ≤ giữ chỗ ≤ tồn) | đạt | 0 dòng vi phạm |
| Giữ chỗ khớp reservation_item (không lệch sổ) | đạt | 0 dòng lệch |
| Không có hai lần đặt cùng Idempotency-Key | đạt | 0 khoá trùng |
| Không có giỏ nào thành hai đơn | đạt | 0 giỏ có > 1 đơn |
| Số đơn mới trong DB = số đơn khác nhau khách nhận được (không mất, không thừa) | đạt | DB +7, phía khách 7 (submit 200: 7) |
| Mọi mã đơn đã trả về cho khách đều có trong DB | đạt | 7/7 |
| Gửi lại cùng Idempotency-Key trả đúng đơn cũ | đạt | không vi phạm |
| Stress 50 lượt đặt đồng thời cho SKU còn 1: đúng 1 đơn thành công | đạt | thành công 1, trạng thái: {"200":1,"409":49} |
| Stress: các lượt còn lại nhận lỗi hiểu được (4xx), không có 5xx/timeout | đạt | 0 lỗi server |
| Stress: tồn của SKU không âm (giữ chỗ ≤ 1) và chỉ có đúng một đơn chứa SKU | đạt | tồn 1, giữ chỗ 1, đơn chứa SKU 1 |
| Tỷ lệ lỗi toàn phiên (cả pha lạnh) < 0.5% | đạt | 0/403 |

