# Sổ thử tối ưu hiệu năng (LOOP-OPT)

> T-127. Quy trình: [`optimization-loop.md`](../../../.xtemplates/framework/11-autonomous-loop/optimization-loop.md) — đo → profile → **một** thay đổi → **máy** quyết giữ/hoàn tác bằng `perf compare`. Mỗi lần thử (giữ hay bỏ) một mục ở §Nhật ký. Giả thuyết + falsifier được commit **trước** số đo (đối chiếu thứ tự commit, LOOP-OPT-004). Ngân sách tài nguyên/lab: [`README.md`](README.md); năng lực tải: [`load-dataset.md`](load-dataset.md).

## 1. Mục tiêu số + điều kiện đo (LOOP-OPT-001)

Đề xuất cho task tối ưu kế tiếp **T-060** (PLAN.md; viết lại dòng task/Gate là việc của phiên chính). Ngưỡng lấy nguyên từ đặc tả §10.1 — không nới.

| Chỉ số | Mục tiêu | Hiện trạng (nguồn) | Điều kiện đo |
|---|---|---|---|
| **Chính:** p95 PDP `GET /store/x/products/:handle` | ≤ 300 ms (§10.1 catalog) | 4.968 ms ở 30 + 3/s ([load-dataset.md](load-dataset.md), sau T-058) | `LOAD_REUSE=1 LOAD_READ_RPS=30 LOAD_WRITE_RPS=3 pnpm load:smoke`, pha steady 40 s; dataset 10.000 SP / 50.000 SKU seed 20260101; 1 tiến trình Medusa, `NODE_ENV=development`, mock GHN, COD; máy và tải hệ thống ghi trong `load-smoke-latest.md` |
| Chính: p95 đọc chung (listing/PDP/search) | ≤ 300 ms | 3.761 ms ở 30 + 3/s | như trên |
| Phụ (không xấu đi, LOOP-OPT-008): p95 ghi giỏ · lỗi | ≤ 700 ms · < 0,5 % | lỗi ghi 15 % ở 30 + 3/s | như trên |
| **Đại lượng cho máy quyết** (`perf compare`, ≥ 10 mẫu/bên) | `improved` so với commit gốc, cùng lượt, cùng máy | xem P-001 | thời gian tường của `node scripts/load/bench-pdp.mjs --requests 40` (40 PDP tuần tự, handle tất định trộn nhóm 500 đầu + đuôi dài, kiểm 200 + đúng handle) trên backend tải của chính cây đó (`scripts/load/serve.mjs`) |

Đại lượng máy quyết là **proxy chi phí phục vụ một PDP** (không tải nền); chỉ số chính vẫn đo bằng `load:smoke` ở 30 + 3/s và phải đạt trước khi đóng T-060. Đạt mục tiêu thì dừng (LOOP-OPT-011).

## 2. Bộ đo khoá (LOOP-OPT-002)

Trong task tối ưu, agent **không được sửa**: `scripts/load/*` (dataset, workload, `bench-pdp.mjs`, `serve.mjs`, `smoke.mjs`…), `scripts/perf/*` (gồm chính script Gate `opt-gate.sh`), test tương đương hành vi của điểm nóng (T-060: `apps/backend/integration-tests/http/catalog-search.spec.ts`, `checkout-submit.spec.ts`) và công cụ chấm `xt.py` (Gate dùng bản của commit gốc).

`scripts/perf/opt-gate.sh` gói các bước 2–6 của vòng: `perf guard --base <gốc> --locked 'scripts/load/*' --locked 'scripts/perf/*' [--locked …] --strict` → baseline đo lại trên commit gốc (worktree tạm, cùng lượt) → đo cây làm việc → `perf compare`; mọi bước dùng `xt.py` của commit gốc; exit của Gate = exit của `perf compare` (0 = `improved`). Test: `node --test scripts/perf/opt-gate.test.mjs` (improved/regressed/guard đỏ khi đụng file khoá/`--setup` lỗi, trên bản clone tạm).

Gate mẫu cho T-060 (phiên chính chép vào PLAN, thay `<gốc>` bằng SHA lúc mở task):

```bash
bash <(git show <gốc>:scripts/perf/opt-gate.sh) <gốc> \
  --locked 'apps/backend/integration-tests/http/catalog-search.spec.ts' \
  --locked 'apps/backend/integration-tests/http/checkout-submit.spec.ts' \
  --setup 'LOAD_REUSE=1 node scripts/load/serve.mjs start' --teardown 'node scripts/load/serve.mjs stop' \
  -- node scripts/load/bench-pdp.mjs --requests 40 \
&& pnpm --filter @x-shop/backend test:integration -- catalog-search checkout-submit \
&& LOAD_REUSE=1 LOAD_READ_RPS=30 LOAD_WRITE_RPS=3 pnpm load:smoke
```

Giới hạn đã biết: baseline và cây sau đo **tuần tự** (không xen kẽ — mỗi cây phải build và bật backend riêng); hai cây dùng chung DB tải (`xshop_load`) nên thay đổi có migration phải đo bằng cách khác; máy dev dùng chung nên nhiễu lớn — sàn nhiễu đo ở P-001.

## 3. Mẫu một lần thử (LOOP-OPT-004)

Commit A (trước khi đo): mục mới ở §Nhật ký với **điểm nóng** (profile/`EXPLAIN (ANALYZE, BUFFERS)`, trần Amdahl), **giả thuyết** (một thay đổi), **kỳ vọng** (số), **falsifier** (số nào thì bỏ). Commit B (sau khi đo): số trước/sau, dòng `perf compare`, quyết định (giữ khi `improved` + test xanh; còn lại hoàn tác), máy/tải/ngày.

## 4. Nhật ký

### P-001 — 2026-10-26 — Hiệu chuẩn A/A bộ đo PDP (không phải tối ưu, không đổi mã)

- **Mục đích:** biết sàn nhiễu của `bench-pdp.mjs` trên máy này và kiểm `perf compare` không báo `improved` giả khi hai bên là cùng một mã — điều kiện để dùng bộ đo này làm Gate T-060.
- **Giả thuyết:** hai bộ 10 mẫu (+2 warm-up mỗi bộ) trên cùng commit, cùng backend tải, chạy liền nhau → `perf compare` = `neutral`.
- **Kỳ vọng:** |Δ trung vị| dưới ngưỡng của compare (max(2 %, MAD/trung vị)); MAD/trung vị ≤ 10 %.
- **Falsifier:** `improved` hoặc `regressed` (p < 0,05 và vượt sàn), hoặc MAD/trung vị > 10 % → bộ đo/máy quá nhiễu cho quyết định giữ/hoàn tác: tăng số mẫu, xen kẽ hoặc ghim CPU trước khi dùng làm Gate T-060.
- **Cách đo** (một cây, không worktree vì cùng commit): `node scripts/load/serve.mjs start` → `xt.py perf guard --base HEAD --locked 'scripts/load/*' --locked 'scripts/perf/*' --strict` → `xt.py perf sample --out a1.json --runs 10 --warmup 2 -- node scripts/load/bench-pdp.mjs --requests 40` → cùng lệnh ra `a2.json` → `xt.py perf compare a1.json a2.json` → `serve.mjs stop`.
- **Số đo** (2026-10-26 17:47–17:49 UTC, commit `6afe5edad082ca6b96d2459365518ff3d5bfeb4d`; giả thuyết ở commit trước đó):
  - Máy: 4 CPU Intel Xeon @ 2.80GHz, 15 GiB RAM, máy dev **dùng chung** (phiên khác chạy test cùng lúc); tải hệ thống 0,70/1,28/1,96 → 1,08/1,25/1,88; Node v22.22.0; PostgreSQL 16.15; backend tải `serve.mjs start` (DB `xshop_load` dựng mới: 10.024 SP / 50.105 dòng read model, 1 tiến trình Medusa, `NODE_ENV=development`, mock); máy phát tải cùng máy.
  - `perf guard --base HEAD --locked 'scripts/load/*' --locked 'scripts/perf/*' --strict` → `✓ 0 file đổi`, exit 0.
  - a1 (10 mẫu, giây): 4,141 · 3,996 · 4,342 · 3,936 · 3,435 · 3,788 · 3,583 · 3,581 · 3,385 · 3,686 — trung vị 3,737.
  - a2 (10 mẫu, giây): 3,683 · 3,736 · 3,688 · 4,110 · 3,893 · 3,837 · 4,036 · 3,841 · 4,298 · 3,687 — trung vị 3,839.
  - `xt.py perf compare a1.json a2.json` → `neutral: trung vị 3.73702 → 3.83891 (+2.73%, ngưỡng 6.13%, p=0.3847, 10/10 mẫu)`, exit 1.
  - Trước khi viết giả thuyết đã chạy tay 3 lần để kiểm bộ đo hoạt động (4,15 · 3,41 · 4,04 s, `time`), không dùng làm mẫu.
- **Kết luận:** giả thuyết đứng — không có `improved`/`regressed` giả; MAD/trung vị = 6,13 % (≤ 10 %). Hệ quả cho T-060: trên máy này `perf compare` chỉ nhận thay đổi ≥ ~6 % của 40 PDP tuần tự (~93 ms/PDP lúc không tải); thay đổi nhỏ hơn cần thêm mẫu hoặc máy yên hơn. Không có gì để giữ/hoàn tác (không đổi mã).
- **Chưa chạy:** luồng đầy đủ `opt-gate.sh` với backend (worktree commit gốc + build + `serve.mjs` ở cả hai cây) — phiên này không được tạo worktree trên repo dùng chung; luồng đó đã có test trên bản clone tạm (`scripts/perf/opt-gate.test.mjs`), chạy thật lần đầu ở Gate T-060.
