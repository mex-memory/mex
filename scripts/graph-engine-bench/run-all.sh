#!/usr/bin/env bash
# Run the M0 baseline matrix: every repository with 0.8.5 and next2, then the judges.
#
# usage: BENCH_DIR=... CLI_085=... CLI_NEXT2=... bash run-all.sh [repo...]
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
echo "$MATRIX" | while read -r repo runs judged; do
  [ -z "${repo:-}" ] && continue
  if [ "$wanted" != "  " ] && [[ "$wanted" != *" $repo "* ]]; then continue; fi
  keep=""; [ "$judged" = yes ] && keep="--keep-graph"
  for tool in 085 next2; do
    cli="$CLI_085"; [ "$tool" = next2 ] && cli="$CLI_NEXT2"
    echo "== $(date +%H:%M:%S) $repo $tool"
    node "$HERE/measure.mjs" --bench "$BENCH_DIR" --tool "$tool" --cli "$cli" --repo "$repo" --runs "$runs" $keep --timeout-min 40
  done
  if [ "$judged" = yes ]; then bash "$HERE/judge.sh" "$repo" 085 next2 || echo "judge failed for $repo"; fi
  df -h "$BENCH_DIR" | tail -1
done
echo "== $(date +%H:%M:%S) done"
