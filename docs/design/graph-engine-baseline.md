# Graph engine baseline (OSS-73, M0)

The baseline the Rust engine must beat, measured on 22 Nov 2026: MEX 0.8.5 (the released tarball) and `next2` at `2bb3b159` (graph-01 compiler route plus graph-02 storage), on twelve pinned repositories. Raw numbers: [graph-engine-baseline.json](graph-engine-baseline.json). Scripts: `scripts/graph-engine-bench/`.

## How it was measured

- **Machine:** Apple M4 MacBook Air (10 cores, 16 GB, fanless), macOS 26.0.1, Node 22.23.2. Every number below compares the two versions on this machine; graph-02's Windows numbers (16 cores) are not comparable one to one.
- **Repositories** (`setup.sh`), fetched at pinned commits, dependencies never installed, nothing from them executed: Express, Hono v4.13.19, zod v4.6.7, NestJS, TypeScript v5.9.3 `src/` (as graph-02 measured it), novu v3.20.0, Flask, HTTPX, FastAPI, Django 5.2.19, ripgrep 15.2.0, fd v10.5.2. Express, Flask, HTTPX, FastAPI and NestJS use the mex-platform bench pins.
- **Build and refresh** (`measure.mjs`): each run indexes a fresh copy (read once before timing) with a fresh `MEX_HOME`, telemetry and update checks off. `mex graph rebuild`, then one comment line appended to a fixed source file and `mex graph refresh`. Medians of 3 runs (TypeScript `src/` and Django 2, novu 1). Peak memory is the whole process tree, sampled every 100 ms. Disk is every graph file written.
- **Warm edits** (`warm-latency.ts`, `next2` only): build, open a warm checkout, 2 warm-up edits, then timed body-only edits to one file. A cold edit reopens the checkout, as the background process does.
- **Call accuracy** (`judge.sh`, `accuracy.mjs`): compiler-precise SCIP indexes as the answer key (scip-typescript 0.4.0, scip-python 0.6.6), adapted from the mex-platform bench with one change: **the judge defines the call sites**, so recall is comparable across tools that extract different calls. A call site is a reference in callee position whose symbol the judge defines in the repository as a function, method or class. An edge is correct when its target is the judge's definition. *Concrete* recall leaves out calls the judge places on an interface or type-alias member (dispatch through a type, which neither version resolves). Edges the judge can't place (no definition, symbol defined twice, star-import mix-ups, non-ASCII lines) are counted and skipped. A scrambling test (20% of call targets replaced) dropped precision from 99.98% to 82%, as it should. Django is judged on its library only: scip-python crashes on its test suite. A repository with a `src/` layout gives the Python judge `extraPaths: ["src"]`, as an installed checkout would. An overload set (same file, container, kind and name) counts as one target, since the judges name its first signature and a graph may name the implementation.

## Build, memory and disk

0.8.5 / `next2`, medians.

| Repo | Files | Nodes | Build s | Peak MB | Disk MB | Bytes per node | Refresh s |
|---|---:|---:|---:|---:|---:|---:|---:|
| express (JS) | 141 | 3,496 | 2.1 / 2.0 | 500 / 485 | 16 / 16 | 4,758 / 4,660 | 1.2 / 1.3 |
| hono | 454 | 15,516 | 9.5 / 7.7 | 1,164 / 985 | 73 / 70 | 4,952 / 4,728 | 3.9 / 2.7 |
| zod | 520 | 16,121 | 12.9 / 8.4 | 1,529 / 1,045 | 91 / 85 | 5,903 / 5,554 | 3.6 / 2.6 |
| nest | 2,054 | 26,329 | 14.7 / 14.5 | 1,327 / 1,147 | 130 / 128 | 5,193 / 5,085 | 7.3 / 5.5 |
| TypeScript `src/` | 701 | 56,600 | 23.7 / 25.0 | 1,499 / 1,696 | 208 / 288 | 4,611 / 5,330 | 5.6 / 7.3 |
| novu | 9,856 | 161,735 | 86.3 / 77.1 | 3,246 / 2,553 | 814 / 788 | 5,278 / 5,110 | 25.4 / 23.3 |
| flask | 83 | 2,198 | 1.3 / 1.4 | 361 / 370 | 8 / 8 | 3,587 / 3,589 | 0.8 / 0.8 |
| httpx | 60 | 1,485 | 1.2 / 1.3 | 346 / 355 | 6 / 6 | 4,399 / 4,402 | 0.8 / 0.8 |
| fastapi | 1,122 | 10,220 | 4.6 / 4.7 | 556 / 549 | 35 / 35 | 3,613 / 3,612 | 2.4 / 2.1 |
| django | 2,934 | 61,260 | 25.0 / 26.0 | 965 / 1,041 | 267 / 257 | 4,475 / 4,397 | 8.7 / 7.4 |
| fd (Rust) | 25 | 724 | 0.8 / 0.9 | 351 / 364 | 3 / 3 | 5,058 / 5,063 | 0.6 / 0.7 |
| ripgrep (Rust) | 100 | 4,424 | 2.4 / 2.6 | 464 / 453 | 21 / 21 | 4,889 / 4,890 | 1.0 / 1.0 |

Across all twelve `next2` graphs, the largest tables are edges (209 MB), nodes (175 MB), unresolved references (157 MB), fingerprints (119 MB), the extraction cache (97 MB), the edge call-site index (71 MB) and LSH buckets (35 MB).

## Warm edits (`next2`)

| Repo | Edits | Result | p50 | p90 | Held between edits |
|---|---:|---|---:|---:|---:|
| hono | 20 | all published | 160 ms | 165 ms | 774 MB (722 Node + 52 compiler) |
| TypeScript `src/` | 20 | all published | 290 ms | 319 ms | 1,764 MB |
| novu | 3 | all published | 697 ms (485 resolve) | 701 ms | 2,777 MB |
| zod | 4 | **all cold**: "an edge leaves a node outside the corpus" | — | — | 975 MB |
| nest | 4 | **all cold**: same reason | — | — | 1,271 MB |
| fastapi (Python) | 20 | all cold, by design | — | — | 351 MB |

## Call accuracy

0.8.5 / `next2`.

| Repo | Precision | Recall, concrete | Recall, all | Interface sites | Call sites |
|---|---:|---:|---:|---:|---:|
| express (JS) | 100.0% / 100.0% | 100.0% / 99.3% | 100.0% / 99.3% | 0 | 280 |
| hono | 100.0% / 100.0% | 97.6% / 99.3% | 82.4% / 83.9% | 417 | 2,677 |
| zod | 99.6% / 99.6% | 98.8% / 98.8% | 62.6% / 62.6% | 6,262 | 16,866 |
| nest | 100.0% / 99.9% | 97.0% / 97.2% | 94.0% / 94.2% | 289 | 8,918 |
| flask | 85.6% / 85.6% | 22.2% / 22.2% | — | — | 1,202 |
| httpx | 89.4% / 89.4% | 33.0% / 33.0% | — | — | 1,504 |
| fastapi | 98.4% / 98.4% | 22.9% / 22.9% | — | — | 4,406 |
| django | 92.4% / 92.4% | 61.6% / 61.6% | — | — | 12,730 |

Rust has no answer key yet: rust-analyzer's SCIP needs a Rust toolchain, which arrives with M1. C# has none until a repository is chosen.

## What the baseline says

1. **The compiler route's TypeScript accuracy is the bar, and it is high:** 99.6–100% precision and 97–99% concrete recall. Both versions miss nearly every call through an interface or type member (2 of 417 on Hono; zod has 6,262 such sites, 37% of its calls).
2. **Python is weak today, in both directions.** Precision 86–98%: the builtin `open()` resolves to `flask/testing.py:open`, `client.request()` to a module-level `request()` in the same file. Recall 22–62%: imports inside function bodies are ignored, and calls through `self`, instances and attributes rarely resolve. The engine can beat this by a wide margin.
3. **Storage is about 4.4–5.9 KB per node**, not the 9 KB measured on a September 0.8.0 store; later fixes shrank it. Edges, nodes, unresolved references and fingerprints dominate, as the design expected.
4. **`next2` is a modest step over 0.8.5 on this machine:** up to 1.5× faster on TypeScript and 10–30% less peak memory, the same on Python and Rust, and slower with a bigger graph on TypeScript `src/` (1.9× the edges).
5. **The warm path is not yet usable on two of four TypeScript repos.** On zod and nest every edit goes cold ("an edge leaves a node outside the corpus"), so each edit costs a full refresh. Where it works, novu's edits spend 70% of their time in resolution, and every warm checkout holds 0.8–2.8 GB against graph-02's 1 GB cap.
6. **A one-file refresh still costs a large part of a full build:** 30% on novu (23 s), 29% on Django, up to 70% on small repos.

## M2: Python on the engine

The Rust engine builds every Python file itself: native tree-sitter with the same `tree-sitter-python` 0.21.0 grammar, parallel extraction, a new resolver and schema v5. Same machine and method as above; the engine's request lists the corpus today's discovery would (no hidden paths, none of the ignored folders).

**Nodes are unchanged.** `parity.mjs` compares today's extractor nodes with the engine's by id, field by field. On Flask, HTTPX, FastAPI and Django all 71,718 match exactly: ids, spans, signatures, docstrings, body hashes, flags and fingerprints. No grounded anchor moves.

`next2` → engine:

| Repo | Build s | CPU s | Peak MB | Disk MB | Bytes per node | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| flask | 1.38 → 0.06 | 1.8 → 0.3 | 370 → not sampled | 7.5 → 1.3 | 3,589 → 719 | 85.6% → **99.8%** | 22.2% → **83.9%** |
| httpx | 1.28 → 0.05 | 1.6 → 0.3 | 355 → not sampled | 6.2 → 1.1 | 4,402 → 742 | 89.4% → **99.8%** | 33.0% → **82.9%** |
| fastapi | 4.70 → 0.24 | 5.8 → 1.2 | 549 → 54 | 35.2 → 5.2 | 3,612 → 615 | 98.4% → **100%** | 22.9% → **70.8%** |
| django | 26.0 → 1.33 | 29.0 → 6.4 | 1,041 → 276 | 256.9 → 36.8 | 4,397 → 650 | 92.4% → **99.3%** | 61.6% → **92.9%** |

**The Python gate passes:** cold builds 14–25× faster, peak memory 10–27% of `next2`, precision 99.3–100% against a 95% floor, recall above today on every repository, and identical nodes.

What these numbers don't cover yet:

- **Search tables.** The engine's graphs have no `source_chunks` or full-text tables yet; they come with the v5 readers, and bytes per node will rise then. The 1.5 KB target leaves room.
- **Refresh and warm edits.** The engine has no `refresh` or `serve` mode yet (M5). A one-file change is a full build, already 1.3 s on Django.
- **Memory on small repositories.** Builds under 100 ms finish between samples, so their peak isn't measured.

Precision rose because a call resolves only through scoping, imports, `self`, `super()` and evidence-typed receivers, and a name bound two ways in one scope stays unresolved. Recall rose because imports inside functions, package re-exports, inherited methods, typed parameters, `x = Cls()` and `self.x` fields now count. Most remaining misses are calls on untyped parameters and values (`untyped_receiver`).

## Locked targets

These replace the first proposals in the design. Speed and memory are ratios against `next2` on the same machine, so they hold on any CI runner; the absolute values are for this M4.

| Goal | Target | On the M4 |
|---|---|---|
| Cold build | ≥ 5× faster than `next2` on every repo | novu ≤ 15 s, Hono ≤ 1.5 s, Django ≤ 5 s |
| Peak memory | ≤ 40% of `next2`, and never above 1 GB | novu ≤ 1 GB, Hono ≤ 400 MB |
| One-file refresh | ≤ 1 s on every repo | novu 23 s → ≤ 1 s |
| Warm edit, every language | p50 ≤ 50 ms, and no repo where edits always go cold | Hono 160 ms, novu 697 ms → ≤ 50 ms |
| Held between edits | ≤ 300 MB on novu | 2.8 GB → ≤ 300 MB |
| Disk | ≤ 1.5 KB per node (3–4× smaller) | novu 788 MB → ≤ 240 MB |
| TS precision | ≥ the compiler route on every repo (≥ 99.6%) | |
| TS recall, concrete | ≥ 90% of the compiler's overall, ≥ 85% per repo, ≥ 99% on statically certain call forms | Hono, zod, nest: ≥ 89% |
| TS recall, interface sites | a measured number, reported; not a gate | today about 0% |
| Python | precision ≥ 95% on every repo, recall above today on every repo | today 86–98% and 22–62% |
| Rust, C# | no worse than today once their answer keys exist | |

## Reproduce

```sh
export BENCH_DIR=/path/to/empty/dir
bash scripts/graph-engine-bench/setup.sh
CLI_085=<0.8.5 dist/cli.js> CLI_NEXT2=<next2 dist/cli.js> bash scripts/graph-engine-bench/run-all.sh
node scripts/graph-engine-bench/report.mjs "$BENCH_DIR" > baseline.json
```
