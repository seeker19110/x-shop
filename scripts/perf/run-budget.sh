#!/usr/bin/env bash
# Build storefront production, chạy `next start` trên cổng tạm, đo ngân sách tải đầu từng route rồi dừng server.
# ROUTES (phẩy) mặc định là 6 màn công khai; backend cần chạy sẵn nếu route đọc dữ liệu thật.
set -euo pipefail
PORT="${PERF_PORT:-3199}"
ROUTES="${ROUTES:-/}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
pnpm --filter @x-shop/storefront build >/dev/null
(cd "$root/apps/storefront" && PORT="$PORT" exec pnpm start) >"${TMPDIR:-/tmp}/xshop-perf-next.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; pkill -P "$pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -fs -o /dev/null "http://localhost:$PORT/" && break; sleep 0.5; done
node "$root/scripts/perf/budget.mjs" --base "http://localhost:$PORT" --routes "$ROUTES" --json "${PERF_JSON:-$root/docs/ops/perf/budget-latest.json}"
