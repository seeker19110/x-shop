#!/usr/bin/env bash
# Đối chiếu giao dịch dở sau khi khôi phục database (đặc tả §13.2, AT28): liệt kê việc PHẢI tra với provider.
#
# Dùng:  DATABASE_URL=<URL database đã khôi phục> scripts/ops/post-restore-reconcile.sh --since <mốc ISO UTC> \
#          [--margin-seconds 300] [--payment-refs <file>] [--courier-codes <file>]
#   --since           mốc của bản khôi phục (snapshot_mark_utc trong .meta, hoặc recovery_target_time của PITR)
#   --payment-refs    txn_ref có hoạt động ở cổng VNPAY trong cửa sổ [mốc − biên, hiện tại] (xuất từ cổng merchant)
#   --courier-codes   client_order_code có hoạt động ở GHN trong cùng cửa sổ (xuất từ trang quản lý hãng)
#   File: mỗi dòng một mã (lấy cột đầu nếu là CSV/TSV); dòng trống, dòng `#…` và dòng tiêu đề bị bỏ qua.
#
# Ra stdout, mỗi dòng `<LOẠI>\t<mã>\t<lý do>` (sắp xếp):
#   QUERYDR  <txn_ref>            missing_in_db                — cổng có, DB không có: đơn mất → ngoại lệ thủ công (§4)
#   QUERYDR  <txn_ref>            provider_activity_after_mark — DB có nhưng trạng thái có thể cũ → querydr qua hệ thống
#   QUERYDR  <txn_ref>            open_in_db                   — attempt created/pending/unknown trong DB → querydr
#   COURIER  <client_order_code>  missing_in_db                — hãng có, DB không có → tạo lại bản ghi từ API hãng
#   COURIER  <client_order_code>  provider_activity_after_mark — DB có → chạy đồng bộ trạng thái bằng API
#   COURIER  <client_order_code>  open_in_db                   — vận đơn chưa có mã hãng (timeout) → tra theo mã
# Chỉ ĐỌC database. Không gọi provider (querydr/tra vận đơn chạy qua hệ thống, idempotent — RUNBOOK §4).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ops/lib.sh
source "$here/lib.sh"

since=""
margin=300
pay_file=""
courier_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) since="${2:-}"; shift 2 ;;
    --margin-seconds) margin="${2:-}"; shift 2 ;;
    --payment-refs) pay_file="${2:-}"; shift 2 ;;
    --courier-codes) courier_file="${2:-}"; shift 2 ;;
    *) xs_die "tham số lạ: $1" ;;
  esac
done
[[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$ ]] || xs_die "--since phải là ISO UTC, vd 2026-10-25T03:00:00Z"
[[ "$margin" =~ ^[0-9]+$ ]] || xs_die "--margin-seconds phải là số nguyên ≥ 0"
db_url="${DATABASE_URL:-postgres://xshop:xshop@localhost:5432/xshop}"

# Mã từ file → danh sách VALUES đã kiểm ký tự (chặn tiêm SQL: chỉ [A-Za-z0-9_.-], ≤ 100 ký tự).
values_of() {
  local file="$1" refs
  if [[ -z "$file" ]]; then
    printf "SELECT NULL::text AS ref WHERE false"
    return
  fi
  [[ -r "$file" ]] || xs_die "không đọc được: $file"
  refs="$(awk -F'[,\t]' '{gsub(/^[ \t"]+|[ \t"\r]+$/, "", $1)} $1 != "" && $1 !~ /^#/ {print $1}' "$file" |
    grep -Ev '^(txn_ref|vnp_TxnRef|client_order_code|ma_don)$' | sort -u || true)"
  if [[ -z "$refs" ]]; then
    printf "SELECT NULL::text AS ref WHERE false"
    return
  fi
  local bad
  bad="$(grep -Ev '^[A-Za-z0-9_.-]{1,100}$' <<<"$refs" || true)"
  [[ -z "$bad" ]] || xs_die "mã không hợp lệ trong $file: $(head -n1 <<<"$bad")"
  printf "VALUES %s" "$(awk -v q="'" 'BEGIN { ORS = "" } { print (NR > 1 ? "," : "") "(" q $0 q ")" }' <<<"$refs")"
}

pay_values="$(values_of "$pay_file")"
courier_values="$(values_of "$courier_file")"
xs_log "đối chiếu $(xs_url_redact "$db_url") — cửa sổ provider: từ $since trừ ${margin}s tới hiện tại"
[[ -n "$pay_file" ]] || xs_log "CẢNH BÁO: thiếu --payment-refs — chỉ liệt kê attempt mở trong DB; PHẢI xuất giao dịch VNPAY theo cửa sổ trên"
[[ -n "$courier_file" ]] || xs_log "CẢNH BÁO: thiếu --courier-codes — PHẢI xuất vận đơn GHN theo cửa sổ trên"

xs_psql -At -F $'\t' -d "$db_url" <<SQL
WITH prov_pay(ref) AS ($pay_values),
     prov_ship(ref) AS ($courier_values),
     rows AS (
       SELECT 'QUERYDR' AS kind, p.ref,
              CASE WHEN EXISTS (SELECT 1 FROM payment_attempt a WHERE a.txn_ref = p.ref AND a.deleted_at IS NULL)
                   THEN 'provider_activity_after_mark' ELSE 'missing_in_db' END AS reason
       FROM prov_pay p
       UNION ALL
       SELECT 'QUERYDR', a.txn_ref, 'open_in_db'
       FROM payment_attempt a
       WHERE a.state IN ('created', 'pending', 'unknown') AND a.deleted_at IS NULL
         AND a.txn_ref NOT IN (SELECT ref FROM prov_pay)
       UNION ALL
       SELECT 'COURIER', s.ref,
              CASE WHEN EXISTS (SELECT 1 FROM shipment x WHERE x.client_order_code = s.ref AND x.deleted_at IS NULL)
                   THEN 'provider_activity_after_mark' ELSE 'missing_in_db' END
       FROM prov_ship s
       UNION ALL
       SELECT 'COURIER', x.client_order_code, 'open_in_db'
       FROM shipment x
       WHERE x.provider_order_code IS NULL AND x.deleted_at IS NULL
         AND x.client_order_code NOT IN (SELECT ref FROM prov_ship)
     )
SELECT kind, ref, reason FROM rows ORDER BY kind, ref;
SQL
