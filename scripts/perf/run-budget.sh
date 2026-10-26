#!/usr/bin/env bash
# `pnpm perf:budget` (T-035): build storefront production với dữ liệu mẫu (XS_DATA_SOURCE=fixtures — không cần
# backend/DB, tất định), chạy `next start` trên cổng tạm, rồi
#   1. đo ngân sách tài nguyên tải đầu từng route (đặc tả §10.2)  → scripts/perf/budget.mjs
#   2. Lighthouse lab hồ sơ §10.1 (trang chủ, danh mục, PDP; median)  → scripts/perf/lighthouse.mjs
# và dừng server. Đỏ nếu bất kỳ bước nào đỏ (cả hai bước luôn chạy để báo đủ). Báo cáo ở docs/ops/perf/.
# Biến: PERF_PORT, ROUTES (phẩy; mặc định 6 màn công khai), LH_ROUTES, LH_RUNS (mặc định 5), XT_CHROMIUM.
set -euo pipefail
PORT="${PERF_PORT:-3199}"
ROUTES="${ROUTES:-/,/danh-muc/ao,/san-pham/ao-so-mi-lua,/gio-hang,/thanh-toan,/don-hang/XS-PERF0001}"
LH_ROUTES="${LH_ROUTES:-/,/danh-muc/ao,/san-pham/ao-so-mi-lua}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/docs/ops/perf"
mkdir -p "$out"
# Biến công khai giả cho bản build đo (không bí mật); MEDUSA_BACKEND_URL trỏ cổng chết: fixtures không gọi backend.
export NEXT_PUBLIC_SITE_URL="http://localhost:$PORT"
export NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY="pk_perf_placeholder"
export MEDUSA_BACKEND_URL="http://127.0.0.1:9"
export XS_DATA_SOURCE="fixtures"
export NEXT_TELEMETRY_DISABLED=1
pnpm --filter @x-shop/storefront build >/dev/null
# setsid → cả nhóm tiến trình (pnpm → next-server) bị dừng khi thoát.
log="$(mktemp "${TMPDIR:-/tmp}/xshop-perf-next.XXXXXX")"
(cd "$root/apps/storefront" && PORT="$PORT" exec setsid pnpm start) >"$log" 2>&1 &
pid=$!
trap 'kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; rm -f "$log"' EXIT
up=0
for _ in $(seq 1 120); do
  if curl -fs -o /dev/null "http://localhost:$PORT/"; then up=1; break; fi
  sleep 0.5
done
if [ "$up" != 1 ]; then echo "✗ storefront không lên trên cổng $PORT"; tail -20 "$log"; exit 1; fi
rc=0
echo "== Ngân sách tài nguyên tải đầu (§10.2) =="
node "$root/scripts/perf/budget.mjs" --base "http://localhost:$PORT" --routes "$ROUTES" --json "$out/budget-latest.json" || rc=1
echo "== Lighthouse lab (§10.1) =="
node "$root/scripts/perf/lighthouse.mjs" --base "http://localhost:$PORT" --routes "$LH_ROUTES" --runs "${LH_RUNS:-5}" --out "$out" || rc=1
exit "$rc"
