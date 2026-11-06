# Kiểm tải smoke — kết quả mới nhất (T-036)

Kết quả: **ĐẠT** · 2026-10-26T15:09:01.918Z · `pnpm load:smoke` · commit `876d3d902fd4329fd757278505870743811ce109`

> Máy dev dùng chung, một tiến trình Node vừa phát tải vừa chạy cạnh backend + PostgreSQL + Redis: đây là **cổng hồi quy ở tỷ lệ thu nhỏ**, không phải năng lực production và không thay thế chạy đầy đủ §10.3 trên staging (xem `README.md` và `load-dataset.md`).

## Điều kiện tái lập

- Máy: 4 CPU (Intel(R) Xeon(R) Processor @ 2.80GHz), 15.7 GiB RAM, tải hệ thống đầu/cuối: 1.52/1.24/1.54 → 1.41/1.27/1.53; Node v22.22.0; PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1).
- Backend: Medusa 2.22.1 `medusa start` (1 tiến trình, worker shared), `NODE_ENV=development` (production từ chối mock GHN), GHN mock, chỉ COD, `XS_TRUSTED_PROXIES=loopback`; kết nối DB theo mặc định Medusa (không đặt pool).
- Dataset: 10000 sản phẩm / 50000 SKU (sinh mới) + 24 sản phẩm demo; seed 20260101; DB `xshop_load`, Redis DB 13, cổng 9200.
- Tải (§10.3 khởi điểm = 100 đọc/s + 10 ghi/s; smoke = 20× nhỏ hơn): **5 request đọc/s + 0.5 thao tác ghi/s**; pha lạnh 8 s → steady 40 s → burst gấp đôi 12 s.
- Read mix 60% listing (lọc theo danh mục/màu/size/chất liệu/giá/sắp xếp/trang, kèm facet) · 20% PDP · 20% search; write mix 60% sửa giỏ · 20% quote · 20% submit COD (Idempotency-Key riêng; 15% submit gửi lại cùng khoá để kiểm idempotency). Mỗi khách ảo một IP qua X-Forwarded-For.
- Ngưỡng (§10.1): p95 đọc ≤ 300 ms, ghi ≤ 700 ms, checkout ≤ 2000 ms; lỗi server < 0.5%; burst: latency ≤ 2× ngưỡng. Pha lạnh chỉ báo cáo (không làm cổng).

## Dựng môi trường

| Bước | Thời gian |
|---|---:|
| build domain | 2.4 s |
| làm mới DB + Redis | 1.4 s |
| migrate | 23.9 s |
| seed nền + catalog demo | 18.7 s |
| sinh dữ liệu (SQL) | 15.2 s |
| dựng read model (syncCatalogProducts) | 92.8 s |
| build backend | 21.3 s |

## Pha lạnh (8 s, hệ số ngưỡng ×1) — chỉ báo cáo

Đã phát: 39 đọc, 3 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 39 | 99.7 | 244.6 | 287.9 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 3 | 263.3 | 506.7 | 506.7 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 647.8 | 647.8 | 647.8 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 46 | 99.9 | 478.9 | 647.8 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 1 | 507 | 507 | 0 |
| cart_create | 1 | 263 | 263 | 0 |
| listing | 24 | 82 | 138 | 0 |
| pdp | 8 | 171 | 288 | 0 |
| quote | 1 | 68 | 68 | 0 |
| search | 7 | 100 | 187 | 0 |
| setup_cart_add | 1 | 479 | 479 | 0 |
| setup_cart_create | 1 | 281 | 281 | 0 |
| setup_quote | 1 | 73 | 73 | 0 |
| submit | 1 | 648 | 648 | 0 |

## Pha steady (40 s, hệ số ngưỡng ×1) — đạt

Đã phát: 199 đọc, 19 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 199 | 65.1 | 145.5 | 182.7 | ≤ 300 | 0 | 0.00% | 0 | đạt |
| write | 22 | 240.0 | 345.4 | 416.6 | ≤ 700 | 0 | 0.00% | 0 | đạt |
| checkout | 4 | 397.0 | 516.5 | 516.5 | ≤ 2000 | 0 | 0.00% | 0 | đạt |
| (chung) | 227 | 72.3 | 273.6 | 408.5 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 10 | 288 | 417 | 0 |
| cart_create | 7 | 164 | 229 | 0 |
| cart_update | 2 | 260 | 274 | 0 |
| listing | 119 | 53 | 106 | 0 |
| pdp | 39 | 100 | 158 | 0 |
| quote | 3 | 71 | 98 | 0 |
| search | 41 | 105 | 148 | 0 |
| submit | 4 | 397 | 517 | 0 |
| submit_replay | 2 | 65 | 82 | 0 |

## Pha burst (gấp đôi) (12 s, hệ số ngưỡng ×2) — đạt

Đã phát: 119 đọc, 11 thao tác ghi.

| Nhóm | Request | p50 ms | p95 ms | p99 ms | Ngưỡng p95 ms | Lỗi | Tỷ lệ lỗi | Nghiệp vụ | Kết quả |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| read | 119 | 68.5 | 143.5 | 167.0 | ≤ 600 | 0 | 0.00% | 0 | đạt |
| write | 13 | 260.1 | 426.4 | 426.4 | ≤ 1400 | 0 | 0.00% | 0 | đạt |
| checkout | 1 | 438.4 | 438.4 | 438.4 | ≤ 4000 | 0 | 0.00% | 0 | đạt |
| (chung) | 133 | 73.8 | 321.1 | 426.4 | — | 0 | 0.00% | 0 | đạt |

| Request | Số lượng | p50 ms | p95 ms | Lỗi |
|---|---:|---:|---:|---:|
| cart_add | 5 | 367 | 426 | 0 |
| cart_create | 3 | 173 | 238 | 0 |
| cart_update | 2 | 341 | 361 | 0 |
| listing | 71 | 56 | 98 | 0 |
| pdp | 25 | 124 | 167 | 0 |
| quote | 3 | 73 | 77 | 0 |
| search | 23 | 76 | 142 | 0 |
| submit | 1 | 438 | 438 | 0 |

## Cache PostgreSQL

Hit ratio vùng đệm trong lúc tải: 99.91% (1615871 hit / 1536 read). Không phải hit ratio CDN: smoke đo origin, không CDN.

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
| Tỷ lệ lỗi toàn phiên (cả pha lạnh) < 0.5% | đạt | 0/406 |

