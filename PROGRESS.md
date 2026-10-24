# PROGRESS.md — x-shop (webapp shop thời trang)

## Đang làm
- `T-009` Module `checkout` (checkout_attempt, payment_attempt, ledger, inbox, outbox) — trạng thái: chuẩn bị giao executor-deep — chỗ dừng: thiết kế ở `docs/design/checkout-flow.md`

## Tiếp theo
1. `T-010` Quote + submit workflow, giữ hàng dưới khóa (Gate: `pnpm --filter @x-shop/backend test:integration -- checkout-submit`)
2. `T-011` IPN VNPAY không tự hoàn tất giỏ (AT35) · `T-012` expiry/đối chiếu/bù trừ
3. Lát 4 catalog read model (`T-013`…`T-015`) có thể chạy song song với Lát 3 (khác file)
4. Cổng sắp tới: G5 (Lát 3 là cổng dừng RK-001 — đỏ thì ADR đổi hướng trước khi làm UI giao dịch)

## Quyết định
- 2026-10-24 D-001…D-007 ở `docs/autopilot/DECISIONS.md`; stack ở `docs/adr/0001-stack.md` (pnpm, Medusa 2.22.1, Next 16.4.3, React 19.3.1, Postgres 16, Redis 7).
- RBAC native Medusa là Enterprise → tự xây (`packages/domain/src/access`); MFA dùng TOTP native.
- `.env*` bị chặn ghi trong môi trường agent → biến môi trường ở `docs/ops/ENV.md` + schema zod.
- Nợ kỹ thuật chấp nhận: protocol VNPAY/GHN cài theo nguồn thứ cấp (tài liệu chính thức 503/403 ngày 2026-10-24) — hạn trả: khi chủ dự án có khoá sandbox.

## Bàn giao phiên
- Commit cuối trên nhánh chính: `4f5ca0c` (master, chưa merge PR nào của đợt này) · nhánh làm việc `claude/affectionate-ritchie-k35o2e`
- Lệnh kiểm nhanh: `bash .xtemplates/scripts/dev-task.sh gate` → exit 0 lúc 17:16 (domain 121 test, backend unit 22 + tích hợp 6, storefront 84)
- Đang chặn: không
- Việc dở chưa commit: không
- Câu hỏi cần người: khoá sandbox VNPAY (TMN code, hash secret) và token/shop_id GHN — chủ dự án; tạo `.env` cục bộ theo `docs/ops/ENV.md`
