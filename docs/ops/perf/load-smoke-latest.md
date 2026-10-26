# Kiểm tải smoke — kết quả mới nhất (T-036)

Kết quả: **ĐẠT** · 2026-10-26T04:00:13.415Z · `pnpm load:smoke`

> Máy dev dùng chung, một tiến trình Node vừa phát tải vừa chạy cạnh backend + PostgreSQL + Redis: đây là **cổng hồi quy ở tỷ lệ thu nhỏ**, không phải năng lực production và không thay thế chạy đầy đủ §10.3 trên staging (xem `README.md` và `load-dataset.md`).

## Điều kiện tái lập

- Máy: 4 CPU (Intel(R) Xeon(R) Processor @ 2.80GHz), 15.7 GiB RAM, tải hệ thống đầu/cuối: 1.11/1.19/1.40 → 1.28/1.29/1.42; Node v22.22.0; PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1).
- Backend: Medusa 2.22.1 `medusa start` (1 tiến trình, worker shared), `NODE_ENV=development` (production từ chối mock GHN), GHN mock, chỉ COD, `XS_TRUSTED_PROXIES=loopback`; kết nối DB theo mặc định Medusa (không đặt pool).
- Dataset: 10000 sản phẩm / 50000 SKU (sinh mới) + 24 sản phẩm demo; seed 20260101; DB `xshop_load`, Redis DB 13, cổng 9200.
- Tải (§10.3 khởi điểm = 100 đọc/s + 10 ghi/s; smoke = 20× nhỏ hơn): **5 request đọc/s + 0.5 thao tác ghi/s**; pha lạnh 8 s → steady 40 s → burst gấp đôi 12 s.
- Read mix 60% listing (lọc theo danh mục/màu/size/chất liệu/giá/sắp xếp/trang, kèm facet) · 20% PDP · 20% search; write mix 60% sửa giỏ · 20% quote · 20% submit COD (Idempotency-Key riêng; 15% submit gửi lại cùng khoá để kiểm idempotency). Mỗi khách ảo một IP qua X-Forwarded-For.
- Ngưỡng (§10.1): p95 đọc ≤ 300 ms, ghi ≤ 700 ms, checkout ≤ 2000 ms; lỗi server < 0.5%; burst: latency ≤ 2× ngưỡng. Pha lạnh chỉ báo cáo (không làm cổng).

## Dựng môi trường

| Bước | Thời gian |
|---|---:|
| build domain | 1.9 s |
| làm mới DB + Redis | 0.7 s |
| migrate | 17.4 s |
| seed nền + catalog demo | 14.9 s |
| sinh dữ liệu (SQL) | 13.7 s |
| dựng read model (syncCatalogProducts) | 78.1 s |
| build backend | 16.1 s |

## Pha lạnh (8 s, hệ số ngưỡng ×1) — chỉ báo cáo

Đã phát: 39 đọc, 3 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 39 | 88.2 | 170.9 | 209.1 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 3 | 259.6 | 302.1 | 302.1 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 529.2 | 529.2 | 529.2 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 46 | 92.7 | 302.1 | 529.2 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 1 | 302 | 302 | 0 |
| cart_create | 1 | 260 | 260 | 0 |
| listing | 24 | 73 | 110 | 0 |
| pdp | 8 | 113 | 209 | 0 |
| quote | 1 | 99 | 99 | 0 |
| search | 7 | 95 | 137 | 0 |
| setup_cart_add | 1 | 472 | 472 | 0 |
| setup_cart_create | 1 | 289 | 289 | 0 |
| setup_quote | 1 | 104 | 104 | 0 |
| submit | 1 | 529 | 529 | 0 |

## Pha steady (40 s, hệ số ngưỡng ×1) — đạt

Đã phát: 199 đọc, 19 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 199 | 65.6 | 122.5 | 198.2 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 22 | 188.8 | 270.0 | 322.3 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 4 | 311.5 | 340.1 | 340.1 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 225 | 67.9 | 216.5 | 314.0 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 10 | 235 | 322 | 0 |
| cart_create | 7 | 127 | 155 | 0 |
| cart_update | 2 | 197 | 201 | 0 |
| listing | 119 | 61 | 101 | 0 |
| pdp | 39 | 75 | 107 | 0 |
| quote | 3 | 54 | 62 | 0 |
| search | 41 | 82 | 197 | 0 |
| submit | 4 | 311 | 340 | 0 |

## Pha burst (gấp đôi) (12 s, hệ số ngưỡng ×2) — đạt

Đã phát: 119 đọc, 11 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 119 | 63.2 | 107.4 | 143.9 | ≤ 600 | 0 | 0.00% | 0 | đạt |
| write | 13 | 191.9 | 293.1 | 293.1 | ≤ 1400 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 236.6 | 236.6 | 236.6 | ≤ 4000 | 0 | 0.00% | 0 | đạt |
| (chung) | 133 | 64.7 | 199.3 | 275.4 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 5 | 265 | 293 | 0 |
| cart_create | 3 | 150 | 192 | 0 |
| cart_update | 2 | 237 | 275 | 0 |
| listing | 71 | 61 | 92 | 0 |
| pdp | 25 | 70 | 99 | 0 |
| quote | 3 | 58 | 58 | 0 |
| search | 23 | 59 | 144 | 0 |
| submit | 1 | 237 | 237 | 0 |

## Cache PostgreSQL

Hit ratio vùng đệm trong lúc tải: 99.97% (5238221 hit / 1368 read). Không phải hit ratio CDN: smoke đo origin, không CDN.

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
| Tỷ lệ lỗi toàn phiên (cả pha lạnh) < 0.5% | đạt | 0/404 |

