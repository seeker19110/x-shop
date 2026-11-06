# ADR-0007 — Cột tiền của module dự án là `bigint` VND, không thêm cột `currency char(3)` (DB-MODEL-002)

## Trạng thái

Accepted (2026-10-29), theo Q-22 của `docs/autopilot/PLAN-2.md`; task T-186. Thay phần "kiểu cột tiền integer" của D-009 (đường lùi của D-009 chính là bước này).

## Ngày

2026-10-29

## Bối cảnh

DB-MODEL-002 đòi cột tiền kiểu `bigint` (số nguyên đơn vị nhỏ nhất) KÈM cột `currency char(3)` ISO 4217; `numeric(p,s)` chỉ ở cột có ADR; cấm `real`/`double precision`/`float`/`money`. BASE-DATA-005 đòi tiền "luôn kèm mã ISO 4217".

Hiện trạng sau T-186: mọi cột tiền của module dự án (checkout, shipping, returns, settlement, catalog-index) là `bigint` VND — 11 cột đổi từ `integer` bằng Migration20261106100000/100100/100200/100300; `scripts/ops/check-schema.mjs` (luật MONEY_TYPE) chặn kiểu khác. Bảng native Medusa giữ `numeric` + `raw_*` kèm `currency_code` của Medusa (không thuộc phạm vi).

Phạm vi ra mắt là MỘT tiền tệ: đặc tả gốc §1 "một đơn vị bán, tiếng Việt, tiền VND" và bảng thị trường "Việt Nam, VND … chưa mở đa tiền tệ"; domain cố định `CURRENCY = "VND"` (`packages/domain/src/money/money.ts`, VND exponent 0); catalog ghi giá bằng `currency_code: "vnd"` (`apps/backend/src/lib/catalog/constants.ts`); báo giá trả `currency_code: "vnd"` (`apps/backend/src/lib/checkout/quote.ts`). Bảng tiền của module dự án đều gắn với một đơn/giỏ native (`order_id`/`cart_id`) mà `currency_code` native là nguồn sự thật về tiền tệ.

## Phương án đã cân nhắc

1. Thêm `currency char(3) not null default 'VND' check (currency = 'VND')` vào mọi bảng có cột tiền (12 bảng: checkout_quote, order_finance, payment_attempt, payment_ledger, ops_exception, shipment, x_refund, x_return_line, x_settlement_batch, x_settlement_line, x_settlement_discrepancy, catalog_variant_index) — loại lúc này: cột hằng không mang thông tin (CHECK chỉ cho một giá trị), thêm cột vào model DML (checkout, shipping) và mọi INSERT SQL tay mà không đổi được hành vi nào; đa tiền tệ thật cần nhiều hơn một cột (quy đổi, làm tròn theo exponent, đối soát theo tiền tệ) nên cột này cũng không làm việc đó rẻ hơn.
2. Không thêm cột; tiền tệ là bất biến của hệ thống (VND), ghi ở ADR này + domain `CURRENCY`; mọi cột tiền `bigint` VND, kiểm bằng check-schema — chọn.
3. Một cột `currency` chỉ ở bảng gốc (order_finance) — loại: các bảng còn lại vẫn không mang mã, lợi ích bằng không so với `currency_code` native của đơn.

## Quyết định

Phương án 2. Mọi cột tiền của module dự án là `bigint`, đơn vị là ĐỒNG (VND, ISO 4217, exponent 0). Không có cột `currency` ở bảng của module dự án; mã tiền tệ là hằng `CURRENCY = "VND"` của domain và `currency_code` của bản ghi native Medusa (region/giỏ/đơn). Cột tiền `numeric` chỉ được thêm kèm ADR mới và mục `MONEY_NUMERIC_ALLOW` (lý do nêu ADR) trong `scripts/ops/check-schema.mjs`.

Đọc `bigint`: driver `pg` trả int8 dạng chuỗi; parser toàn cục `apps/backend/src/lib/db/int8.ts` (cài ở `medusa-config.ts`) ép về `number` có `Number.isSafeInteger`, vượt 2^53 − 1 → truy vấn bị từ chối. Trần nghiệp vụ hiện có (báo giá ≤ 2.147.483.647 đ — `MAX_MONEY_VND`, trần dòng chứng từ đối soát) giữ nguyên; nới là quyết định nghiệp vụ riêng.

## Hệ quả

- Đạt phần kiểu cột của DB-MODEL-002 (`node scripts/ops/check-schema.mjs`, luật MONEY_TYPE; test `integration-tests/http/money-bigint.spec.ts`). Không đạt nguyên văn phần "kèm cột `currency char(3)`": đây là ngoại lệ có chủ đích, lý do ở trên.
- Thêm tiền tệ thứ hai mà không làm lại schema sẽ âm thầm ghi số tiền ngoại tệ vào cột VND. Hàng rào hiện có: catalog chỉ ghi giá `vnd`, báo giá trả `vnd`; CHƯA có kiểm tường minh "giỏ/region khác VND → từ chối" ở checkout — mở đa tiền tệ phải thêm kiểm đó cùng lúc với cột tiền tệ.
- Đường lùi (quyết định không có cột currency): thêm cột `currency char(3) not null default 'VND' check (currency = 'VND')` bằng migration mới (thêm cột có DEFAULT — không phá N−1), không cần backfill.
- Đường lùi (kiểu bigint): theo ĐÚNG thứ tự — (1) chạy down() của 4 migration T-186 (Migration20261106100300, 100200, 100100, 100000) đưa cột tiền về `integer`; down() tự dừng nếu có giá trị ngoài miền int4, khi đó không lùi được mà không mất dữ liệu; (2) rồi mới gỡ `installInt8Parser()` khỏi `medusa-config.ts` nếu muốn. Gỡ parser trước khi down() thì mọi đường đọc nhận int8 dạng chuỗi (API trả `"total": "1330000"`, so sánh `===` sai, cộng thành nối chuỗi — đo được ở n-minus-1: 36 ca đỏ). Giữ parser sau khi lùi kiểu thì vô hại (cột `integer` không đi qua parser int8).

## Điều kiện đọc lại

- Mở bán bằng tiền tệ thứ hai (region mới, thanh toán ngoại tệ, đối soát ngoại tệ) → thêm cột `currency` (đường lùi ở trên) + quy đổi/làm tròn theo exponent, viết ADR thay thế.
- Cần lưu giá dưới đơn vị đồng (tỷ giá, đơn giá lẻ) → cột `numeric` kèm ADR + `MONEY_NUMERIC_ALLOW`.
- Medusa hoặc MikroORM có kiểu DML bigint trả `number` → cân nhắc bỏ parser toàn cục ở `src/lib/db/int8.ts`.
