#!/usr/bin/env bash
# Khởi động PostgreSQL 16 + Redis cục bộ cho dev/test (idempotent). Ưu tiên docker compose nếu có daemon; không thì
# dùng bản cài sẵn trên máy (sandbox). In ra DATABASE_URL/REDIS_URL dùng được.
set -euo pipefail
PGUSER_="${XS_PG_USER:-xshop}"; PGPASS_="${XS_PG_PASSWORD:-xshop}"; PGDB_="${XS_PG_DB:-xshop}"
if command -v pg_ctlcluster >/dev/null 2>&1; then
  pg_lsclusters -h | awk '{print $1, $2, $4}' | while read -r ver name status; do
    [ "$status" = "online" ] || pg_ctlcluster "$ver" "$name" start
  done
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$PGUSER_'\"" | grep -q 1 \
    || su postgres -c "psql -c \"CREATE ROLE $PGUSER_ LOGIN SUPERUSER PASSWORD '$PGPASS_'\""
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$PGDB_'\"" | grep -q 1 \
    || su postgres -c "createdb -O $PGUSER_ $PGDB_"
else
  echo "Không thấy PostgreSQL cục bộ — dùng: docker compose up -d (docker-compose.yml)" >&2
  exit 1
fi
if command -v redis-server >/dev/null 2>&1; then
  redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save "" --appendonly no >/dev/null
fi
echo "DATABASE_URL=postgres://$PGUSER_:$PGPASS_@localhost:5432/$PGDB_"
echo "REDIS_URL=redis://localhost:6379"
