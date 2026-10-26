# Lighthouse lab — kết quả mới nhất

Sinh bởi `pnpm perf:budget` (scripts/perf/lighthouse.mjs) lúc 2026-10-26T02:59:43.858Z. Hồ sơ đặc tả §10.1: 390×844, CPU 4×, 1600 Kbps xuống / 750 Kbps lên / RTT 150 ms (Lighthouse `devtools`: điều tiết áp dụng thật). Chrome 153.0.8010.12, Lighthouse 13.5.0, v22.22.0. Dữ liệu mẫu (fixtures), cache lạnh. Ngưỡng theo median: LCP ≤ 2500 ms, CLS ≤ 0.1. Đây là lab, không phải Core Web Vitals thực (không tuyên bố đạt CWV từ lab; INP đo bằng interaction test/RUM).

| Trang | Lần | LCP (ms) | CLS | TBT (ms) |
|---|---|---|---|---|
| / | 1 | 1423 | 0.000 | 180 |
| / | 2 | 1446 | 0.000 | 170 |
| / | 3 | 1423 | 0.000 | 187 |
| / | 4 | 1468 | 0.000 | 166 |
| / | 5 | 1488 | 0.000 | 179 |
| /danh-muc/ao | 1 | 1427 | 0.002 | 227 |
| /danh-muc/ao | 2 | 1508 | 0.002 | 195 |
| /danh-muc/ao | 3 | 1460 | 0.002 | 188 |
| /danh-muc/ao | 4 | 1418 | 0.001 | 213 |
| /danh-muc/ao | 5 | 1453 | 0.001 | 187 |
| /san-pham/ao-so-mi-lua | 1 | 1487 | 0.000 | 267 |
| /san-pham/ao-so-mi-lua | 2 | 1461 | 0.000 | 234 |
| /san-pham/ao-so-mi-lua | 3 | 1447 | 0.000 | 253 |
| /san-pham/ao-so-mi-lua | 4 | 1411 | 0.000 | 245 |
| /san-pham/ao-so-mi-lua | 5 | 1452 | 0.000 | 210 |

| Trang | LCP median | LCP p75 | CLS median | CLS p75 | TBT median | Kết quả |
|---|---|---|---|---|---|---|
| / | 1446 | 1468 | 0.000 | 0.000 | 179 | đạt |
| /danh-muc/ao | 1453 | 1460 | 0.002 | 0.002 | 195 | đạt |
| /san-pham/ao-so-mi-lua | 1452 | 1461 | 0.000 | 0.000 | 245 | đạt |
