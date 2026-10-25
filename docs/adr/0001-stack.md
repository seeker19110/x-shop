# ADR-0001 — Stack: pnpm monorepo, Medusa v2 + Next.js, lõi domain thuần TS

- Trạng thái: Accepted (D-005, 2026-10-24)
- Bối cảnh: đặc tả gốc §7 chọn Next.js + Medusa v2 để sở hữu mã nguồn; nghiên cứu `docs/research/2026-10-24-stack.md`.

## Quyết định
| Thành phần | Lựa chọn | Phiên bản (2026-10-24) |
|---|---|---|
| Runtime | Node.js LTS | 22.22.x (`.nvmrc`) |
| Monorepo | pnpm workspace (theo dtc-starter chính thức) | pnpm 10.x |
| Commerce | Medusa v2 (server + worker + Admin) | 2.22.x (ghim lockfile) |
| Storefront | Next.js App Router + React + TypeScript | 16.x |
| DB / cache / lock | PostgreSQL 16 · Redis 7 (Locking Module Redis provider, event bus, workflow engine) | |
| Lõi nghiệp vụ | `packages/domain`: TS thuần, không I/O — tiền, phân bổ, lọc, trạng thái, protocol VNPAY/GHN | |
| Test | Vitest + fast-check (unit/thuộc tính), medusa test utils (tích hợp DB thật), Playwright + axe (E2E) | vitest 5.x, playwright 1.64.x |

## Hệ quả
- RBAC native của Medusa là Enterprise → tự xây module RBAC (SPEC-admin). MFA dùng TOTP native của Auth Module.
- Webhook payment native tự hoàn tất giỏ → IPN VNPAY qua route riêng (SPEC-payment S-101, AT35).
- Logic tiền/tồn không nằm trong adapter; adapter chỉ chuyển protocol.

## Phương án đã cân nhắc
1. Shopify headless — checkout chuyển sang Shopify, khó đáp ứng đơn chờ + giữ hàng tùy biến, đối tác VN phụ thuộc app; loại.
2. Tự viết commerce từ đầu — tăng phần tiền/tồn/admin phải tự làm; loại ở P0.
3. Medusa + Next.js (chọn) — đúng đặc tả; rủi ro RK-001 kiểm bằng spike Lát 3, đường lùi: giữ `packages/domain` + module checkout riêng, thay lõi commerce bằng service tự viết (ADR mới).
