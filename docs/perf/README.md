# Baseline tài nguyên (`docs/perf/`)

`baseline-<YYYY-MM-DD>.json` là ảnh chụp tài nguyên tại một commit (T-216, XC-GREEN-001), dùng làm mốc so sánh cho các thay đổi hiệu năng sau này. Khác `docs/ops/perf/` (báo cáo ngân sách/lab/tải theo từng lần chạy): đây là mốc commit vào repo.

## Chạy lại

```bash
# Cần Postgres/Redis cục bộ (DB tải riêng xshop_load, xem scripts/load/env.mjs) và `pnpm install`.
LOAD_PRODUCTS=2000 node scripts/perf/baseline.mjs                 # ghi docs/perf/baseline-<ngày UTC>.json
LOAD_PRODUCTS=2000 LOAD_REUSE=1 node scripts/perf/baseline.mjs    # dùng lại DB tải đã dựng
node scripts/perf/baseline.mjs --skip-backend                     # chỉ storefront (cần build, không cần DB)
node scripts/perf/baseline.mjs --skip-storefront --requests 1000 --concurrency 8
```

Mặc định dataset là 10.000 sản phẩm (`LOAD_PRODUCTS`); mốc đã commit dùng cỡ ghi ở `backend.dataset.products`. So sánh chỉ có nghĩa khi cùng cỡ dataset, cùng `concurrency` và cùng loại máy (`environment`). Chạy hai lần cùng ngày sẽ ghi đè file của ngày đó.

## Ý nghĩa các số

- `commit`, `dateUtc`, `environment`: commit gốc (HEAD lúc đo — thay đổi chưa commit không nằm trong số), ngày UTC, bản node, CPU, số nhân, RAM.
- `storefront.pages[]` — mỗi màn chính (trang chủ, danh mục, PDP, giỏ), build production + `next start` với dữ liệu mẫu (`XS_DATA_SOURCE=fixtures`):
  - `requests`: số request = HTML + mọi tài nguyên tĩnh HTML tham chiếu (script, stylesheet, preload font, ảnh cùng origin). Font nạp qua `@font-face` trong CSS (không preload trong HTML) không được tính → `font: 0` ở mốc hiện tại là giới hạn của phương pháp, không phải "không có font".
  - `bytes.*` / `totalBytes` / `totalKiB`: byte truyền tải theo loại; văn bản gzip mức 9 (như CDN), font/ảnh byte thật.
  - Không gồm chunk nạp động sau hydrate, RSC prefetch, ảnh lazy: số này là cận dưới của tải đầu. Ngân sách §10.2 đo bằng trình duyệt thật ở `pnpm perf:budget` (`scripts/perf/budget.mjs`).
- `backend` — N request (mặc định 1.000) `GET /store/x/products/:handle` vào backend tải, `concurrency` song song, sau 50 request khởi động nóng:
  - `cpuMs`, `cpuMsPerRequest`: CPU (utime+stime) của cả nhóm tiến trình backend trong đợt đo, đọc từ `/proc`; `cpuUtilizationPercentOfOneCore` = CPU / thời gian tường (100 = một nhân đầy).
  - `wallMs`, `requestsPerSecond`: thời gian tường và thông lượng (đặc trưng của máy đo, không phải năng lực production).
  - `rssBeforeMiB`, `rssAfterMiB`, `rssDeltaMiB`: RSS cộng cả nhóm tiến trình trước/sau đợt; `peakRssSumMiB`: tổng đỉnh RSS (VmHWM) từng tiến trình, tính từ lúc khởi động (cận trên: các tiến trình không nhất thiết đạt đỉnh cùng lúc).
- Khối nào không đo được: `measured: false`, `value: null`, `reason` nêu lý do — không có số bịa.
