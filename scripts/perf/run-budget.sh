#!/usr/bin/env bash
# Build storefront production, chạy `next start` trên cổng tạm, đo ngân sách tải đầu từng route rồi dừng server.
# ROUTES (phẩy) mặc định là 6 màn công khai; backend cần chạy sẵn nếu route đọc dữ liệu thật.
set -euo pipefail
PORT="${PERF_PORT:-3199}"
ROUTES="${ROUTES:-/,/danh-muc/ao,/san-pham/ao-so-mi-lua}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-http://localhost:$PORT}" NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY="${NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY:-pk_perf_placeholder}" pnpm --filter @x-shop/storefront build >/dev/null
# Biến công khai giả cho bản build đo (không bí mật); setsid → cả nhóm tiến trình (pnpm → next-server) bị dừng khi thoát.
export NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-http://localhost:$PORT}"
export NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY="${NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY:-pk_perf_placeholder}"
(cd "$root/apps/storefront" && PORT="$PORT" exec setsid pnpm start) >"${TMPDIR:-/tmp}/xshop-perf-next.log" 2>&1 &
pid=$!
trap 'kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fs -o /dev/null "http://localhost:$PORT/" && break; sleep 0.5; done
node "$root/scripts/perf/budget.mjs" --base "http://localhost:$PORT" --routes "$ROUTES" --json "${PERF_JSON:-$root/docs/ops/perf/budget-latest.json}"
