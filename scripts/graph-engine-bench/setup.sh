#!/usr/bin/env bash
# Prepare the graph engine baseline bench (OSS-73, milestone M0).
#
# usage: BENCH_DIR=/path/to/empty/dir bash scripts/graph-engine-bench/setup.sh [repo...]
#
# Fetches every benchmark repository at a pinned commit (depth 1), installs
# the SCIP judges at pinned versions, and builds the SCIP CLI. Nothing here
# runs code from the benchmark repositories, and their dependencies are never
# installed: every tool indexes the repository's own source only.
#
# Needs git, Go and Node with npm, and network access.
set -euo pipefail
: "${BENCH_DIR:?set BENCH_DIR to the bench directory}"
mkdir -p "$BENCH_DIR"/{repos,judges,tools,results,logs}

# name language url commit (full hash; tag in the comment)
REPOS='
hono       ts     https://github.com/honojs/hono          676c8f80fcafc49e6e74c847a8f0d9c44cc7faee
zod        ts     https://github.com/colinhacks/zod       b500a2ee95134f81d74da7911d7378dd2853d042
nest       ts     https://github.com/nestjs/nest          35142c3eca8edaaf6abc5984d915da2fbd458aa2
express    js     https://github.com/expressjs/express    b4ab7d65d7724d9309b6faaaf82ad492da2a6d35
novu       ts     https://github.com/novuhq/novu          083bdfe3cd999b7a6189adb7b0c8805dca4adbd3
tsc        ts     https://github.com/microsoft/TypeScript c63de15a992d37f0d6cec03ac7631872838602cb
flask      py     https://github.com/pallets/flask        a29f88ce6f2f9843bd6fcbbfce1390a2071965d6
httpx      py     https://github.com/encode/httpx         b55d4635701d9dc22928ee647880c76b078ba3f2
fastapi    py     https://github.com/tiangolo/fastapi     22381558446c5d1ac376680a6581dd63b3a04119
django     py     https://github.com/django/django        060cd4ad20b532a8ba0a446130bebead23cba671
ripgrep    rust   https://github.com/BurntSushi/ripgrep   e89fff89ac9af12e8d4ce9d5fd07beb408ca730f
fd         rust   https://github.com/sharkdp/fd           b2a287b3993768e0ec52f0852916917f23fb2a38
'
# Tags: hono v4.13.19, zod v4.6.7, novu v3.20.0, TypeScript v5.9.3 (src/ only,
# as graph-02 measured it), django 5.2.19, ripgrep 15.2.0, fd v10.5.2.
# Express, Flask, HTTPX, FastAPI and NestJS match the mex-platform bench pins.

wanted=" ${*:-} "
echo "$REPOS" | while read -r name lang url commit; do
  [ -z "${name:-}" ] && continue
  if [ "$wanted" != "  " ] && [[ "$wanted" != *" $name "* ]]; then continue; fi
  dir="$BENCH_DIR/repos/$name"
  if [ "$name" = tsc ]; then
    # graph-02 measured the TypeScript repository's src/ copied into a fresh repo.
    src="$BENCH_DIR/repos/.tsc-full"
    if [ ! -d "$src/.git" ]; then git init -q "$src"; git -C "$src" remote add origin "$url"; fi
    git -C "$src" -c core.autocrlf=false fetch -q --depth 1 origin "$commit"
    git -C "$src" -c core.autocrlf=false -c advice.detachedHead=false checkout -q --force "$commit"
    rm -rf "$dir" && mkdir -p "$dir" && cp -R "$src/src" "$dir/src"
    git -C "$dir" init -q && git -C "$dir" add -A
    git -C "$dir" -c user.name=bench -c user.email=bench@localhost commit -q -m "TypeScript v5.9.3 src/"
    rm -rf "$src"
  else
    if [ ! -d "$dir/.git" ]; then git init -q "$dir"; git -C "$dir" remote add origin "$url"; fi
    git -C "$dir" -c core.autocrlf=false fetch -q --depth 1 origin "$commit"
    git -C "$dir" -c core.autocrlf=false -c advice.detachedHead=false checkout -q --force "$commit"
  fi
  echo "$name $lang $(git -C "$dir" rev-parse HEAD) $(git -C "$dir" ls-files | wc -l | tr -d ' ') files"
done

# Accuracy judges (compiler-precise SCIP indexers), as in the mex-platform bench.
if [ ! -d "$BENCH_DIR/judges/node_modules/@sourcegraph/scip-typescript" ]; then
  npm install --silent --no-audit --no-fund --prefix "$BENCH_DIR/judges" \
    "@sourcegraph/scip-typescript@0.4.0" "@sourcegraph/scip-python@0.6.6"
fi
SCIP_COMMIT=f07c097d9b5d952c50eecde328200e454937fa09
if [ ! -x "$BENCH_DIR/tools/scip" ]; then
  s="$BENCH_DIR/tools/scip-src"
  if [ ! -d "$s/.git" ]; then git init -q "$s"; git -C "$s" remote add origin https://github.com/scip-code/scip.git; fi
  git -C "$s" fetch -q --depth 1 origin "$SCIP_COMMIT"
  git -C "$s" -c advice.detachedHead=false checkout -q --force "$SCIP_COMMIT"
  (cd "$s" && go build -o "$BENCH_DIR/tools/scip" ./cmd/scip)
  rm -rf "$s"
fi
echo "judges and scip ready"
