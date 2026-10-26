# Đóng góp

Cảm ơn bạn đã quan tâm. Luật làm việc đầy đủ ở [`AGENTS.md`](AGENTS.md); phần dưới là tóm tắt cho người đóng góp.

## Chuẩn bị

Làm theo [README](README.md): ba lệnh `corepack enable`, `pnpm install --frozen-lockfile`, `pnpm test`. Biến môi trường:
[`docs/ops/ENV.md`](docs/ops/ENV.md). Không commit bí mật thật.

## Quy trình

1. Mở issue (mẫu bug/feature/task) hoặc nhận một issue có sẵn; tránh trùng việc.
2. Tạo nhánh từ `master`; mỗi lát thay đổi nhỏ là một PR.
3. Commit theo [Conventional Commits](https://www.conventionalcommits.org/vi/v1.0.0/): `<type>(scope): mô tả`.
4. Trước khi mở PR chạy `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` (hoặc cổng đầy đủ
   `.xtemplates/scripts/dev-task.sh gate`).
5. Mọi thay đổi hành vi có test, gồm ca biên (rỗng, 0, lỗi I/O, Unicode, thời gian); sửa lỗi có test đỏ trước, xanh sau.
6. Điền mẫu PR; không nới ngưỡng lint/coverage, không skip test, không sửa migration đã áp.
7. Ghi thay đổi người dùng thấy được vào mục `Unreleased` của [CHANGELOG](CHANGELOG.md).

## Quy ước

- Tiền là số nguyên VND; logic tiền/tồn/trạng thái chỉ ở `packages/domain` và workflow backend.
- Dùng tiếng Việt có dấu cho tài liệu và giao diện.

## Giấy phép đóng góp

Dự án chưa chọn giấy phép (chờ chủ dự án quyết). Khi mở PR, bạn đồng ý để chủ dự án cấp phép phần đóng góp theo giấy phép
sẽ được chọn.

Quy tắc ứng xử: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Lỗ hổng bảo mật: [SECURITY.md](SECURITY.md).
