#!/usr/bin/env bash
# `test_unit` của xt.yaml (T-128): chạy ĐÚNG một id do scripts/test-shards/list.mjs in ra ("$1"). dev-task.sh chạy các
# id song song (`xargs -P nproc`) — commit đụng cấu hình cổng chạy mọi lớp test trong hook PreToolUse (trần 600 s).
#   unit:<thư mục gói>  → `pnpm --dir <gói> test` (như `pnpm -r test`); có XT_COV_DIR và gói có `test:coverage` → chạy
#                         nó, báo cáo vào "$XT_COV_DIR/<gói>" (ngưỡng nằm trong cấu hình của gói).
#   http:<tên>          → `test:integration` của apps/backend cho riêng integration-tests/http/<tên>.spec.ts.
# Mỗi id http dựng một app Medusa + DB tạm riêng (tên DB có ulid, cổng do get-port) — chỉ Redis là dùng chung. Hai suite
# cùng DB Redis tranh khoá/hàng đợi của nhau (treo tới timeout), còn jest.config.js chọn DB theo `pid % 12` nên tiến trình
# song song có thể trùng. Vì vậy mỗi id http giữ một "ô" (flock trên máy, áp cả các worktree khác chạy cổng này cùng
# lúc): ô k ⇒ Redis DB k. Số ô = số suite tích hợp chạy cùng lúc tối đa: XS_TEST_HTTP_JOBS (mặc định 4, 1–12 — DB 13–15
# để cho scripts/ops); id http thứ 5 trở đi chờ ô trống (tối đa XS_TEST_SLOT_WAIT giây, mặc định 900) rồi đỏ.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
id="${1:-}"
log() { printf '[test-unit %s] %s\n' "$id" "$*" >&2; }

case "$id" in
unit:apps/* | unit:packages/*)
  dir="${id#unit:}"
  [[ "$dir" =~ ^(apps|packages)/[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] && [ -f "$ROOT/$dir/package.json" ] ||
    { log "id không hợp lệ (không có $dir/package.json)"; exit 2; }
  if [ -n "${XT_COV_DIR:-}" ] && grep -q '"test:coverage"' "$ROOT/$dir/package.json"; then
    exec pnpm --dir "$ROOT/$dir" run test:coverage --coverage.reportsDirectory="$XT_COV_DIR/${dir//\//-}"
  fi
  exec pnpm --dir "$ROOT/$dir" test
  ;;
http:*)
  name="${id#http:}"
  spec="integration-tests/http/$name.spec.ts"
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [ -f "$ROOT/apps/backend/$spec" ] ||
    { log "id không hợp lệ (không có apps/backend/$spec)"; exit 2; }
  cap="${XS_TEST_HTTP_JOBS:-4}"
  wait_max="${XS_TEST_SLOT_WAIT:-900}"
  [[ "$cap" =~ ^([1-9]|1[0-2])$ ]] || { log "XS_TEST_HTTP_JOBS phải là 1–12 (nhận '$cap')"; exit 2; }
  [[ "$wait_max" =~ ^[0-9]{1,5}$ ]] || { log "XS_TEST_SLOT_WAIT phải là số giây (nhận '$wait_max')"; exit 2; }
  run=(pnpm --dir "$ROOT/apps/backend" run test:integration --runTestsByPath "$spec")
  if ! command -v flock >/dev/null 2>&1; then
    log "không có flock (util-linux) — chạy không giữ ô, Redis DB theo pid (jest.config.js); song song có thể trùng DB"
    exec "${run[@]}"
  fi
  slots="${XS_TEST_SLOT_DIR:-${TMPDIR:-/tmp}/x-shop-test-slots}"
  mkdir -p -- "$slots" || { log "không tạo được $slots"; exit 2; }
  # URL giữ host/cổng/mật khẩu của REDIS_URL, chỉ thay DB index = ô (jest.config.js giữ nguyên URL đã có index).
  mapfile -t urls < <(node -e 'const u = new URL(process.argv[1]);
for (let k = 1; k <= Number(process.argv[2]); k++) { u.pathname = "/" + k; console.log(u.toString()); }' \
    "${REDIS_URL:-redis://localhost:6379}" "$cap")
  [ "${#urls[@]}" -eq "$cap" ] || { log "REDIS_URL không hợp lệ"; exit 2; }
  start=$SECONDS
  while :; do
    for k in $(seq 1 "$cap"); do
      # -o: tiến trình con (jest, app Medusa) không giữ khoá; -E 75: phân biệt "ô bận" với exit của test.
      REDIS_URL="${urls[k - 1]}" flock -n -o -E 75 "$slots/redis-$k.lock" "${run[@]}"
      rc=$?
      [ "$rc" -eq 75 ] || exit "$rc"
    done
    [ $((SECONDS - start)) -lt "$wait_max" ] || { log "chờ ô Redis quá ${wait_max}s ($slots bận hết $cap ô)"; exit 1; }
    sleep 1
  done
  ;;
*)
  log "id không hợp lệ — dùng id do scripts/test-shards/list.mjs in ra"
  exit 2
  ;;
esac
