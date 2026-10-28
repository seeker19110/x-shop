# ADR-0004 — Stack: pnpm monorepo, Medusa v2 + Next.js, lõi domain thuần TS

## Trạng thái

Accepted (2026-10-28) — supersedes ADR-0001. Quyết định giữ nguyên; ADR này chỉ viết lại theo mẫu MADR (Q-17, ARC-ADR-003/004) vì ADR-0001 đã accepted nên không được sửa nội dung.

## Ngày

2026-10-28 (quyết định gốc: D-005, 2026-10-24; số phiên bản bên dưới ghi nguyên theo ngày 2026-10-24 của ADR-0001, đối chiếu với manifest ngày 2026-10-28, không tra mạng)

## Bối cảnh

Đặc tả gốc §7 chọn Next.js + Medusa v2 để sở hữu mã nguồn; nghiên cứu ở `docs/research/2026-10-24-stack.md`. Cửa hàng thời trang Việt Nam, một đơn vị bán, quy mô M, đội nhỏ; cần đơn chờ, giữ hàng, COD + VNPAY, GHN, đổi trả, đối soát. Logic tiền/tồn phải đúng và kiểm thử được độc lập với framework.

## Phương án đã cân nhắc

1. Shopify headless — loại: checkout chuyển sang Shopify, khó đáp ứng đơn chờ + giữ hàng tùy biến, đối tác VN phụ thuộc app.
2. Tự viết commerce từ đầu — loại ở P0: tăng phần tiền/tồn/admin phải tự làm.
3. Medusa v2 + Next.js (chọn) — đúng đặc tả, sở hữu mã; rủi ro RK-001 kiểm bằng spike Lát 3.

## Quyết định

Chọn phương án 3.

| Thành phần | Lựa chọn | Phiên bản (nguồn: ADR-0001, 2026-10-24) | Manifest 2026-10-28 |
|---|---|---|---|
| Runtime | Node.js LTS | 22.22.x (`.nvmrc`) | `.nvmrc` 22.22.0; `engines` >=22.22.0 <23 |
| Monorepo | pnpm workspace (theo dtc-starter chính thức) | pnpm 10.x | `packageManager` pnpm@10.28.0 |
| Commerce | Medusa v2 (server + worker + Admin) | 2.22.x (ghim lockfile) | `@medusajs/medusa` 2.22.1 |
| Storefront | Next.js App Router + React + TypeScript | 16.x | `next` 16.4.3 |
| DB / cache / lock | PostgreSQL 16 · Redis 7 (Locking Module Redis provider, event bus, workflow engine) | | ảnh CI postgres:16, redis:7 |
| Lõi nghiệp vụ | `packages/domain`: TS thuần, không I/O — tiền, phân bổ, lọc, trạng thái, protocol VNPAY/GHN | | |
| Test | Vitest + fast-check (đơn vị/thuộc tính), medusa test utils (tích hợp DB thật), Playwright + axe (E2E) | vitest 5.x, playwright 1.64.x | vitest ^5.0.5, fast-check ^4.10.2, `@playwright/test` 1.63.0 |

Lệch đã ghi nhận: ADR-0001 ghi playwright 1.64.x nhưng manifest ghim 1.63.0; manifest là nguồn đúng cho phiên bản đang chạy.

## Hệ quả

- RBAC native của Medusa là Enterprise → tự xây module RBAC (SPEC-admin). MFA dùng TOTP native của Auth Module.
- Webhook payment native tự hoàn tất giỏ → IPN VNPAY qua route riêng (SPEC-payment S-101, AT35).
- Logic tiền/tồn không nằm trong adapter; adapter chỉ chuyển protocol.
- Đường lùi: giữ `packages/domain` + module checkout riêng, thay lõi commerce bằng service tự viết (ADR mới).
- ADR-0001 chuyển sang Superseded by ADR-0004; kiểu kiến trúc ở ADR-0002 bổ sung chứ không thay ADR này.

## Điều kiện đọc lại

- Spike RK-001 (Lát 3: Medusa không đáp ứng đơn chờ/giữ hàng) đỏ → thay lõi commerce bằng ADR mới.
- Medusa hoặc Next.js nâng bản chính (đổi API workflow, cache/rendering mặc định).
- Node 22 hết hỗ trợ LTS (xem `scripts/eol-check.mjs`) hoặc Postgres 16/Redis 7 hết hỗ trợ.
- Cần RBAC/tính năng Enterprise của Medusa mà tự xây không còn rẻ hơn.
