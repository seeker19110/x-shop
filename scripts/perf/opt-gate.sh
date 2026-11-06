#!/usr/bin/env bash
# Gate cho task tối ưu theo LOOP-OPT (T-127; nhà: .xtemplates/framework/11-autonomous-loop/optimization-loop.md).
# Gate trong PLAN lấy script này TỪ COMMIT GỐC — agent không sửa được bản đang chạy (LOOP-OPT-002):
#   bash <(git show <base>:scripts/perf/opt-gate.sh) <base> [tuỳ chọn] -- <lệnh đo…>
# Các bước (đều dùng xt.py của commit gốc trong worktree tạm — công cụ chấm cũng là bộ đo khoá):
#   1. perf guard --base <base> --strict, khoá mặc định 'scripts/load/*' 'scripts/perf/*' (+ --locked): đỏ khi diff
#      đụng/xoá bộ đo, hoặc có dòng đáng ngờ (cache/sleep/đổi đồng hồ…).
#   2. baseline đo lại TRONG LƯỢT NÀY trên commit gốc (worktree tạm), cùng máy: --setup → perf sample → --teardown.
#   3. đo cây làm việc ngay sau đó, cùng lệnh, cùng số lần.
#   4. perf compare before after (Mann-Whitney U, sàn nhiễu MAD) — exit của Gate = exit của compare (0 = improved).
# Tuỳ chọn:
#   --runs N         số mẫu mỗi bên, ≥ 10 (mặc định 10)      --warmup N   lần chạy bỏ đi đầu mỗi bên (mặc định 2)
#   --timeout S      trần mỗi lần đo, giây (mặc định 300)     --locked G   thêm glob khoá (test tương đương, input đo)
#   --setup CMD      chạy một lần trong MỖI cây trước khi đo (vd 'LOAD_REUSE=1 node scripts/load/serve.mjs start')
#   --teardown CMD   chạy sau khi đo mỗi cây, kể cả khi lỗi (vd 'node scripts/load/serve.mjs stop')
#   --compare-arg A  thêm tham số cho perf compare (lặp được: --exact, --no-regress, --higher-is-better…)
#   --out DIR        nơi ghi before.json/after.json (mặc định thư mục tạm, in ra đường dẫn)
#   --no-install     không chạy `pnpm install --frozen-lockfile --offline` trong worktree gốc (lệnh đo không cần phụ thuộc)
# Exit: 0 improved · 1 guard đỏ / lệnh đo lỗi / compare không improved · 2 tham số sai hoặc commit gốc thiếu khung.
set -euo pipefail

die() {
  echo "opt-gate: $*" >&2
  exit 2
}
[ $# -ge 1 ] || die "cách dùng: opt-gate.sh <base> [tuỳ chọn] -- <lệnh đo…>"
base="$1"
shift
runs=10 warmup=2 timeout=300 setup="" teardown="" out="" install=1
locked=('scripts/load/*' 'scripts/perf/*')
compare_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --runs | --warmup | --timeout | --locked | --setup | --teardown | --compare-arg | --out)
      [ $# -ge 2 ] || die "$1 cần giá trị"
      case "$1" in
        --runs) runs="$2" ;;
        --warmup) warmup="$2" ;;
        --timeout) timeout="$2" ;;
        --locked) locked+=("$2") ;;
        --setup) setup="$2" ;;
        --teardown) teardown="$2" ;;
        --compare-arg) compare_args+=("$2") ;;
        --out) out="$2" ;;
      esac
      shift 2
      ;;
    --no-install) install=0 && shift ;;
    --) shift && break ;;
    *) die "tham số lạ: $1" ;;
  esac
done
[ $# -ge 1 ] || die "thiếu lệnh đo sau --"
[[ "$runs" =~ ^[0-9]+$ ]] && [ "$runs" -ge 10 ] || die "--runs phải ≥ 10 (LOOP-OPT-003), nhận '$runs'"
[[ "$warmup" =~ ^[0-9]+$ ]] || die "--warmup phải là số nguyên ≥ 0"
[[ "$timeout" =~ ^[0-9]+$ ]] && [ "$timeout" -ge 1 ] || die "--timeout phải là số nguyên ≥ 1"

root="$(git rev-parse --show-toplevel)" || die "không ở trong repo git"
cd "$root"
base_sha="$(git rev-parse --verify --quiet "${base}^{commit}")" || die "ref gốc không hợp lệ: $base"
if [ -z "$out" ]; then out="$(mktemp -d)"; fi
mkdir -p "$out"

wt="$(mktemp -d)"
active="" # cây đang có --setup chưa --teardown
cleanup() {
  if [ -n "$active" ] && [ -n "$teardown" ]; then (cd "$active" && bash -c "$teardown") || true; fi
  git -C "$root" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
  git -C "$root" worktree prune 2>/dev/null || true
}
trap cleanup EXIT
git worktree add -q --detach "$wt" "$base_sha"

xt="$wt/.xtemplates/scripts/xt.py"
[ -f "$xt" ] || die "commit gốc $base_sha không có .xtemplates/scripts/xt.py — không có công cụ chấm khoá"
XT=(python3 "$xt")
echo "opt-gate: gốc $base_sha · $runs mẫu/bên (+$warmup warm-up) · lệnh: $* · mẫu → $out"

guard_args=()
for g in "${locked[@]}"; do guard_args+=(--locked "$g"); done
echo "opt-gate: [1/4] perf guard (khoá: ${locked[*]})"
"${XT[@]}" perf guard --base "$base_sha" "${guard_args[@]}" --strict || exit 1

# Gọi trong ngữ cảnh `|| exit` nên `set -e` không áp bên trong — mọi bước kiểm mã thoát tường minh.
measure() { # $1 = cây, $2 = file mẫu, phần còn lại = lệnh
  local tree="$1" file="$2"
  shift 2
  cd "$tree" || return 1
  if [ -n "$setup" ]; then
    active="$tree"
    bash -c "$setup" || {
      echo "opt-gate: --setup lỗi trong $tree" >&2
      return 1
    }
  fi
  "${XT[@]}" perf sample --out "$file" --runs "$runs" --warmup "$warmup" --timeout "$timeout" -- "$@" || return 1
  if [ -n "$teardown" ]; then
    bash -c "$teardown" || {
      echo "opt-gate: --teardown lỗi trong $tree" >&2
      return 1
    }
  fi
  active=""
  cd "$root" || return 1
}

if [ "$install" = 1 ] && [ -f "$wt/pnpm-lock.yaml" ]; then
  (cd "$wt" && pnpm install --frozen-lockfile --offline --silent) || die "pnpm install --offline trong worktree gốc lỗi"
fi
echo "opt-gate: [2/4] baseline trên commit gốc (cùng lượt, cùng máy)"
measure "$wt" "$out/before.json" "$@" || exit 1
echo "opt-gate: [3/4] cây làm việc"
measure "$root" "$out/after.json" "$@" || exit 1
echo "opt-gate: [4/4] perf compare ${compare_args[*]}"
set +e
"${XT[@]}" perf compare "${compare_args[@]}" "$out/before.json" "$out/after.json"
rc=$?
set -e
echo "opt-gate: compare exit $rc ($([ "$rc" = 0 ] && echo 'giữ được' || echo 'hoàn tác')) · mẫu: $out/before.json $out/after.json"
exit "$rc"
