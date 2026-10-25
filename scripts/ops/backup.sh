#!/usr/bin/env bash
# Sao lưu logic PostgreSQL: pg_dump định dạng custom (-Fc, nén, pg_restore chọn lọc/song song được) + file .meta ghi
# MỐC đối chiếu (giờ DB, UTC) lấy NGAY TRƯỚC khi pg_dump chụp snapshot → mọi giao dịch sau mốc là tập cha của phần mất
# khi khôi phục bản này (đối chiếu dư an toàn hơn thiếu; querydr/tra vận đơn là idempotent).
#
# Đây là bản sao lưu bổ sung/diễn tập. RPO ≤ 15 phút ở production cần PITR (WAL archiving) do hạ tầng cung cấp —
# xem docs/ops/RUNBOOK.md §4.
#
# Dùng:  DATABASE_URL=postgres://… scripts/ops/backup.sh <đường-dẫn-ra.dump>
# Mã hoá tuỳ chọn (gpg; không đặt bí mật vào biến môi trường hay dòng lệnh):
#   XS_BACKUP_GPG_RECIPIENT=<key id>     mã hoá khoá công khai (khoá riêng giữ ngoài máy chủ sao lưu) → <ra>.gpg
#   XS_BACKUP_PASSPHRASE_FILE=<file>     mã hoá đối xứng AES256, passphrase đọc từ file (quyền 600)   → <ra>.gpg
# In ra stdout DUY NHẤT đường dẫn file sao lưu cuối cùng. Không in URL/mật khẩu.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/lib.sh
source "$here/lib.sh"

[[ $# -eq 1 ]] || xs_die "dùng: backup.sh <đường-dẫn-ra.dump>"
out="$1"
db_url="${DATABASE_URL:-postgres://xshop:xshop@localhost:5432/xshop}"
for t in pg_dump psql sha256sum; do command -v "$t" >/dev/null || xs_die "thiếu công cụ: $t"; done

encrypt=""
if [[ -n "${XS_BACKUP_GPG_RECIPIENT:-}" && -n "${XS_BACKUP_PASSPHRASE_FILE:-}" ]]; then
  xs_die "chỉ đặt MỘT trong XS_BACKUP_GPG_RECIPIENT / XS_BACKUP_PASSPHRASE_FILE"
elif [[ -n "${XS_BACKUP_GPG_RECIPIENT:-}" ]]; then
  encrypt="recipient"
elif [[ -n "${XS_BACKUP_PASSPHRASE_FILE:-}" ]]; then
  [[ -r "$XS_BACKUP_PASSPHRASE_FILE" ]] || xs_die "không đọc được XS_BACKUP_PASSPHRASE_FILE"
  encrypt="passphrase"
fi
if [[ -n "$encrypt" ]]; then
  command -v gpg >/dev/null || xs_die "thiếu gpg cho mã hoá"
  out="$out.gpg"
fi
[[ -e "$out" ]] && xs_die "file đích đã tồn tại, không ghi đè: $out"
mkdir -p "$(dirname "$out")"
umask 077

mark="$(xs_psql -At -d "$db_url" -c "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")"
server_version="$(xs_psql -At -d "$db_url" -c 'SHOW server_version')"
xs_log "sao lưu $(xs_url_redact "$db_url") — mốc $mark${encrypt:+ (mã hoá: $encrypt)}"

tmp_out="$out.partial"
gnupg_home=""
cleanup() {
  rm -f "$tmp_out"
  if [[ -n "$gnupg_home" ]]; then
    gpgconf --homedir "$gnupg_home" --kill gpg-agent >/dev/null 2>&1 || true
    rm -rf "$gnupg_home"
  fi
}
trap cleanup EXIT

start_s=$(date +%s)
case "$encrypt" in
  "")
    pg_dump -Fc --no-owner --no-acl -d "$db_url" -f "$tmp_out"
    ;;
  recipient)
    pg_dump -Fc --no-owner --no-acl -d "$db_url" |
      gpg --batch --yes --trust-model always --encrypt --recipient "$XS_BACKUP_GPG_RECIPIENT" -o "$tmp_out"
    ;;
  passphrase)
    # Keyring tạm: mã hoá đối xứng không cần khoá, không đụng ~/.gnupg của người chạy.
    gnupg_home="$(mktemp -d)"
    pg_dump -Fc --no-owner --no-acl -d "$db_url" |
      gpg --homedir "$gnupg_home" --quiet --batch --yes --pinentry-mode loopback \
        --passphrase-file "$XS_BACKUP_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$tmp_out"
    ;;
esac
mv "$tmp_out" "$out"
elapsed=$(($(date +%s) - start_s))

{
  echo "snapshot_mark_utc=$mark"
  echo "database=$(xs_url_db "$db_url")"
  echo "format=pg_dump-custom"
  echo "encryption=${encrypt:-none}"
  echo "sha256=$(sha256sum "$out" | cut -d' ' -f1)"
  echo "size_bytes=$(stat -c %s "$out")"
  echo "pg_dump_version=$(pg_dump --version | awk '{print $3}')"
  echo "server_version=$server_version"
  echo "duration_seconds=$elapsed"
} >"$out.meta"
xs_log "xong: $(stat -c %s "$out") byte trong ${elapsed}s → $out (+ .meta)"
printf '%s\n' "$out"
