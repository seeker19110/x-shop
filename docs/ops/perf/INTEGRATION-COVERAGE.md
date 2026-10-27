# Coverage test tích hợp backend (T-135, QA-COV-001, D-064)

## Lệnh

- Đo: `pnpm --filter @x-shop/backend test:integration:coverage` (jest, provider v8, `TEST_TYPE=integration:http`, một worker). Báo cáo ghi ra `apps/backend/coverage-integration/` — không đè `apps/backend/coverage/` của unit. Cần Postgres/Redis (`scripts/dev-services.sh`; `DATABASE_URL`, `REDIS_URL`). `shutdown.spec.ts` chạy tiến trình `medusa start` thật nên cần `pnpm build` trước (CI đã build trong `gate-par`).
- So baseline: `node scripts/coverage-ratchet.mjs --suite integration` (mục `integration` của `coverage-baseline.json`). Không có `--suite` thì chỉ so mục unit, không đòi chạy test tích hợp.
- Nâng baseline (chỉ tăng): `node scripts/coverage-ratchet.mjs --suite integration --update`.

## Số đo (2026-10-27)

- Điều kiện: Linux x86_64 4 vCPU / 16 GB, Node 22.22.0, Postgres + Redis cục bộ; máy **đang chạy song song** các phiên khác (load average ≈ 4,1–4,6 trên 4 lõi, một phiên khác chạy jest tích hợp cùng lúc). Không phải máy CI sạch.
- Kết quả: 47 suite / 755 test, **real 36 phút 39 giây** (jest `Time: 2197 s`); 46 suite xanh, `shutdown.spec.ts` đỏ 5 test vì worktree chưa `pnpm build` (thiếu `@x-shop/domain/dist`) — lỗi môi trường, không phải lỗi mã.
- Một lần chạy trước (cùng điều kiện tải) bị dừng ở suite thứ 29 sau 30 phút do giới hạn thời gian nền của công cụ, không do test.
- Đối chứng không coverage (log chạy `test:integration` các lần khác trên cùng máy, cùng mức tải): 1619–1972 s (27–33 phút). Overhead v8 ≈ 10–35 %.
- Coverage đo được: lines **91,85 %**, branches **81,73 %** (statements 91,85 %, functions 89,63 %) — so với unit của backend lines 28,78 % / branches 83,10 %. Số này là cận dưới (suite shutdown đỏ).

## Quyết định nối CI: KHÔNG (D-064, đường lùi "miễn có lý do")

- Ngưỡng D-064: job ≤ 20 phút. Đo 36–37 phút (kể cả giả định máy CI nhanh gấp đôi vẫn ~18 phút + dựng Postgres/Redis, cài phụ thuộc, `pnpm build` ≈ vượt ngưỡng), và chỉ test tích hợp không coverage cũng đã 27–33 phút ở cùng điều kiện.
- Không nhét vào job `gate` (đã ~26/30 phút). Job riêng song song cần Postgres/Redis như `gate`, build backend, không là required check — chưa đạt ngưỡng nên chưa làm; `.github/workflows/ci.yml` không đổi.
- Việc ratchet integration chạy tay/theo mốc (trước G7, sau thay đổi lớn ở luồng đặt hàng/thanh toán) bằng lệnh ở trên.
- Mở lại khi: test tích hợp được chia shard/song song hoá để job đo trên runner thật ≤ 20 phút (đo bằng `time` ở bước CI, không ở máy dev đang tải).
