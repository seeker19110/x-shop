# Kiểm tải smoke — kết quả mới nhất (T-036)

Kết quả: **ĐẠT** · 2026-10-26T04:06:25.612Z · `pnpm load:smoke`

> Máy dev dùng chung, một tiến trình Node vừa phát tải vừa chạy cạnh backend + PostgreSQL + Redis: đây là **cổng hồi quy ở tỷ lệ thu nhỏ**, không phải năng lực production và không thay thế chạy đầy đủ §10.3 trên staging (xem `README.md` và `load-dataset.md`).

## Điều kiện tái lập

- Máy: 4 CPU (Intel(R) Xeon(R) Processor @ 2.80GHz), 15.7 GiB RAM, tải hệ thống đầu/cuối: 1.18/1.10/1.28 → 1.09/1.06/1.25; Node v22.22.0; PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1).
- Backend: Medusa 2.22.1 `medusa start` (1 tiến trình, worker shared), `NODE_ENV=development` (production từ chối mock GHN), GHN mock, chỉ COD, `XS_TRUSTED_PROXIES=loopback`; kết nối DB theo mặc định Medusa (không đặt pool).
- Dataset: 10000 sản phẩm / 50000 SKU (sinh mới) + 24 sản phẩm demo; seed 20260101; DB `xshop_load`, Redis DB 13, cổng 9200.
- Tải (§10.3 khởi điểm = 100 đọc/s + 10 ghi/s; smoke = 20× nhỏ hơn): **5 request đọc/s + 0.5 thao tác ghi/s**; pha lạnh 8 s → steady 40 s → burst gấp đôi 12 s.
- Read mix 60% listing (lọc theo danh mục/màu/size/chất liệu/giá/sắp xếp/trang, kèm facet) · 20% PDP · 20% search; write mix 60% sửa giỏ · 20% quote · 20% submit COD (Idempotency-Key riêng; 15% submit gửi lại cùng khoá để kiểm idempotency). Mỗi khách ảo một IP qua X-Forwarded-For.
- Ngưỡng (§10.1): p95 đọc ≤ 300 ms, ghi ≤ 700 ms, checkout ≤ 2000 ms; lỗi server < 0.5%; burst: latency ≤ 2× ngưỡng. Pha lạnh chỉ báo cáo (không làm cổng).

## Dựng môi trường

| Bước | Thời gian |
|---|---:|
| build domain | 1.9 s |
| làm mới DB + Redis | 0.8 s |
| migrate | 19.0 s |
| seed nền + catalog demo | 15.1 s |
| sinh dữ liệu (SQL) | 13.3 s |
| dựng read model (syncCatalogProducts) | 77.0 s |
| build backend | 17.2 s |

## Pha lạnh (8 s, hệ số ngưỡng ×1) — chỉ báo cáo

Đã phát: 39 đọc, 3 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 39 | 79.6 | 222.7 | 277.9 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 3 | 272.3 | 319.9 | 319.9 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 447.0 | 447.0 | 447.0 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 46 | 81.1 | 319.9 | 447.0 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 1 | 272 | 272 | 0 |
| cart_create | 1 | 320 | 320 | 0 |
| listing | 24 | 72 | 125 | 0 |
| pdp | 8 | 97 | 177 | 0 |
| quote | 1 | 72 | 72 | 0 |
| search | 7 | 88 | 278 | 0 |
| setup_cart_add | 1 | 357 | 357 | 0 |
| setup_cart_create | 1 | 224 | 224 | 0 |
| setup_quote | 1 | 60 | 60 | 0 |
| submit | 1 | 447 | 447 | 0 |

## Pha steady (40 s, hệ số ngưỡng ×1) — đạt

Đã phát: 199 đọc, 19 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 199 | 66.4 | 186.7 | 340.0 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 22 | 198.4 | 293.6 | 334.3 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 4 | 320.1 | 359.7 | 359.7 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 225 | 69.8 | 271.8 | 349.3 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 10 | 244 | 334 | 0 |
| cart_create | 7 | 142 | 254 | 0 |
| cart_update | 2 | 205 | 210 | 0 |
| listing | 119 | 61 | 109 | 0 |
| pdp | 39 | 75 | 117 | 0 |
| quote | 3 | 46 | 54 | 0 |
| search | 41 | 76 | 331 | 0 |
| submit | 4 | 320 | 360 | 0 |

## Pha burst (gấp đôi) (12 s, hệ số ngưỡng ×2) — đạt

Đã phát: 119 đọc, 11 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 119 | 66.5 | 226.9 | 417.8 | ≤ 600 | 0 | 0.00% | 0 | đạt |
| write | 12 | 226.0 | 432.0 | 432.0 | ≤ 1400 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 290.5 | 290.5 | 290.5 | ≤ 4000 | 0 | 0.00% | 0 | đạt |
| (chung) | 132 | 68.5 | 290.5 | 432.0 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 4 | 251 | 432 | 0 |
| cart_create | 2 | 226 | 261 | 0 |
| cart_update | 3 | 239 | 385 | 0 |
| listing | 71 | 68 | 144 | 0 |
| pdp | 25 | 70 | 179 | 0 |
| quote | 3 | 66 | 99 | 0 |
| search | 23 | 62 | 418 | 0 |
| submit | 1 | 291 | 291 | 0 |

## Cache PostgreSQL

Hit ratio vùng đệm trong lúc tải: 99.98% (5383614 hit / 1327 read). Không phải hit ratio CDN: smoke đo origin, không CDN.

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

