# shellcheck shell=bash
# Hàm dùng chung cho scripts/ops/*.sh (source, không chạy trực tiếp). Không in DATABASE_URL/REDIS_URL đầy đủ — URL có
# thể chứa mật khẩu; chỉ in host/tên DB qua `xs_url_redact`.

xs_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
xs_die() {
  xs_log "LỖI: $*"
  exit 1
}

# Thay tên database trong URL Postgres, giữ query string: xs_url_with_db <url> <dbname>
xs_url_with_db() {
  local url="$1" db="$2" base query=""
  base="${url%%\?*}"
  [[ "$url" == *\?* ]] && query="?${url#*\?}"
  printf '%s/%s%s' "${base%/*}" "$db" "$query"
}

# Tên database trong URL Postgres.
xs_url_db() {
  local base="${1%%\?*}"
  printf '%s' "${base##*/}"
}

# URL không mật khẩu để in log: scheme://user@host:port/db
xs_url_redact() {
  printf '%s' "$1" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#; s#\?.*$##'
}

# Tên database an toàn để trích dẫn trong SQL (chỉ chữ thường, số, gạch dưới) — chặn tiêm SQL qua tên.
xs_assert_db_name() {
  [[ "$1" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || xs_die "tên database không hợp lệ: '$1' (chỉ [a-z0-9_], ≤ 63 ký tự)"
}

# psql không đọc ~/.psqlrc, dừng ở lỗi đầu tiên, xuất không căn lề.
xs_psql() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

xs_db_exists() { # xs_db_exists <maintenance_url> <dbname>
  [[ "$(xs_psql -At -d "$1" -c "SELECT 1 FROM pg_database WHERE datname = '$2'")" == "1" ]]
}

# Số dòng + md5 nội dung của MỌI bảng thường trong schema public (thứ tự dòng theo text của dòng → tất định trên
# cùng server/collation). Mỗi dòng: <bảng>\t<số dòng>\t<md5>.
xs_table_checksums() {
  xs_psql -At -F $'\t' -d "$1" <<'SQL'
SELECT format(
  'SELECT %L, count(*), md5(coalesce(string_agg(t::text, chr(10) ORDER BY t::text), %L)) FROM %I.%I t',
  table_name, '', table_schema, table_name)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name
\gexec
SQL
}

# Dấu vân tay các bảng ghi migration của Medusa (module, link, migration script) — đổi = đã có migration chạy thêm.
xs_migration_fingerprint() {
  xs_psql -At -F $'\t' -d "$1" <<'SQL'
SELECT 'mikro_orm_migrations', count(*), md5(coalesce(string_agg(name, ',' ORDER BY name), '')) FROM mikro_orm_migrations
UNION ALL
SELECT 'link_module_migrations', count(*), md5(coalesce(string_agg(table_name, ',' ORDER BY table_name), ''))
  FROM link_module_migrations
UNION ALL
SELECT 'script_migrations', count(*), md5(coalesce(string_agg(script_name, ',' ORDER BY script_name), ''))
  FROM script_migrations;
SQL
}
