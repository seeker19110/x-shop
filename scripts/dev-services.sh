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
  # T-184 (Q-02, DB-SEC-002): vai trò tách quyền xshop_app (chỉ DML) + xshop_migrator (owner/DDL), lũy đẳng. Vai trò
  # $PGUSER_ (superuser) GIỮ NGUYÊN và vẫn là DATABASE_URL mặc định in ra dưới đây: test tích hợp/script tạo DB tạm cần
  # quyền tạo DB, và DB dev cũ do $PGUSER_ sở hữu (migrator không ALTER được bảng của nó). Chạy ứng dụng bằng xshop_app:
  # docs/ops/ENV.md mục "Vai trò DB".
  XS_PG_USER="$PGUSER_" XS_PG_DB="$PGDB_" bash "$(dirname "${BASH_SOURCE[0]}")/db-roles.sh"
else
  echo "Không thấy PostgreSQL cục bộ — dùng: docker compose up -d (docker-compose.yml)" >&2
  exit 1
fi
if command -v redis-server >/dev/null 2>&1; then
  redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save "" --appendonly no >/dev/null
fi
echo "DATABASE_URL=postgres://$PGUSER_:$PGPASS_@localhost:5432/$PGDB_"
echo "REDIS_URL=redis://localhost:6379"
# Kho file (T-154): script KHÔNG dựng kho S3. Dev/test mặc định FILE_STORAGE=local — đĩa máy này, chỉ đúng cho một tiến trình
# (provider in cảnh báo lúc khởi động). MinIO bản cộng đồng đã ngừng bảo trì (không còn binary); muốn thử kho dùng chung thì
# dựng kho S3-compatible tự host (RUNBOOK §8.2b) rồi đặt FILE_STORAGE=s3 + S3_* (docs/ops/ENV.md). Ghi ra stderr để stdout chỉ
# còn các dòng KEY=VALUE.
echo "Kho file: FILE_STORAGE=local (mặc định dev, một tiến trình). Kho dùng chung: docs/ops/ENV.md (FILE_STORAGE=s3)." >&2
