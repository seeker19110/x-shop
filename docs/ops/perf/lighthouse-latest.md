# Lighthouse lab — kết quả mới nhất

Sinh bởi `pnpm perf:budget` (scripts/perf/lighthouse.mjs) lúc 2026-10-26T03:07:32.567Z. Hồ sơ đặc tả §10.1: 390×844, CPU 4×, 1600 Kbps xuống / 750 Kbps lên / RTT 150 ms (Lighthouse `devtools`: điều tiết áp dụng thật). Chrome 153.0.8010.12, Lighthouse 13.5.0, v22.22.0. Dữ liệu mẫu (fixtures), cache lạnh. Ngưỡng theo median: LCP ≤ 2500 ms, CLS ≤ 0.1. Đây là lab, không phải Core Web Vitals thực (không tuyên bố đạt CWV từ lab; INP đo bằng interaction test/RUM).

| Trang | Lần | LCP (ms) | CLS | TBT (ms) |
|---|---|---|---|---|
| / | 1 | 1449 | 0.000 | 171 |
| / | 2 | 1431 | 0.000 | 210 |
| / | 3 | 1465 | 0.000 | 185 |
| / | 4 | 1436 | 0.000 | 184 |
| / | 5 | 1437 | 0.000 | 225 |
| /danh-muc/ao | 1 | 1426 | 0.002 | 149 |
| /danh-muc/ao | 2 | 1448 | 0.001 | 202 |
| /danh-muc/ao | 3 | 1432 | 0.001 | 183 |
| /danh-muc/ao | 4 | 1457 | 0.002 | 181 |
| /danh-muc/ao | 5 | 1412 | 0.002 | 175 |
| /san-pham/ao-so-mi-lua | 1 | 1438 | 0.000 | 234 |
| /san-pham/ao-so-mi-lua | 2 | 1449 | 0.000 | 242 |
| /san-pham/ao-so-mi-lua | 3 | 1622 | 0.000 | 286 |
| /san-pham/ao-so-mi-lua | 4 | 1462 | 0.000 | 245 |
| /san-pham/ao-so-mi-lua | 5 | 1429 | 0.000 | 238 |

| Trang | LCP median | LCP p75 | CLS median | CLS p75 | TBT median | Kết quả |
|---|---|---|---|---|---|---|
| / | 1437 | 1449 | 0.000 | 0.000 | 185 | đạt |
| /danh-muc/ao | 1432 | 1448 | 0.002 | 0.002 | 181 | đạt |
| /san-pham/ao-so-mi-lua | 1449 | 1462 | 0.000 | 0.000 | 242 | đạt |
