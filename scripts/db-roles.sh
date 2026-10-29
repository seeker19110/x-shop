#!/usr/bin/env bash
# Tạo/cập nhật vai trò DB tách quyền xshop_app (chỉ DML) + xshop_migrator (owner/DDL) — T-184, Q-02, DB-SEC-002.
# Lũy đẳng (scripts/db-roles.sql). Gọi từ scripts/dev-services.sh (máy dev) và bước "Vai trò DB" của ci.yml.
#
#   XS_PG_ADMIN_URL=postgres://<superuser>:…@host:5432/<db> bash scripts/db-roles.sh   # CI / Postgres có URL quản trị
#   bash scripts/db-roles.sh                                                          # máy dev: `su postgres` + psql
#
# Biến: XS_PG_DB (DB cấp quyền khi không có XS_PG_ADMIN_URL, mặc định xshop) · XS_PG_USER (vai trò đang tạo bảng —
# default privileges, mặc định xshop) · XS_PG_APP_PASSWORD / XS_PG_MIGRATOR_PASSWORD (mặc định: giá trị GIẢ chứa SENTINEL,
# chỉ cho Postgres cục bộ/CI — production đặt mật khẩu thật qua kho bí mật, không qua script này).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_PW="${XS_PG_APP_PASSWORD:-xshop-app-dev-SENTINEL}"
MIGRATOR_PW="${XS_PG_MIGRATOR_PASSWORD:-xshop-migrator-dev-SENTINEL}"
OWNER="${XS_PG_USER:-xshop}"
DB="${XS_PG_DB:-xshop}"
vars=(-X -q -v ON_ERROR_STOP=1 -v "app_password=$APP_PW" -v "migrator_password=$MIGRATOR_PW" -v "legacy_owner=$OWNER")
if [ -n "${XS_PG_ADMIN_URL:-}" ]; then
  psql "$XS_PG_ADMIN_URL" "${vars[@]}" -f - <"$here/db-roles.sql"
else
  # stdin thay vì -f <đường dẫn>: tài khoản postgres có thể không đọc được thư mục repo.
  su postgres -c "psql -d $(printf '%q' "$DB") $(printf '%q ' "${vars[@]}") -f -" <"$here/db-roles.sql"
fi
echo "Vai trò DB: xshop_app (DML) + xshop_migrator (owner/DDL) đã sẵn sàng (scripts/db-roles.sql)." >&2
