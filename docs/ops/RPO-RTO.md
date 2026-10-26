# RPO / RTO theo kho dữ liệu — x-shop · 2026-10-26

> DB-BACKUP-001, DB-SEARCH-001 (T-074). Mục tiêu lấy từ đặc tả gốc `docs/specs/DAC-TA-GOC.md` §10.1 (dòng "Khôi phục": **RPO ≤ 15 phút, RTO ≤ 2 giờ — phải chứng minh bằng phục hồi thử**) — chủ sản phẩm đã chốt ở đó cho toàn hệ thống; tài liệu này áp con số đó cho từng kho, không đặt mục tiêu mới. Quy trình: `docs/ops/RUNBOOK.md` §3 (Redis), §4 (Postgres). RPO = lượng dữ liệu tối đa được mất (tính theo thời gian); RTO = thời gian tối đa từ lúc quyết định khôi phục tới khi dịch vụ chạy lại (NIST SP 800-34 Rev.1).

## Bảng kho → RPO → RTO → cơ chế → diễn tập

| Kho                                   | RPO                                 | RTO                                      | Cơ chế (chi tiết ở mục dưới)                                                                                              | Diễn tập gần nhất                                                                                         |
| ------------------------------------- | ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| PostgreSQL (nguồn sự thật)            | ≤ 15 phút                           | ≤ 2 giờ                                  | PITR production **chưa có** (chờ chủ dự án); bản logic `backup.sh`/`restore.sh` + đối chiếu sau mốc                        | 2026-10-25 `restore-drill.sh` (RTO 14–16 s, DB 78 KB); 2026-10-26 sao lưu/khôi phục 719 MB: 9,9 s + 12,2 s. **RPO: chưa** |
| Redis (khoá, hàng đợi, workflow, cache) | Không áp dụng (không chứa dữ liệu nguồn) | ≤ 2 giờ                                  | Khởi động lại, Redis trống là đủ; job tạo lại việc từ Postgres ≤ 1 phút                                                    | 2026-10-25 `restore-drill.sh` bước 5 (tính đúng; thời gian chưa đo)                                         |
| Read model catalog `catalog_variant_index` | Theo Postgres (dẫn xuất, tái dựng được) | ≤ 2 giờ; tái dựng đo **108–113 s** ở 50k SKU | Khôi phục cùng Postgres; hỏng/lệch → `pnpm --filter @x-shop/backend catalog:reindex`                                     | 2026-10-26 đo tái dựng 50.105 dòng (mục dưới); CI: `catalog-search`, `catalog-index-scale`                 |
| File upload/media (ảnh Admin)         | ≤ 15 phút                           | ≤ 2 giờ                                  | **Chưa có** — ghi đĩa cục bộ `apps/backend/static/`, không sao lưu                                                         | **Chưa**                                                                                                  |

## PostgreSQL

Nguồn sự thật: đơn, tiền (`order_finance`, `payment_attempt`, `payment_ledger`), tồn, catalog, khách, outbox, audit.

- **Cơ chế production (CHƯA CÓ — chờ chủ dự án chọn hạ tầng, RUNBOOK §4.5):** PITR bằng WAL archiving (`archive_timeout ≤ 300 s`) + base backup hằng ngày, mã hoá, lưu ngoài máy DB; managed PITR hoặc tự host WAL-G/pgBackRest.
- **Bổ sung đã có:** `scripts/ops/backup.sh` (`pg_dump -Fc`, mã hoá gpg, `.meta` ghi mốc snapshot + sha256). Một mình chỉ cho RPO ≈ chu kỳ chạy (hằng ngày ≈ 24 giờ) — **không đạt** 15 phút.
- **Khôi phục:** `scripts/ops/restore.sh` vào DB mới → `medusa db:migrate` → `scripts/ops/post-restore-reconcile.sh` (giao dịch VNPAY/GHN sau mốc) → mở lại checkout (RUNBOOK §4.2).
- **Diễn tập 2026-10-25** (`bash scripts/ops/restore-drill.sh`, máy dev, DB tổng hợp ≈ 78 KB): RTO đo **14 s và 16 s** (restore + kiểm toàn vẹn + migrate), 175/175 bảng khớp số dòng + md5, đối chiếu đúng 4 `txn_ref` + 2 vận đơn (RUNBOOK §4.4).
- **Đo 2026-10-26** (T-074, không phải diễn tập đủ bước): `backup.sh` + `restore.sh` trên DB đo đạc `xshop_perf` (50k SKU + 200k đơn tổng hợp, 719 MB sau khôi phục) — sao lưu mã hoá **9,9 s** (dump 23,6 MB), khôi phục **12,2 s** (`pg_restore -j 4`, sha256 khớp, số dòng `order_finance` 200.000 / `outbox_event` 595.604 / `catalog_variant_index` 50.105 khớp, index mới có mặt). Chưa gồm migrate, đối chiếu, dựng instance.
- **RPO: chưa diễn tập** (chưa có PITR).

## Redis

Chỉ chứa thứ tạo lại được: khoá phân tán (Locking Module), hàng đợi event bus, trạng thái workflow engine, cache. Mất toàn bộ được chấp nhận → không sao lưu, RPO không áp dụng.

- **Trong lúc mất:** checkout tự dừng (`503 LOCK_UNAVAILABLE`, `Retry-After: 60`), catalog vẫn chạy (RUNBOOK §3.2).
- **Khôi phục:** khởi động lại/instance mới (trống), khởi động lại server + worker; job định kỳ nhặt việc từ Postgres trong ≤ 1 phút (`x-reconcile-attempts`, `x-outbox-dispatch`, `x-expire-holds`); tác động ngoài khử trùng theo `message_key`/`txn_ref`/`client_order_code` (RUNBOOK §3.3).
- **Diễn tập 2026-10-25** (`restore-drill.sh` bước 5): xoá sạch Redis DB index diễn tập, hai worker đồng thời tạo lại đúng việc, không gửi lặp; chạy lại rỗng (RUNBOOK §3.5). Thời gian khởi động lại **chưa đo**.

## Read model catalog

`catalog_variant_index` (+ hàng đợi `catalog_index_dirty`) nằm trong Postgres và được sao lưu cùng DB; bản khôi phục nhất quán với nguồn tại cùng mốc. Hỏng hoặc lệch → tái dựng một lệnh từ nguồn: `pnpm --filter @x-shop/backend catalog:reindex` — đọc nguồn theo lô, thay cả bảng trong MỘT giao dịch (người đọc thấy bảng cũ tới khi commit, catalog không ngừng); SKU có giá niêm yết mà không ra giá bán → giữ bảng cũ + mở `catalog_index_mismatch` (D-040). Test CI tái dựng rồi truy vấn mẫu: `catalog-search.spec.ts`, `catalog-index-scale.spec.ts`.

### Thời gian tái dựng (`catalog:reindex`) — 2026-10-26

| Lần                                                                | Wall clock (gồm khởi động Medusa) | Bên trong `rebuildCatalogIndex` | Dòng (kỳ vọng 50.105) | Load avg 1 phút trước khi chạy |
| ------------------------------------------------------------------ | --------------------------------: | ------------------------------: | --------------------- | -----------------------------: |
| `pnpm --filter @x-shop/backend catalog:reindex` #1                 |                           113,3 s |                               — | 50.105                |                           1,69 |
| `pnpm --filter @x-shop/backend catalog:reindex` #2                 |                           108,3 s |                               — | 50.105                |                           2,66 |
| `medusa exec ../../scripts/load/index-dataset.ts` (cùng hàm, in ms) |                           113,7 s |                         105,7 s | 50.105, thiếu giá 0   |                           2,49 |
| Lần đầu sau khi sinh dữ liệu (`index-dataset.ts`)                  |                                 — |                          94,1 s | 50.105                |                              — |

Dữ liệu: 10.024 sản phẩm / 50.105 biến thể (50.000 SKU tải + 105 demo), sinh bằng SQL qua `node scripts/ops/perf-dataset.mjs` (phương pháp: `docs/ops/perf/load-dataset.md` §Đo `catalog:reindex`). Máy: 4 CPU Intel Xeon @ 2,80 GHz (`nproc` = 4), 15,7 GiB RAM (`free -h`: 15 Gi), PostgreSQL 16.15 + Redis cục bộ, Node 22.22.0, Medusa 2.22.1. **Máy đang chịu tải song song** (phiên khác chạy test cùng lúc) — số đo là của máy dev dùng chung, không phải production. Đo lại: `node scripts/ops/perf-dataset.mjs --reindex-only` trên DB đã dựng.

Kết luận: tái dựng ở 50k SKU ≈ 2 phút, xa dưới RTO 2 giờ.

## File upload / media

`apps/backend/medusa-config.ts` không khai File Module → provider mặc định của Medusa ghi ảnh tải qua Admin (`POST /admin/uploads`) vào đĩa cục bộ `apps/backend/static/` của máy server: không sao lưu, mất cùng máy, không chia sẻ giữa nhiều instance. Hướng đã ghi: file module S3-compatible + CDN (PROJECT.md stack, RUNBOOK §6) với versioning + sao chép sang bucket/vùng khác — **chờ chủ dự án chọn dịch vụ** (cần tài khoản thật). Ảnh demo (`static/demo/`) nằm trong git. Chưa có cơ chế → chưa diễn tập.

## Ngoài bảng

Giao dịch ở VNPAY/GHN sau mốc khôi phục không phải kho của hệ thống nhưng phải đối chiếu: `post-restore-reconcile.sh` (RUNBOOK §4.2 bước 5). Bí mật/cấu hình: kho bí mật của nền tảng triển khai (chưa chọn — RUNBOOK §0, §8.1).

## Còn treo (DB-BACKUP-001 chưa tick tới khi xong)

1. **PITR production cho Postgres** (RPO 15 phút) — chủ dự án chọn managed PITR hoặc tự host (RUNBOOK §4.5), rồi diễn tập PITR thật trên staging và ghi RPO/RTO đo được vào bảng trên.
2. **Kho file/media** — chọn dịch vụ S3-compatible + versioning/sao chép; cấu hình File Module; diễn tập khôi phục một ảnh đã xoá.
3. **RTO Postgres đủ bước ở cỡ thật** — diễn tập đủ bước (khôi phục + migrate + đối chiếu) mới chạy trên DB 78 KB; ở 719 MB mới đo riêng sao lưu/khôi phục. Cần diễn tập đủ bước trên cấu hình máy production, cộng thời gian dựng instance PITR.
4. Thời gian khởi động lại Redis + worker chưa đo.
