# Bộ dữ liệu tải và kịch bản §10.3 (T-036)

Phạm vi: dataset 10.000 sản phẩm / 50.000 SKU, kịch bản tải read/write mix theo `docs/specs/DAC-TA-GOC.md` §10.3, kết quả đo trên máy dev. Kết quả smoke mới nhất: `load-smoke-latest.md` (ghi lại sau mỗi lần chạy `pnpm load:smoke`; `load-smoke-latest.json` không commit).

## Cách chạy

| Việc | Lệnh |
|---|---|
| Smoke (cổng, Gate T-036): dựng môi trường mới + 3 pha + stress + kiểm tính đúng | `pnpm load:smoke` (~3,5 phút, trong đó tải ~1 phút) |
| Giữ DB đã dựng để chạy lại nhanh (~1,5 phút) | `LOAD_REUSE=1 pnpm load:smoke` |
| Test hàm thuần (PRNG, mix, ngưỡng, báo cáo, dataset) | `pnpm load:test` |
| Kịch bản đầy đủ §10.3 (staging/máy tải riêng) | `k6 run -e BASE_URL=… -e PUBLISHABLE_KEY=… scripts/load/k6/xshop-load.js` |

Biến môi trường của smoke (mặc định trong `scripts/load/env.mjs`): `LOAD_DB_NAME` (mặc định `xshop_load`, bắt buộc tiền tố `xshop_load` — chặn drop nhầm DB khác) · `LOAD_REDIS_DB` (13; không cho 0/7) · `LOAD_PORT` (9200) · `LOAD_PRODUCTS` (10000) · `LOAD_READ_RPS` (5) · `LOAD_WRITE_RPS` (0,5) · `LOAD_COLD_SECONDS` (8) · `LOAD_STEADY_SECONDS` (40) · `LOAD_BURST_SECONDS` (12) · `LOAD_CONTENTION` (50) · `LOAD_SEED` · `LOAD_REUSE`. Cần PostgreSQL + Redis cục bộ (`bash scripts/dev-services.sh`).

## Dataset

Sinh bằng SQL hàng loạt phía server (`scripts/load/dataset.mjs`: `generate_series` → `INSERT … SELECT`, một giao dịch) trên DB đã migrate + `seed-catalog` (cần region, kênh bán, kho, danh mục, từ điển màu/size, bảng size của seed). **Tất định**: mọi giá trị là hàm của số thứ tự sản phẩm `n`, không có ngẫu nhiên/`now()` — hai lần sinh cho hai DB giống hệt.

- 10.000 sản phẩm (`sp-load-00001…10000`, `metadata.load=true`), đúng 50.000 SKU: hình dạng (màu × size) theo `n % 4` = 1×5, 2×3, 2×2, 1×5 → 5 SKU/sản phẩm trung bình. Màu lấy từ 9 màu từ điển; size chữ XS–XL (giày: 38–42).
- Phân bố: 6 danh mục lá (áo nữ, quần nữ, váy-đầm, áo nam, quần nam, giày) + cha qua `lineage`; 9 chất liệu; giá VND nguyên 99.000–498.000 (bội của 1.000), một giá cho mọi SKU của sản phẩm; tồn: 5% SKU hết hàng (0), còn lại 5–60.
- Ảnh: 3 góc/màu như seed demo (SVG placeholder — **không phải ảnh kích thước sản xuất**: §10.3 đòi ảnh sản xuất; chưa có ảnh thật, xem câu hỏi mở). Thuộc tính thời trang + bảng size theo danh mục có đủ.
- Read model `catalog_variant_index`: 50.105 dòng (50.000 + 105 của 24 sản phẩm demo) dựng bằng `syncCatalogProducts` (`scripts/load/index-dataset.ts`, chạy bằng `medusa exec`) — xem Phát hiện 1 vì sao không dùng `rebuildCatalogIndex`.

Thời gian đo được (2026-10-26, máy dev 4 CPU, dựng mới): migrate ~16 s · seed nền + demo ~13 s · **sinh dữ liệu SQL: 13,3 s** (bản đầu 113 s, trong đó 100 s do truy vấn con tương quan của cột `thumbnail` — đã thay bằng tra bảng 9 dòng) · dựng read model ~76 s · build backend ~16 s. Tổng dựng ~2,5 phút; tải ~1 phút.

## Điều kiện tái lập (đã ghi trong báo cáo mỗi lần chạy)

Máy 4 CPU Xeon 2,8 GHz, 15,7 GiB RAM, **dùng chung** với các phiên khác (tải hệ thống nền ~1–2 trước khi chạy); PostgreSQL 16.15 cục bộ, Redis cục bộ DB 13; Medusa 2.22.1 `medusa start` một tiến trình (worker shared), kết nối DB theo mặc định Medusa (không đặt pool); `NODE_ENV=development` vì production từ chối GHN mock (`lib/env.ts`) — chưa đo chênh lệch với production mode. GHN mock (độ trễ cố định theo mock, **không có độ trễ giả lập cấu hình được**), chỉ COD, VNPAY tắt. Máy phát tải (Node/k6) chạy cùng máy nên tranh CPU với backend + PostgreSQL.

Rate limit (SEC03) **không bị nới**: tải đến từ một IP nên backend của môi trường tải đặt `XS_TRUSTED_PROXIES=loopback` và máy tải gửi `X-Forwarded-For` khác nhau mỗi khách (dải 100.64.0.0/10) — đúng như sau CDN/LB thật. Mặc định của sản phẩm giữ nguyên (không đổi code/config). Nếu rate limit chặn, request bị tính là **lỗi** (429), không bị che.

## Kịch bản

Read mix 60% listing (danh mục × màu × size × chất liệu × giá × sắp xếp × trang, response kèm facet) · 20% PDP (50% nhóm 500 sản phẩm đầu — cache ấm, 50% đuôi dài) · 20% search (có/không dấu, SKU, "mẫu NNNNN", từ khoá không có kết quả). Write mix 60% sửa giỏ (tạo giỏ + thêm dòng / đổi số lượng / thêm dòng) · 20% quote · 20% submit COD (Idempotency-Key riêng; 15% gửi lại cùng khoá). Chọn theo "bộ bài" nên mọi 5 thao tác đúng 3/1/1 — tỷ lệ không trôi trong bài ngắn. Mô hình mở (arrival rate): độ trễ tăng không làm giảm tải. Pha: lạnh (chỉ báo cáo) → steady → burst gấp đôi (ngưỡng latency ×2, lỗi vẫn < 0,5%). Ngưỡng (§10.1): p95 catalog/search ≤ 300 ms; ghi nội bộ ≤ 700 ms; checkout nội bộ ≤ 2 s; lỗi server < 0,5% (mạng/timeout, 5xx, 429 và mọi 4xx ngoài danh sách nghiệp vụ đều là lỗi).

Sau tải (đọc DB): không âm tồn (0 ≤ giữ chỗ ≤ tồn trên mọi dòng), giữ chỗ khớp `reservation_item`, không trùng `(scope, Idempotency-Key)`, không giỏ nào có > 1 đơn, số đơn mới trong DB = số mã đơn khác nhau khách nhận được, gửi lại cùng khoá trả đúng đơn cũ. Stress §10.3: 50 lượt đặt đồng thời cho SKU còn 1 → đúng 1 `200`, 49 `409`, không 5xx, giữ chỗ = 1.

Ngoài tầm với của bản này (§10.3 còn đòi): bài 30 phút, thử từ mạng Việt Nam, hit ratio CDN, ảnh sản xuất, test sandbox protocol/timeout riêng, ranh giới hết hạn/thanh toán thành công, worker crash. Smoke chỉ đo **origin**, không CDN → không phải bằng chứng DB đáp ứng toàn tải.

## Năng lực đo được (cùng máy, cùng dataset; lần chạy 2026-10-26)

| Tải (đọc/s + ghi/s) | Kết quả steady | Kết quả burst (×2) |
|---|---|---|
| 5 + 0,5 (smoke mặc định, 1/20) | p95 đọc ~120 ms, ghi ~280 ms, checkout ~350 ms; lỗi 0 — đạt | p95 đọc ~130 ms, ghi ~340 ms — đạt |
| 10 + 1 (1/10) | p95 đọc 132 ms, ghi 398 ms — đạt | (20 + 2): đọc 626 ms (> 600), ghi 2,3 s (> 1,4 s) — **vượt** |
| 20 + 2 (1/5) | p95 đọc 529–792 ms, ghi 2,8 s — **vượt** | sụp đổ: timeout 10 s, lỗi 9–13% — **vượt** |
| 100 + 10 (§10.3 nguyên bản, k6 60 s) | thông lượng thực ~18 req/s, `dropped_iterations` ~80/s, p95 đọc/ghi > 60 s (timeout) — **vượt hoàn toàn** | — |

→ **Một tiến trình Medusa + PostgreSQL trên máy 4 CPU dùng chung không chịu nổi tải khởi điểm §10.3**; ngưỡng vỡ nằm khoảng 10–20 request đọc/s kèm 1–2 thao tác ghi/s. Đây là số đo của máy dev dùng chung (nhiễu từ phiên khác, máy phát tải cùng máy) — **không phải năng lực production**; dùng để chọn tải cho cổng hồi quy (smoke giữ biên ≥ 2× ở cả pha burst) và để biết chỗ nghẽn, chưa đủ để kết luận cần bao nhiêu máy.

Smoke chọn 1/20 chứ không 1/5: cổng phải xanh ổn định trên máy dùng chung mà không nới ngưỡng (`LOOP-CI-001`). Ngưỡng p95 giữ nguyên bảng §10.1; chỉ tải thu nhỏ.

### Chỗ nghẽn quan sát được

- **Listing/search (PostgreSQL)**: mỗi request listing chạy 4 truy vấn (trang + 3 facet) đều quét tuần tự toàn bảng `catalog_variant_index` (50.105 dòng) rồi nhóm/đếm — không có chỉ mục phủ cho lọc theo danh mục (`'ao-nu' = ANY(category_handles)` dùng Seq Scan dù có GIN `IDX_cvi_category_handles`, vì chọn lọc kém ở ~15% bảng). `EXPLAIN (ANALYZE, BUFFERS)` một người dùng, cache ấm:

  | Truy vấn | Thực thi | Buffers (8 KiB) | Kế hoạch |
  |---|---:|---:|---|
  | Trang listing, danh mục `ao-nu` (7.518 dòng khớp/1.671 sản phẩm) | 21,8 ms | 2.462 | Seq Scan 50.105 dòng → HashAggregate |
  | Facet màu cùng phạm vi (2 lần quét + sort) | 39,4 ms | 4.915 | 2× Seq Scan + Sort + Hash Join |
  | Search "ao so mi" (3 từ; 1.668 sản phẩm) | 79,7 ms | 8.407 | 3× Bitmap Scan trgm (9–17k dòng/từ) + Seq Scan + Hash Join |

  → ~120 ms CPU PostgreSQL cho MỘT listing (page + 3 facet), ~200 ms cho một search; ở 5 + 0,5/s dư dả, ở 20 + 2/s PostgreSQL chiếm gần hết 4 CPU (quan sát `top`: ~10 tiến trình postgres 20–40% CPU) và kéo cả Node. Hit ratio vùng đệm PostgreSQL 99,9%+ (không phải I/O): nghẽn là CPU/quét.
- **Ghi giỏ (Node)**: một request tạo giỏ/thêm dòng ~130–280 ms ngay cả khi máy rảnh (workflow Medusa trên một tiến trình, một event loop) → trần vài chục thao tác giỏ/s mỗi tiến trình, thấp hơn nhiều khi PostgreSQL bận.

Hướng xử lý (đề xuất, chưa làm — ngoài phạm vi T-036; AGENTS.md: "chỉ tăng hạ tầng khi có số liệu"): chỉ mục/bảng ở cấp sản phẩm cho listing; gộp 3 facet thành 1 truy vấn hoặc cache facet theo (danh mục, bộ lọc) vài chục giây; tách worker khỏi server; nhiều instance backend sau LB; CDN cho GET catalog (đã có `Cache-Control: public, s-maxage=60`).

## Phát hiện (lỗi thật — báo cáo, không sửa trong T-036)

1. **`rebuildCatalogIndex` chỉ dựng được ~4.000 dòng khi có 50.000 SKU.** Tái hiện: DB đã migrate + `seed-catalog` + `dataset.mjs` (10.000 sản phẩm), rồi `cd apps/backend && pnpm exec medusa exec ./src/scripts/rebuild-catalog-index.ts` → log `[catalog-index] Rebuild: 10024 sản phẩm, 4000 dòng.` (thiếu ~46.000 dòng, im lặng, ~68 s). Nguyên nhân đã khoanh: `rebuildUnlocked` gọi `buildIndexRows` MỘT lần cho mọi sản phẩm → `loadVariantPrices` truy vấn `calculated_price` cho 50.000 biến thể một lượt; đo trực tiếp `loadVariantPrices(ids)`: 500 → 500, 2.000 → 2.000, 5.000 → **4.000**, 10.000 → **4.000** (trần 4.000 kết quả). Biến thể không có giá bị bỏ khỏi index (`if (!price) continue`) → sản phẩm biến mất khỏi listing/search mà không có lỗi. `syncUnlocked` (đường sự kiện/xả hàng đợi) chia lô 100 sản phẩm nên không dính. Đề xuất sửa: `rebuildUnlocked` đọc theo lô như `syncUnlocked`; `loadVariantPrices` chia lô ≤ 1.000 id (và/hoặc cảnh báo khi số giá trả về < số id có giá); thêm test với > 4.000 biến thể. Catalog thật (≥ 800 sản phẩm × 5 SKU) sẽ dính ngay khi chạy `catalog:reindex` hoặc dấu rebuild trong hàng đợi.
2. Hiệu năng listing/search và ghi giỏ như mục "Chỗ nghẽn" ở trên.

## Câu hỏi mở (cần phiên chính quyết)

1. **Chạy tải đầy đủ §10.3 trên staging**: ai/khi nào, hạ tầng nào? Phương án A: k6 (`scripts/load/k6/xshop-load.js`, đã kiểm cú pháp + chạy thử với k6 v2.3.0) từ máy tải riêng ở Việt Nam vào staging sau LB, 30 phút + burst 2 phút, kèm đo cache ấm/lạnh; B: chạy k6 trên CI tự host. Dữ kiện: máy dev không đạt 100 + 10/s (bảng trên), nên cần ít nhất vài instance backend + DB riêng.
2. **Khai `perf`/`load` trong `xt.yaml`** (đề xuất: `perf: "pnpm perf:budget && pnpm load:smoke"` khi phiên chính duyệt; T-048 đã gom khai perf). Smoke mất ~3,5 phút (dựng DB mới) — có nên đưa vào CI hay chỉ chạy trước release?
3. **Ảnh sản xuất** cho dataset (§10.3): hiện SVG placeholder; cần ảnh thật hoặc bộ ảnh tổng hợp đúng kích thước (hero < 200 KiB, card 40–90 KiB, PDP ~180 KiB) trước khi tuyên bố đạt LCP/băng thông ở quy mô.
4. **Cài k6**: k6 v2.3.0 (AGPL-3.0) tải từ kho `dl.k6.io` (khớp SHA-256 trong `Packages`) và giải nén vào `node_modules/.cache/k6-dl` chỉ để kiểm kịch bản, **không cài vào hệ thống/không vào lockfile**; dùng như công cụ chạy bên ngoài (không đóng gói). Cần ADR/đồng ý nếu muốn chuẩn hoá cách cài k6 trong CI. `load:smoke` dùng Node thuần (không phụ thuộc k6).
