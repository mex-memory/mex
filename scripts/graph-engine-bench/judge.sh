#!/usr/bin/env bash
# Build the SCIP answer key for one benchmark repository (OSS-73, M0) and score
# every kept graph of it.
#
# usage: BENCH_DIR=... bash judge.sh <repo> [tool...]
#
# The judge indexes its own copy of the repository, without dependencies, as in
# the mex-platform bench. Its JSON is cached in $BENCH_DIR/results/judge/<repo>.
# A tool's graph is the one `measure.mjs --keep-graph` kept in
# $BENCH_DIR/results/<tool>/<repo>/graph.db, scored against the kept source copy.
set -euo pipefail
: "${BENCH_DIR:?set BENCH_DIR}"
repo="$1"; shift
HERE="$(cd "$(dirname "$0")" && pwd)"
JUDGES="$BENCH_DIR/judges/node_modules/@sourcegraph"
out="$BENCH_DIR/results/judge/$repo"
if [ ! -s "$out/scip.json" ]; then
  rm -rf "$out" && mkdir -p "$out"
  cp -R "$BENCH_DIR/repos/$repo" "$out/src"
  src="$out/src"
  case "$repo" in
    express)
      (cd "$src" && NODE_OPTIONS=--max-old-space-size=4096 node "$JUDGES/scip-typescript/dist/src/main.js" index --infer-tsconfig --output "$out/index.scip") > "$out/judge.log" 2>&1 ;;
    nest)
      echo '{ "extends": "./tsconfig.json", "include": ["packages/**/*", "integration/**/*"], "exclude": ["node_modules"] }' > "$src/tsconfig.judge.json"
      (cd "$src" && NODE_OPTIONS=--max-old-space-size=6144 node "$JUDGES/scip-typescript/dist/src/main.js" index tsconfig.judge.json --output "$out/index.scip") > "$out/judge.log" 2>&1 ;;
    hono|zod|tsc|novu)
      (cd "$src" && NODE_OPTIONS=--max-old-space-size=6144 node "$JUDGES/scip-typescript/dist/src/main.js" index --output "$out/index.scip") > "$out/judge.log" 2>&1 ;;
    flask|httpx|fastapi|django)
      # scip-python 0.6.6 crashes on Django's own test suite (a pyright assertion
      # in tests/model_enums/tests.py), so Django is judged on its library only.
      [ "$repo" = django ] && rm -rf "$src/tests"
      echo "[]" > "$out/env.json"
      (cd "$src" && node "$JUDGES/scip-python/index.js" index . --project-name "$repo" --environment "$out/env.json" --output "$out/index.scip") > "$out/judge.log" 2>&1 ;;
    *) echo "no judge for $repo" >&2; exit 2 ;;
  esac
  [ -s "$out/index.scip" ] || { echo "judge produced no index; see $out/judge.log" >&2; tail -5 "$out/judge.log" >&2; exit 1; }
  "$BENCH_DIR/tools/scip" print --json "$out/index.scip" > "$out/scip.json"
  rm -rf "$src"
fi
for tool in "$@"; do
  dir="$BENCH_DIR/results/$tool/$repo"
  [ -s "$dir/graph.db" ] || { echo "no kept graph for $tool/$repo" >&2; continue; }
  root="$(cat "$dir/root.txt")"
  node --max-old-space-size=6144 "$HERE/accuracy.mjs" "$root" "$dir/graph.db" "$out/scip.json" > "$dir/accuracy.json"
  node -e 'const a=require(process.argv[1]); console.log(process.argv[2], process.argv[3], JSON.stringify({precision:a.precision, recall:a.recall, sites:a.sites, found:a.found, edges_judged:a.edges_judged, wrong:a.wrong, unjudged:a.unjudged}))' "$dir/accuracy.json" "$tool" "$repo"
done
