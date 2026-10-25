#!/usr/bin/env bash
# Diễn tập khôi phục (T-037, AT28, đặc tả §13.2): backup → restore → toàn vẹn → RTO → đối chiếu giao dịch sau mốc →
# mất Redis → tạo lại công việc từ bản ghi bền vững. Chạy được ở máy dev và CI có Postgres + Redis; idempotent (tên DB
# theo PID, dọn sạch khi thoát kể cả khi lỗi).
#
#   bash scripts/ops/restore-drill.sh
#
# Biến môi trường (đều có mặc định):
#   DATABASE_URL                  server Postgres (role cần CREATEDB)          postgres://xshop:xshop@localhost:5432/xshop
#   REDIS_URL                     server Redis                                  redis://localhost:6379
#   XS_DRILL_REDIS_DB             DB index RIÊNG của diễn tập (1..15, phải rỗng) 15
#   XS_RTO_MAX_SECONDS            ngưỡng RTO (đặc tả: ≤ 2 giờ)                   7200
#   XS_RECONCILE_MARGIN_SECONDS   biên an toàn trước mốc khi lấy cửa sổ provider 300
# Chỉ tạo/xoá database tên `xs_drill_src_<pid>` / `xs_drill_dst_<pid>` và khoá trong DB index diễn tập — không đụng
# database hay Redis DB index khác. Quy trình thật + giới hạn: docs/ops/RUNBOOK.md §3, §4.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
# shellcheck source=scripts/ops/lib.sh
source "$here/lib.sh"

db_url="${DATABASE_URL:-postgres://xshop:xshop@localhost:5432/xshop}"
redis_db="${XS_DRILL_REDIS_DB:-15}"
rto_max="${XS_RTO_MAX_SECONDS:-7200}"
margin="${XS_RECONCILE_MARGIN_SECONDS:-300}"
backend="$root/apps/backend"
medusa="$backend/node_modules/.bin/medusa"
maint_url="$(xs_url_with_db "$db_url" postgres)"
src_db="xs_drill_src_$$"
dst_db="xs_drill_dst_$$"
src_url="$(xs_url_with_db "$db_url" "$src_db")"
dst_url="$(xs_url_with_db "$db_url" "$dst_db")"
redis_drill() { node "$here/redis-drill.mjs" "$@"; }
# In bảng TSV thụt lề (không phụ thuộc `column` — máy CI có thể thiếu).
show_tsv() { awk -F'\t' '{ printf "    %-22s %-46s %s\n", $1, $2, $3 }'; }

STEPS=(1 2 3 4 5 6 7)
declare -A TITLE=(
  [1]="DB nguồn: migration Medusa + dữ liệu nghiệp vụ mẫu (giao dịch dở)"
  [2]="Sao lưu pg_dump -Fc (mã hoá gpg) + mốc; ghi giao dịch sau mốc"
  [3]="Khôi phục vào DB mới: toàn vẹn số dòng/checksum, migration không pending, RTO"
  [4]="Đối chiếu giao dịch dở: danh sách querydr/tra vận đơn đúng bản ghi sau mốc"
  [5]="Mất Redis: tạo lại công việc từ bản ghi bền vững, đồng thời, dedupe tác động ngoài"
  [6]="RPO ≤ 15 phút: PITR production"
  [7]="Dọn dẹp DB/Redis diễn tập"
)
declare -A STATUS=()
declare -A DETAIL=()
record() { STATUS[$1]="$2"; DETAIL[$1]="$3"; xs_log "bước $1: $2 — $3"; }
fail_count() {
  local n=0 s
  for s in "${STEPS[@]}"; do [[ "${STATUS[$s]:-}" == FAIL ]] && n=$((n + 1)); done
  echo "$n"
}

work="$(mktemp -d "${TMPDIR:-/tmp}/xs-restore-drill.XXXXXX")"
own_redis=0
created_dbs=()

cleanup() {
  local rc=$? db leftover ok=1
  set +e
  for db in "${created_dbs[@]}"; do
    xs_psql -d "$maint_url" -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1
    xs_db_exists "$maint_url" "$db" && ok=0
  done
  if [[ "$own_redis" == 1 ]]; then
    redis_drill wipe "$redis_db" >/dev/null 2>&1
    leftover="$(redis_drill dbsize "$redis_db" 2>/dev/null)"
    [[ "$leftover" == 0 ]] || ok=0
  fi
  rm -rf "$work"
  if [[ "$ok" == 1 ]]; then
    local redis_note=""
    [[ "$own_redis" == 1 ]] && redis_note=", DB index Redis $redis_db rỗng"
    record 7 PASS "đã xoá ${#created_dbs[@]} database diễn tập$redis_note"
  else
    record 7 FAIL "còn sót database/khoá diễn tập — kiểm: psql -l | grep xs_drill_; redis-cli -n $redis_db dbsize"
  fi
  echo
  echo "================ TÓM TẮT DIỄN TẬP KHÔI PHỤC (T-037 / AT28) ================"
  local s
  for s in "${STEPS[@]}"; do
    printf '%-11s %s. %s\n' "${STATUS[$s]:-KHÔNG CHẠY}" "$s" "${TITLE[$s]}"
    [[ -n "${DETAIL[$s]:-}" ]] && printf '            %s\n' "${DETAIL[$s]}"
  done
  local fails
  fails="$(fail_count)"
  if [[ "$rc" != 0 || "$fails" != 0 ]]; then
    [[ "$rc" == 0 ]] && rc=1
    echo "KẾT QUẢ: FAIL ($fails bước FAIL; mã thoát $rc — lỗi trước khi xong mọi bước nếu có bước KHÔNG CHẠY)"
  else
    echo "KẾT QUẢ: PASS (bước 6 chờ chủ dự án chọn hạ tầng PITR — không phải lỗi của diễn tập)"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

run_medusa() { # run_medusa <log> <database_url> <args…> — chạy Medusa CLI trong apps/backend với DB/Redis diễn tập
  local log="$1" url="$2"
  shift 2
  if ! (cd "$backend" && DATABASE_URL="$url" REDIS_URL="$drill_redis_url" "$medusa" "$@") >"$log" 2>&1; then
    tail -n 40 "$log" >&2
    return 1
  fi
}

# ------------------------------------------------------------------------------------------------ kiểm tra trước
for t in psql pg_dump pg_restore node pnpm sha256sum; do command -v "$t" >/dev/null || xs_die "thiếu công cụ: $t"; done
[[ -x "$medusa" ]] || xs_die "chưa cài phụ thuộc (thiếu $medusa) — chạy: pnpm install --frozen-lockfile"
[[ "$rto_max" =~ ^[0-9]+$ && "$margin" =~ ^[0-9]+$ ]] || xs_die "XS_RTO_MAX_SECONDS/XS_RECONCILE_MARGIN_SECONDS phải là số nguyên"
xs_psql -At -d "$maint_url" -c 'SELECT 1' >/dev/null || xs_die "không kết nối được Postgres $(xs_url_redact "$maint_url")"
server_major="$(xs_psql -At -d "$maint_url" -c 'SHOW server_version_num')"
server_major=$((server_major / 10000))
dump_major="$(pg_dump --version | awk '{print $3}' | cut -d. -f1)"
((dump_major >= server_major)) || xs_die "pg_dump $dump_major cũ hơn server $server_major"
drill_redis_url="$(redis_drill url "$redis_db")"
redis_keys="$(redis_drill dbsize "$redis_db")" || xs_die "không kết nối được Redis"
[[ "$redis_keys" == 0 ]] ||
  xs_die "Redis DB index $redis_db đang có $redis_keys khoá — diễn tập chỉ chạy trên DB index RỖNG của riêng nó (đặt XS_DRILL_REDIS_DB khác)"
own_redis=1
stale="$(xs_psql -At -d "$maint_url" -c "SELECT string_agg(datname, ' ') FROM pg_database WHERE datname LIKE 'xs\_drill\_%'")"
[[ -z "$stale" ]] || xs_log "lưu ý: còn database diễn tập của lần chạy khác (không đụng tới): $stale"
gpg_ok=0
command -v gpg >/dev/null && gpg_ok=1
xs_log "dựng @x-shop/domain (Medusa nạp bản dist)"
pnpm --filter @x-shop/domain build >"$work/domain-build.log" 2>&1 || {
  tail -n 40 "$work/domain-build.log" >&2
  xs_die "build @x-shop/domain lỗi"
}

# ------------------------------------------------------------------------------------------------ 1. DB nguồn
xs_psql -d "$maint_url" -c "CREATE DATABASE \"$src_db\"" >/dev/null
created_dbs+=("$src_db")
xs_log "migration Medusa vào $src_db"
run_medusa "$work/migrate-src.log" "$src_url" db:migrate
xs_psql -d "$src_url" -f "$here/drill/seed-before.sql" >/dev/null
src_counts="$(xs_psql -At -d "$src_url" -c "SELECT
  (SELECT count(*) FROM checkout_attempt WHERE state = 'preparing') || ' attempt preparing, ' ||
  (SELECT count(*) FROM payment_attempt WHERE state IN ('pending', 'unknown')) || ' payment pending/unknown, ' ||
  (SELECT count(*) FROM outbox_event WHERE state = 'pending') || ' outbox pending, ' ||
  (SELECT count(*) FROM payment_ledger) || ' ledger'")"
record 1 PASS "$src_db: $(xs_migration_fingerprint "$src_url" | awk -F'\t' '{printf "%s%s=%s", sep, $1, $2; sep=" "}'); $src_counts"

# ------------------------------------------------------------------------------------------------ 2. sao lưu
backup_out="$work/backup/x-shop.dump"
if [[ "$gpg_ok" == 1 ]]; then
  head -c 48 /dev/urandom | base64 >"$work/passphrase"
  chmod 600 "$work/passphrase"
  backup_file="$(DATABASE_URL="$src_url" XS_BACKUP_PASSPHRASE_FILE="$work/passphrase" bash "$here/backup.sh" "$backup_out")"
else
  backup_file="$(DATABASE_URL="$src_url" bash "$here/backup.sh" "$backup_out")"
fi
mark="$(sed -n 's/^snapshot_mark_utc=//p' "$backup_file.meta")"
xs_table_checksums "$src_url" >"$work/checksums-snapshot.tsv"
xs_migration_fingerprint "$src_url" >"$work/migrations-src.tsv"
xs_psql -d "$src_url" -f "$here/drill/seed-after.sql" >/dev/null
enc="$(sed -n 's/^encryption=//p' "$backup_file.meta")"
detail2="mốc $mark; $(sed -n 's/^size_bytes=//p' "$backup_file.meta") byte; mã hoá: $enc; $(wc -l <"$work/checksums-snapshot.tsv") bảng được chụp checksum"
if [[ "$enc" == none ]]; then
  record 2 WARN "$detail2 (không có gpg — chưa kiểm đường mã hoá)"
else
  record 2 PASS "$detail2"
fi

# ------------------------------------------------------------------------------------------------ 3. khôi phục + RTO
t0=$(date +%s%3N)
created_dbs+=("$dst_db")
if [[ "$enc" == none ]]; then
  DATABASE_URL="$db_url" bash "$here/restore.sh" "$backup_file" "$dst_db"
else
  DATABASE_URL="$db_url" XS_BACKUP_PASSPHRASE_FILE="$work/passphrase" bash "$here/restore.sh" "$backup_file" "$dst_db"
fi
t_restored=$(date +%s%3N)
xs_table_checksums "$dst_url" >"$work/checksums-restored.tsv"
integrity_ok=1
if ! diff -u "$work/checksums-snapshot.tsv" "$work/checksums-restored.tsv" >"$work/checksums.diff"; then
  integrity_ok=0
  head -n 40 "$work/checksums.diff" >&2
fi
xs_migration_fingerprint "$dst_url" >"$work/migrations-dst-before.tsv"
run_medusa "$work/migrate-dst.log" "$dst_url" db:migrate
xs_migration_fingerprint "$dst_url" >"$work/migrations-dst-after.tsv"
t1=$(date +%s%3N)
rto_ms=$((t1 - t0))
rto_s=$(((rto_ms + 999) / 1000))
migr_ok=1
cmp -s "$work/migrations-src.tsv" "$work/migrations-dst-before.tsv" || migr_ok=0
cmp -s "$work/migrations-dst-before.tsv" "$work/migrations-dst-after.tsv" || migr_ok=0
echo "---- bảng nghiệp vụ lúc snapshot (bảng · số dòng · md5) — DB khôi phục trùng khớp: $([[ $integrity_ok == 1 ]] && echo có || echo KHÔNG)"
grep -E '^(checkout_attempt|order_finance|payment_attempt|payment_ledger|webhook_inbox|outbox_event|ops_exception|coupon_usage|shipment|outbound_message)\b' \
  "$work/checksums-restored.tsv" | show_tsv
detail3="RTO đo được ${rto_s}s (pg_restore $(((t_restored - t0) / 1000))s + kiểm toàn vẹn + migrate; ngưỡng ${rto_max}s); $(wc -l <"$work/checksums-restored.tsv") bảng"
if [[ "$integrity_ok" == 1 && "$migr_ok" == 1 && "$rto_s" -le "$rto_max" ]]; then
  record 3 PASS "$detail3 trùng số dòng + checksum; migration không pending"
else
  record 3 FAIL "$detail3; toàn vẹn=$integrity_ok migration=$migr_ok (0 = lệch)"
fi

# ------------------------------------------------------------------------------------------------ 4. đối chiếu
# "Xuất từ provider" mô phỏng = hoạt động trong DB nguồn (thế giới thật) từ (mốc − biên) — thứ cổng/hãng thấy được.
window_sql="'$mark'::timestamptz - interval '$margin seconds'"
xs_psql -At -d "$src_url" -c "SELECT txn_ref FROM payment_attempt WHERE greatest(created_at, updated_at) >= $window_sql ORDER BY 1" \
  >"$work/provider-payments.txt"
xs_psql -At -d "$src_url" -c "SELECT client_order_code FROM shipment WHERE greatest(created_at, updated_at) >= $window_sql ORDER BY 1" \
  >"$work/provider-shipments.txt"
DATABASE_URL="$dst_url" bash "$here/post-restore-reconcile.sh" --since "$mark" --margin-seconds "$margin" \
  --payment-refs "$work/provider-payments.txt" --courier-codes "$work/provider-shipments.txt" >"$work/reconcile.tsv"
echo "---- việc phải đối chiếu với provider (post-restore-reconcile.sh):"
show_tsv <"$work/reconcile.tsv"

# Kiểm 1 — đúng kỳ vọng thiết kế của dữ liệu mẫu (drill/seed-*.sql).
cat >"$work/reconcile.expected" <<'EOF'
COURIER	XS-DRILL-AFTER-S1	missing_in_db
COURIER	XS-DRILL-PAID-S1	open_in_db
QUERYDR	PA_DRILL_AFTER_1	missing_in_db
QUERYDR	PA_DRILL_AFTER_2	missing_in_db
QUERYDR	PA_DRILL_PENDING	provider_activity_after_mark
QUERYDR	PA_DRILL_UNKNOWN	open_in_db
EOF
# Kiểm 2 — độc lập với mốc thời gian: dòng payment_attempt/shipment của nguồn khác hoặc không có ở đích (thay đổi sau
# snapshot) ∪ việc còn mở trong đích. Danh sách đối chiếu phải bằng ĐÚNG tập này — không thiếu, không thừa.
row_md5() { xs_psql -At -F $'\t' -d "$1" -c "SELECT $2, md5(t::text) FROM $3 t" | LC_ALL=C sort; }
{
  comm -23 <(row_md5 "$src_url" txn_ref payment_attempt) <(row_md5 "$dst_url" txn_ref payment_attempt) |
    cut -f1 | sed 's/^/QUERYDR\t/'
  xs_psql -At -d "$dst_url" -c "SELECT txn_ref FROM payment_attempt WHERE state IN ('created','pending','unknown')" |
    sed 's/^/QUERYDR\t/'
  comm -23 <(row_md5 "$src_url" client_order_code shipment) <(row_md5 "$dst_url" client_order_code shipment) |
    cut -f1 | sed 's/^/COURIER\t/'
  xs_psql -At -d "$dst_url" -c "SELECT client_order_code FROM shipment WHERE provider_order_code IS NULL" |
    sed 's/^/COURIER\t/'
} | LC_ALL=C sort -u >"$work/reconcile.derived"
LC_ALL=C sort "$work/reconcile.tsv" >"$work/reconcile.sorted"
LC_ALL=C sort "$work/reconcile.expected" >"$work/reconcile.expected.sorted"
cut -f1,2 "$work/reconcile.sorted" | LC_ALL=C sort -u >"$work/reconcile.refs"
after_in_dst="$(xs_psql -At -d "$dst_url" -c "SELECT count(*) FROM payment_attempt WHERE txn_ref LIKE 'PA_DRILL_AFTER_%'")"
r4_ok=1
diff -u "$work/reconcile.expected.sorted" "$work/reconcile.sorted" >&2 || r4_ok=0
diff -u "$work/reconcile.derived" "$work/reconcile.refs" >&2 || r4_ok=0
[[ "$after_in_dst" == 0 ]] || r4_ok=0
n_q="$(grep -c '^QUERYDR' "$work/reconcile.tsv" || true)"
n_c="$(grep -c '^COURIER' "$work/reconcile.tsv" || true)"
n_m="$(grep -c 'missing_in_db' "$work/reconcile.tsv" || true)"
if [[ "$r4_ok" == 1 ]]; then
  record 4 PASS "$n_q txn_ref cần querydr, $n_c vận đơn cần tra ($n_m mục mất khỏi DB → xử lý thủ công); khớp kỳ vọng và khớp diff nguồn↔đích"
else
  record 4 FAIL "danh sách đối chiếu lệch kỳ vọng/diff nguồn↔đích (xem diff ở trên); bản ghi sau mốc trong đích: $after_in_dst"
fi

# ------------------------------------------------------------------------------------------------ 5. mất Redis
redo_sql="SELECT 'reconcile-attempts' AS job, id AS ref FROM checkout_attempt
  WHERE ((state = 'preparing' AND lease_until < now()) OR (state = 'compensated' AND error_code = 'COMPENSATING'))
    AND deleted_at IS NULL
  UNION ALL
  SELECT 'outbox-dispatch', event_key FROM outbox_event
  WHERE state IN ('pending', 'failed') AND next_attempt_at <= now() AND deleted_at IS NULL
  ORDER BY 1, 2"
keys_before="$(redis_drill seed "$redis_db" chk_drill_stale obx_drill_paid obx_drill_cod)"
redis_drill wipe "$redis_db" >/dev/null
keys_after="$(redis_drill dbsize "$redis_db")"
xs_psql -At -F $'\t' -d "$dst_url" -c "$redo_sql" >"$work/redo-before.tsv"
echo "---- Redis DB $redis_db: $keys_before khoá (hàng đợi Medusa + công việc/khóa giả) → xoá → $keys_after. Việc tạo lại từ DB bền vững:"
show_tsv <"$work/redo-before.tsv"
printf 'outbox-dispatch\tdrill:order.confirmed:order_drill_paid\noutbox-dispatch\tdrill:order.placed_pending:order_drill_cod\nreconcile-attempts\tchk_drill_stale\n' \
  >"$work/redo.expected"
r5_ok=1
r5_note=""
[[ "$keys_before" -gt 0 && "$keys_after" == 0 ]] || {
  r5_ok=0
  r5_note+=" redis-không-sạch"
}
diff -u "$work/redo.expected" "$work/redo-before.tsv" >&2 || {
  r5_ok=0
  r5_note+=" việc-cần-làm-lại-lệch"
}
if ! XS_DRILL_RESULT_FILE="$work/redis-loss.json" run_medusa "$work/redis-loss.log" "$dst_url" \
  exec ./integration-tests/ops/redis-loss-drill.ts; then
  r5_ok=0
  r5_note+=" redis-loss-drill.ts-lỗi"
fi
[[ -f "$work/redis-loss.json" ]] && sed 's/^/    /' "$work/redis-loss.json"
verify="$(xs_psql -At -d "$dst_url" -c "SELECT
  (SELECT state || '/' || coalesce(error_code, '') FROM checkout_attempt WHERE id = 'chk_drill_stale') = 'compensated/LEASE_EXPIRED'
  AND (SELECT state FROM coupon_usage WHERE id = 'cpu_drill_stale') = 'released'
  AND (SELECT count(*) FROM outbox_event WHERE event_key LIKE 'drill:%' AND state <> 'sent') = 0
  AND (SELECT count(*) FROM outbound_message) = 2
  AND (SELECT id || '/' || state || '/' || attempts FROM outbound_message
       WHERE message_key = 'notify:drill:order.confirmed:order_drill_paid:email') = 'omsg_drill_paid/sent/1'
  AND (SELECT state FROM outbound_message
       WHERE message_key = 'notify:drill:order.placed_pending:order_drill_cod:sms') = 'sent'")"
[[ "$verify" == t ]] || {
  r5_ok=0
  r5_note+=" trạng-thái-DB-sau-bù-trừ-lệch"
}
redo_left="$(xs_psql -At -d "$dst_url" -c "SELECT count(*) FROM ($redo_sql) x")"
[[ "$redo_left" == 0 ]] || {
  r5_ok=0
  r5_note+=" còn-việc-tồn"
}
manual="$(xs_psql -At -d "$dst_url" -c "SELECT string_agg(kind || ':' || coalesce(order_id, '-'), ', ' ORDER BY kind, order_id)
  FROM ops_exception WHERE state <> 'resolved'")"
if [[ "$r5_ok" == 1 ]]; then
  record 5 PASS "1 attempt bù trừ + 2 outbox xử lý đúng một lần (2 worker đồng thời), 1 thông báo gửi, 0 gửi lặp; lượt 2 rỗng; cần người: ${manual:-không}"
else
  record 5 FAIL "lệch:$r5_note (log: integration-tests/ops/redis-loss-drill.ts)"
fi

# ------------------------------------------------------------------------------------------------ 6. RPO / PITR
cat <<'EOF'
---- RPO ≤ 15 phút (đặc tả §13.2) — PHỤ THUỘC HẠ TẦNG PRODUCTION, diễn tập cục bộ KHÔNG chứng minh:
    Bản pg_dump hằng ngày chỉ cho RPO ≈ 24 giờ. Đạt ≤ 15 phút cần PITR:
    - Postgres managed (chọn dịch vụ có PITR, retention ≥ 7 ngày) HOẶC tự host: archive_mode=on, archive_command/
      pgBackRest/WAL-G đẩy WAL lên kho mã hoá ngoài máy, archive_timeout ≤ 300s, base backup hằng ngày.
    - Khôi phục: dựng instance mới với recovery_target_time = <thời điểm trước sự cố> → migrate → đối chiếu
      (post-restore-reconcile.sh --since <recovery_target_time>) như bước 3–5 ở trên.
    - Chứng minh: diễn tập PITR thật trên staging trước ra mắt, ghi RPO/RTO đo được vào docs/ops/RUNBOOK.md §4.
EOF
record 6 "CHỜ NGƯỜI" "chủ dự án chọn hạ tầng PITR + diễn tập PITR staging (RUNBOOK §4.5) — quy trình restore/đối chiếu đã chứng minh ở bước 3–5"

xs_log "xong — dọn dẹp"
