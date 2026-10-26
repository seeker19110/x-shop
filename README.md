# x-shop

Webapp shop thời trang Việt Nam cho khách mua trên điện thoại: mua không cần tài khoản, thanh toán COD hoặc VNPAY, giao
hàng qua GHN, có đổi trả và đối soát cho chủ shop. Đặc tả gốc: [`docs/specs/DAC-TA-GOC.md`](docs/specs/DAC-TA-GOC.md).

## Bắt đầu nhanh (từ clone sạch đến test xanh, 3 lệnh)

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
```

Không bước tay nào khác: `pnpm test` chạy test đơn vị, không cần Postgres/Redis hay khoá bí mật. Các lệnh trên trích từ
`setup` và `test` của [`xt.yaml`](xt.yaml); CI chạy lại đúng chúng (job `readme-smoke`).

## Yêu cầu môi trường

- Node.js `22.22.0` (ghim ở `.nvmrc`; `engines`: `>=22.22.0 <23`).
- pnpm `10.28.0` (khai ở `packageManager`; `corepack enable` tự lấy đúng bản).
- Chạy backend và test tích hợp: PostgreSQL 16 và Redis 7 (`bash scripts/dev-services.sh` dựng bản cục bộ).

## Cài và chạy

```bash
bash scripts/dev-services.sh          # Postgres + Redis cục bộ, in ra DATABASE_URL / REDIS_URL
pnpm --filter @x-shop/backend dev     # Medusa backend + admin
pnpm --filter @x-shop/storefront dev  # Next.js storefront
```

Cấu trúc: `packages/domain` (lõi thuần TypeScript) · `apps/backend` (Medusa v2) · `apps/storefront` (Next.js) · `docs/`.

## Chạy test và kiểm tra

```bash
pnpm test                # test đơn vị
pnpm test:integration    # test tích hợp (cần Postgres/Redis)
pnpm lint
pnpm typecheck
pnpm format:check
```

## Cấu hình

Biến môi trường và giá trị mẫu (đều là giá trị giả) nằm ở [`docs/ops/ENV.md`](docs/ops/ENV.md); tạo `.env` cục bộ từ đó.
Không commit bí mật thật.

## Đóng góp và liên hệ

Luật làm việc và commit/PR: [`AGENTS.md`](AGENTS.md). Tài liệu: [`PROJECT.md`](PROJECT.md), [`docs/adr/`](docs/adr/),
[`docs/ops/RUNBOOK.md`](docs/ops/RUNBOOK.md). Liên hệ: lienhe@donghanhcungban.org.

## Giấy phép

Chưa chọn giấy phép (chờ chủ dự án quyết); cho đến lúc đó mọi quyền được bảo lưu.
