#!/usr/bin/env bash
# Run the benchmark matrix with 0.8.5, next2 and optionally the Rust engine.
#
# usage: BENCH_DIR=... CLI_085=... CLI_NEXT2=... [ENGINE_BIN=...] bash run-all.sh [repo...]
# For Python engine comparisons, set ENGINE_BIN and select the Python repos.
set -uo pipefail
: "${BENCH_DIR:?}"; : "${CLI_085:?}"; : "${CLI_NEXT2:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# repo runs judged
MATRIX='
hono 3 yes
express 3 yes
zod 3 yes
nest 3 yes
flask 3 yes
httpx 3 yes
fastapi 3 yes
fd 3 no
ripgrep 3 no
tsc 2 no
django 2 yes
novu 1 no
'
wanted=" ${*:-} "
tools=(085 next2)
if [ -n "${ENGINE_BIN:-}" ]; then tools+=(engine); fi
echo "$MATRIX" | while read -r repo runs judged; do
  [ -z "${repo:-}" ] && continue
  if [ "$wanted" != "  " ] && [[ "$wanted" != *" $repo "* ]]; then continue; fi
  keep=""; [ "$judged" = yes ] && keep="--keep-graph"
  for tool in "${tools[@]}"; do
    case "$tool" in
      085) runner=(--cli "$CLI_085") ;;
      next2) runner=(--cli "$CLI_NEXT2") ;;
      engine) runner=(--engine "$ENGINE_BIN") ;;
    esac
    echo "== $(date +%H:%M:%S) $repo $tool"
    node "$HERE/measure.mjs" --bench "$BENCH_DIR" --tool "$tool" "${runner[@]}" --repo "$repo" --runs "$runs" $keep --timeout-min 40
  done
  if [ "$judged" = yes ]; then bash "$HERE/judge.sh" "$repo" "${tools[@]}" || echo "judge failed for $repo"; fi
  df -h "$BENCH_DIR" | tail -1
done
echo "== $(date +%H:%M:%S) done"
