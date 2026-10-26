# Kiểm tải smoke — kết quả mới nhất (T-036)

Kết quả: **ĐẠT** · 2026-10-26T06:15:17.843Z · `pnpm load:smoke`

> Máy dev dùng chung, một tiến trình Node vừa phát tải vừa chạy cạnh backend + PostgreSQL + Redis: đây là **cổng hồi quy ở tỷ lệ thu nhỏ**, không phải năng lực production và không thay thế chạy đầy đủ §10.3 trên staging (xem `README.md` và `load-dataset.md`).

## Điều kiện tái lập

- Máy: 4 CPU (Intel(R) Xeon(R) Processor @ 2.80GHz), 15.7 GiB RAM, tải hệ thống đầu/cuối: 1.29/1.16/1.18 → 1.37/1.20/1.19; Node v22.22.0; PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1).
- Backend: Medusa 2.22.1 `medusa start` (1 tiến trình, worker shared), `NODE_ENV=development` (production từ chối mock GHN), GHN mock, chỉ COD, `XS_TRUSTED_PROXIES=loopback`; kết nối DB theo mặc định Medusa (không đặt pool).
- Dataset: 10000 sản phẩm / 50000 SKU (sinh mới) + 24 sản phẩm demo; seed 20260101; DB `xshop_load`, Redis DB 13, cổng 9200.
- Tải (§10.3 khởi điểm = 100 đọc/s + 10 ghi/s; smoke = 20× nhỏ hơn): **5 request đọc/s + 0.5 thao tác ghi/s**; pha lạnh 8 s → steady 40 s → burst gấp đôi 12 s.
- Read mix 60% listing (lọc theo danh mục/màu/size/chất liệu/giá/sắp xếp/trang, kèm facet) · 20% PDP · 20% search; write mix 60% sửa giỏ · 20% quote · 20% submit COD (Idempotency-Key riêng; 15% submit gửi lại cùng khoá để kiểm idempotency). Mỗi khách ảo một IP qua X-Forwarded-For.
- Ngưỡng (§10.1): p95 đọc ≤ 300 ms, ghi ≤ 700 ms, checkout ≤ 2000 ms; lỗi server < 0.5%; burst: latency ≤ 2× ngưỡng. Pha lạnh chỉ báo cáo (không làm cổng).

## Dựng môi trường

| Bước | Thời gian |
|---|---:|
| build domain | 2.1 s |
| làm mới DB + Redis | 0.9 s |
| migrate | 22.4 s |
| seed nền + catalog demo | 16.3 s |
| sinh dữ liệu (SQL) | 16.0 s |
| dựng read model (syncCatalogProducts) | 88.0 s |
| build backend | 19.1 s |

## Pha lạnh (8 s, hệ số ngưỡng ×1) — chỉ báo cáo

Đã phát: 39 đọc, 3 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 39 | 68.5 | 170.6 | 171.2 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 3 | 218.3 | 333.2 | 333.2 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 369.2 | 369.2 | 369.2 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 46 | 78.3 | 333.2 | 400.1 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 1 | 333 | 333 | 0 |
| cart_create | 1 | 218 | 218 | 0 |
| listing | 24 | 54 | 106 | 0 |
| pdp | 8 | 111 | 171 | 0 |
| quote | 1 | 54 | 54 | 0 |
| search | 7 | 93 | 150 | 0 |
| setup_cart_add | 1 | 400 | 400 | 0 |
| setup_cart_create | 1 | 257 | 257 | 0 |
| setup_quote | 1 | 54 | 54 | 0 |
| submit | 1 | 369 | 369 | 0 |

## Pha steady (40 s, hệ số ngưỡng ×1) — đạt

Đã phát: 199 đọc, 19 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 199 | 60.2 | 125.6 | 159.7 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 22 | 182.5 | 282.4 | 330.1 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 4 | 314.0 | 381.9 | 381.9 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 225 | 66.7 | 211.5 | 330.1 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 10 | 237 | 330 | 0 |
| cart_create | 7 | 163 | 172 | 0 |
| cart_update | 2 | 221 | 230 | 0 |
| listing | 119 | 47 | 100 | 0 |
| pdp | 39 | 90 | 142 | 0 |
| quote | 3 | 53 | 59 | 0 |
| search | 41 | 93 | 139 | 0 |
| submit | 4 | 314 | 382 | 0 |

## Pha burst (gấp đôi) (12 s, hệ số ngưỡng ×2) — đạt

Đã phát: 119 đọc, 11 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 119 | 59.0 | 134.3 | 160.7 | ≤ 600 | 0 | 0.00% | 0 | đạt |
| write | 13 | 193.8 | 348.2 | 348.2 | ≤ 1400 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 311.1 | 311.1 | 311.1 | ≤ 4000 | 0 | 0.00% | 0 | đạt |
| (chung) | 133 | 64.8 | 251.3 | 315.3 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 5 | 296 | 348 | 0 |
| cart_create | 3 | 163 | 175 | 0 |
| cart_update | 2 | 283 | 315 | 0 |
| listing | 71 | 52 | 88 | 0 |
| pdp | 25 | 96 | 147 | 0 |
| quote | 3 | 54 | 82 | 0 |
| search | 23 | 70 | 146 | 0 |
| submit | 1 | 311 | 311 | 0 |

## Cache PostgreSQL

Hit ratio vùng đệm trong lúc tải: 99.91% (1605842 hit / 1398 read). Không phải hit ratio CDN: smoke đo origin, không CDN.

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

