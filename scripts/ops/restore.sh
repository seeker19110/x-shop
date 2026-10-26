#!/usr/bin/env bash
# Khôi phục bản sao lưu của backup.sh vào một database MỚI (không bao giờ ghi đè database đang có).
#
# Dùng:  DATABASE_URL=postgres://…/<db bất kỳ trên server đích> scripts/ops/restore.sh <file.dump[.gpg]> <db_mới>
#   - Kiểm sha256 với <file>.meta (nếu có) trước khi khôi phục.
#   - .gpg: giải mã bằng keyring của người chạy (khoá công khai) hoặc XS_BACKUP_PASSPHRASE_FILE (đối xứng) ra file tạm
#     quyền 600, xoá khi thoát.
#   - pg_restore --exit-on-error -j ${XS_RESTORE_JOBS:-4}; lỗi giữa chừng → xoá database mới (chỉ database script
#     vừa tạo) để chạy lại được.
# Sau bước này: chạy migration tới phiên bản ứng dụng rồi ĐỐI CHIẾU giao dịch sau mốc (post-restore-reconcile.sh) —
# docs/ops/RUNBOOK.md §4.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/lib.sh
source "$here/lib.sh"

[[ $# -eq 2 ]] || xs_die "dùng: restore.sh <file.dump[.gpg]> <db_mới>"
backup="$1"
target="$2"
xs_assert_db_name "$target"
db_url="${DATABASE_URL:-postgres://xshop:xshop@localhost:5432/xshop}"
maint_url="$(xs_url_with_db "$db_url" postgres)"
target_url="$(xs_url_with_db "$db_url" "$target")"
for t in pg_restore psql sha256sum; do command -v "$t" >/dev/null || xs_die "thiếu công cụ: $t"; done
[[ -r "$backup" ]] || xs_die "không đọc được file sao lưu: $backup"

if [[ -r "$backup.meta" ]]; then
  want="$(sed -n 's/^sha256=//p' "$backup.meta")"
  got="$(sha256sum "$backup" | cut -d' ' -f1)"
  [[ "$want" == "$got" ]] || xs_die "sha256 không khớp .meta — file sao lưu hỏng hoặc bị sửa"
  xs_log "sha256 khớp .meta (mốc $(sed -n 's/^snapshot_mark_utc=//p' "$backup.meta"))"
else
  xs_log "CẢNH BÁO: không có $backup.meta — bỏ qua kiểm sha256, không biết mốc đối chiếu"
fi

xs_db_exists "$maint_url" "$target" && xs_die "database '$target' đã tồn tại — không ghi đè; chọn tên mới"

umask 077
work="$(mktemp -d)"
created=0
ok=0
cleanup() {
  if [[ "$created" == 1 && "$ok" == 0 ]]; then
    xs_log "khôi phục lỗi — xoá database dở '$target' (do script này tạo)"
    xs_psql -d "$maint_url" -c "DROP DATABASE IF EXISTS \"$target\" WITH (FORCE)" >/dev/null 2>&1 || true
  fi
  gpgconf --homedir "$work/gnupg" --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

src="$backup"
if [[ "$backup" == *.gpg ]]; then
  command -v gpg >/dev/null || xs_die "thiếu gpg để giải mã"
  src="$work/backup.dump"
  if [[ -n "${XS_BACKUP_PASSPHRASE_FILE:-}" ]]; then
    mkdir -m 700 "$work/gnupg"
    gpg --homedir "$work/gnupg" --batch --yes --pinentry-mode loopback \
      --passphrase-file "$XS_BACKUP_PASSPHRASE_FILE" --decrypt -o "$src" "$backup" 2>/dev/null ||
      xs_die "giải mã thất bại (sai passphrase hoặc file hỏng)"
  else
    gpg --batch --yes --decrypt -o "$src" "$backup" || xs_die "giải mã thất bại (thiếu khoá riêng?)"
  fi
fi

xs_log "tạo database '$target' và khôi phục"
xs_psql -d "$maint_url" -c "CREATE DATABASE \"$target\"" >/dev/null
created=1
pg_restore --no-owner --no-acl --exit-on-error -j "${XS_RESTORE_JOBS:-4}" -d "$target_url" "$src"
ok=1
xs_log "khôi phục xong vào $(xs_url_redact "$target_url")"
