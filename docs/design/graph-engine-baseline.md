# Graph engine baseline (OSS-73, M0)

The baseline the Rust engine must beat, measured on 22 Nov 2026: MEX 0.8.5 (the released tarball) and `next2` at `2bb3b159` (graph-01 compiler route plus graph-02 storage), on twelve pinned repositories. Raw numbers: [graph-engine-baseline.json](graph-engine-baseline.json). Scripts: `scripts/graph-engine-bench/`.

## How it was measured

- **Machine:** Apple M4 MacBook Air (10 cores, 16 GB, fanless), macOS 26.0.1, Node 22.23.2. Every number below compares the two versions on this machine; graph-02's Windows numbers (16 cores) are not comparable one to one.
- **Repositories** (`setup.sh`), fetched at pinned commits, dependencies never installed, nothing from them executed: Express, Hono v4.13.19, zod v4.6.7, NestJS, TypeScript v5.9.3 `src/` (as graph-02 measured it), novu v3.20.0, Flask, HTTPX, FastAPI, Django 5.2.19, ripgrep 15.2.0, fd v10.5.2. Express, Flask, HTTPX, FastAPI and NestJS use the mex-platform bench pins.
- **Build and refresh** (`measure.mjs`): each run indexes a fresh copy (read once before timing) with a fresh `MEX_HOME`, telemetry and update checks off. `mex graph rebuild`, then one comment line appended to a fixed source file and `mex graph refresh`. Medians of 3 runs (TypeScript `src/` and Django 2, novu 1). Peak memory is the whole process tree, sampled every 100 ms. Disk is every graph file written.
- **Warm edits** (`warm-latency.ts`): build, open a warm checkout, make two warm-up edits, then time edits to one file. The `next2` run used the compiler warm path. M5 stage 2 uses the Rust warm path through the same MEX checkout interface.
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

### Through `mex graph`, into today's storage

With `MEX_GRAPH_ENGINE_LANGUAGES=python`, `mex graph rebuild` takes Python from one engine `stage` job and writes it into today's schema v4 graph. Every other language, framework resolution and publication stay as they are. Same machine and method, this branch with the flag off and on (Django two runs, the others three):

| Repo | Rebuild s | Peak MB | Refresh s | Edges | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| flask | 1.43 → 1.09 | 365 → 341 | 0.84 → 0.83 | 2,810 → 3,549 | 85.6% → **100%** | 22.2% → **83.9%** |
| httpx | 1.33 → 0.97 | 355 → 337 | 0.81 → 0.76 | 2,173 → 3,463 | 89.4% → **99.8%** | 33.0% → **82.9%** |
| fastapi | 4.84 → 3.39 | 552 → 463 | 2.15 → 2.19 | 13,098 → 15,029 | 98.4% → **100%** | 22.9% → **70.8%** |
| django | 28.1 → 19.5 | 1,076 → 911 | 7.7 → 8.2 | 102,830 → 147,460 | 92.4% → **99.3%** | 61.6% → **92.9%** |

Nodes and sketches are unchanged, and accuracy matches the engine's own builds. Wall time falls by only 25–33%, because today's storage now dominates. Django's phase timings, off → on:

| Phase | Off s | On s |
|---|---:|---:|
| Extract (tree-sitter or engine) | 3.9 | 1.3 |
| Fingerprints | 4.4 | 0.3 |
| Resolve | 0.4 | 0.2 |
| Publish to schema v4 (rows, fingerprints, LSH) | 12.5 | 11.5 |
| Validate and inspect the candidate | 2.9 | 2.9 |

All staging falls from 8.8 s to 1.9 s, while the v4 write and its checks take 14–15 s either way. That is what schema v5 removes (the engine writes Django's v5 graph within its 1.3 s), once TypeScript and JavaScript are on the engine too. Refresh is a little slower with the flag on, since the engine stages every Python file again where today reuses cached extractions; engine refresh is M5.

## M3: TypeScript and JavaScript on the engine

The engine builds TypeScript and JavaScript with native tree-sitter (`tree-sitter-typescript` 0.23.2, `tree-sitter-javascript` 0.25.0), a port of TypeScript 5.9.3's scanner for fingerprints, a module resolver and a reference resolver. There is no type checker. Same machine and method as above.

**Nodes are unchanged.** `parity.mjs` compares the compiler route's nodes in the kept `next2` graphs with the engine's by id. On Hono, zod, NestJS and Express all 61,456 match. There are zero differences in spans, containers, body hashes, flags, decorators, type parameters, minhash and token counts, so no grounded anchor moves. The remaining differences:

- **Docstrings (340).** The checker gives a member the documentation of what it inherits, augments or is assigned from, such as Hono's `TypedURL::protocol` from the DOM `URL`. Syntax alone can't see that. One NestJS docstring is longer than the engine's 2,048-byte bound.
- **One export flag.** zod's `ZodMiniType` is augmented from a test file, and the saved compiler graph marks it unexported.
- **90 extra Express nodes.** Module-level `require()` bindings such as `const session = require('express-session')`. The checker merges unresolved packages into one unknown symbol and drops them.
- **Signatures and return types** are rendered by the checker with inferred types, so they agree on 57–89% of nodes. They are not part of any id.

The scanner matches `ts.createScanner` on every file of the four repositories (1.59 million tokens). The module resolver matches `ts.resolveModuleName` on Hono, zod, NestJS, Express, novu and TypeScript itself. The exceptions are deliberate: workspace packages resolve to their sources where TypeScript, with nothing built, finds nothing.

`next2` (compiler route) → engine, schema v5 builds:

| Repo | Build s | Peak MB | Disk MB | Precision | Recall | Concrete recall |
|---|---:|---:|---:|---:|---:|---:|
| hono | 7.67 → 0.39 | 974 → 108 | 73.4 → 9.8 | 99.98% → **100%** | 83.9% → 80.1% | 99.3% → 94.8% |
| zod | 8.65 → 0.48 | 1,041 → 131 | 89.5 → 10.9 | 99.62% → **100%** | 62.6% → 61.7% | 98.8% → 97.4% |
| nest | 14.6 → 0.58 | 1,168 → 156 | 133.9 → 17.5 | 99.93% → **100%** | 94.2% → **95.3%** | 97.2% → **98.4%** |
| express | | | | 100% → 100% | 99.3% → **100%** | |

Recall on the call forms the gate names as certain, compiler → engine:

| Repo | Imported function | `new X()` | `this.method()` | `super` |
|---|---:|---:|---:|---:|
| hono | 100% → 100% | 99.6% → 100% | 100% → 100% | 100% → 100% |
| zod | 100% → 100% | 53.4% → 100% | 100% → 99.6% | — |
| nest | 89.8% → 100% | 94.8% → 99.95% | 100% → 99.3% | 100% → 100% |

**The TypeScript gate passes:**
- Precision is at least the compiler's on every repository; the engine made no judged wrong edge.
- Recall is 99.3% of the compiler's overall (21,059 against 21,201 call sites). By repository it is 95.5% on Hono, 98.6% on zod and 101% on NestJS.
- Recall on the certain call forms is at least 99.3%.

The compiler's 57 wrong edges were local bindings resolved to a declaration with the same name.

Most remaining misses are calls whose target the judge places on an interface or type alias member, such as Hono's `this.router.add` (415 of 533) and zod's `schema._zod.run` (6,175 of 6,453). The compiler misses most of those as well. Without a type checker, untyped bindings stay unresolved with a reason, never guessed.

novu (9,856 files) builds in 3.85 s at 879 MB, against `next2`'s 77 s and 2.6 GB. The v5 graphs have no search tables yet, so disk is not like for like, as for Python.

### graph-03's checks

Two more checks were added to the TypeScript gate for graph-03 (#398). Both use scripts from that branch, unchanged.

**Who calls this** (`scripts/graph-bench/callgraph.mjs`). Over 100 sampled definitions per repository, the TypeScript language service is the answer key. Each v4 graph's `calls` edges are read directly as the baseline arm; the flag-off graph is the compiler route. novu was left out for disk space.

| Repo | Compiler graph P / R / F1 | Engine graph P / R / F1 |
|---|---|---|
| hono | 1.000 / 0.998 / 0.999 | 0.998 / 0.963 / 0.980 |
| TypeScript compiler | 0.911 / 0.950 / 0.930 | 0.913 / 0.950 / 0.931 |
| mex | 0.961 / 0.996 / 0.978 | **1.000** / 0.996 / **0.998** |

The engine's recall is 99% of the compiler's overall (about 1,396 of 1,411 call sites the compiler graph finds) and at least 96% on every repository. The run on the TypeScript compiler first found 0.845 recall. It came from a barrel bug: one `export *` of a generated, uncommitted module (`diagnosticInformationMap.generated.ts`) hid every name of the barrel. That is fixed: an unreadable star now contributes no names, as in TypeScript.

**Knowledge bench `eight-kinds-v1`** (74 claims, 444 claim checks across five checkpoints, graph-03's evaluator and delivery). Three graphs were scored: graph-03's own compiler build, this branch with the flag off, and this branch with the flag on. All three give identical results: 0 stale claims served, 85.1% fresh retention, 87.6% accuracy, and a passing grade. Only 3 of the 74 claims are `calls` relations, so this is a light check of the graph itself.

### Through `mex graph`, into today's storage

`MEX_GRAPH_ENGINE_LANGUAGES=typescript,javascript` stages TypeScript and JavaScript with one engine job and writes them into today's schema v4 graph. With the flag on, the compiler route is not loaded at all. Framework resolution still runs. Warm edits go to a normal refresh, so compiler captures never touch an engine-built graph.

Flag off → on, medians of three runs per flag:

| Repo | Rebuild s | Peak MB | Refresh s | Graph MB | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| hono | 8.96 → 5.30 | 947 → 424 | 3.27 → 2.65 | 70.0 → 64.2 | 99.98% → **100%** | 83.9% → 80.1% |
| zod | 12.57 → 6.73 | 908 → 486 | 4.43 → 3.10 | 85.4 → 75.6 | 99.62% → **100%** | 62.6% → 61.7% |
| nest | 21.73 → 11.07 | 1,072 → 555 | 8.99 → 4.61 | 127.7 → 122.1 | 99.93% → **100%** | 94.2% → **95.3%** |
| express | 2.29 → 1.50 | 439 → 284 | 1.45 → 0.77 | 15.5 → 15.0 | 100% → 100% | 99.3% → **100%** |

Every node row and fingerprint that grounded anchors read is unchanged: ids, spans, containers, body hashes, export flags, minhash and token counts, on all 61,462 baseline nodes. The listed M3 differences remain (signatures, inherited docstrings, zod's one export flag, and Express's 90 extra `require()` binding nodes).

Builds and refreshes take about half the time and memory, but no less, because today's storage now dominates. On NestJS the compiler or engine step falls from 7.9 s to 0.8 s and fingerprints from 0.9 s to 0.02 s, while writing v4 rows and fingerprints and validating the candidate take 7.0 s and 6.4 s. Schema v5 removes that cost: the engine writes NestJS's v5 graph in 0.58 s.

## M4: frameworks, Rust and C# on the engine

The engine now builds every language MEX supports, along with the five framework resolvers (Express, NestJS, Next.js, Flask, FastAPI). Grammars match today's WASM ones: `tree-sitter-rust` 0.20.4 is vendored as C source (MIT), and `tree-sitter-c-sharp` 0.23.5 is pinned (MIT).

**Nodes and frameworks are unchanged.** Every node row and sketch matches today on ripgrep (4,424 nodes), fd (724), a C# repository (Ardalis GuardClauses at `dfa042c`, 1,940 nodes) and the test fixtures. Framework route nodes and edges match exactly: Flask 290 / 437, FastAPI 1,251 / 2,426, NestJS 2 / 2 and Express on NestJS 2 / 2, plus the positive fixtures for each framework.

**Rust resolution binds only through the written owner.** There is no answer key for Rust here, so these are counts and examples, not scores:
- Today's resolver bound calls by name. For example, it bound ripgrep's `io::Error::new` to `DecompressionMatcherBuilder::new` and fd's `CommandTemplate::new` to `CommandSet::new`. Those edges are gone: 202 calls on ripgrep and 24 on fd that only today's graph has.
- The engine adds calls through declared return types (`TestEnv::new(...).global_ignore_file(...)`), `Self { … }` construction, field types and `pub use` re-exports: 996 calls on ripgrep and 53 on fd that only the engine's graph has.
- C# edges match today exactly.

SCIP accuracy is unchanged on Flask, FastAPI, Express and NestJS.

## Schema v5 storage

The M4 measurements below use the engine's `build` for v5 rebuilds and refreshes. M5 stage 1 uses `refresh` over compatible v5 bases, with cached facts and a per-checkout overlay. Node keeps the maintenance lease and publishes the validated candidate by pointer. Switching storage rebuilds once. Stage 1 routed warm edits through refresh.

The v5 schema has:
- integer keys between rows;
- 16-byte public ids;
- hashes stored as bytes;
- code tables for kinds, languages, provenances, resolution methods and unresolved reasons;
- no JSON columns, no `identity_key` and no LSH table.

`unresolved_calls` stores each unresolved call with an interned, indexed name, a reason, its site, and the candidate when there is exactly one, as graph-03 asked. NestJS stores 1,583 interface calls with a single implementation. Search keeps `nodes_fts` and source-chunk full-text tables.

**v4 and v5 answer the same.** `scripts/graph-engine-bench/storage-parity.ts` asks both graphs the same questions through MEX's read APIs and CLI. For three symbols per repository, it covers status, node and source search, definition, callers, callees, impact, the grounded anchor (id, body hash, `mh2:` fingerprint), the CLI's where-defined, who-calls, what-calls, get and impact, and reconciliation after a file move. Results:

| Repo | Answers identical | Deliberate differences |
|---|---:|---|
| flask | 38 / 38 | none |
| hono | 38 / 39 | `Context::waitUntil` who-calls now lists two calls whose single candidate is the method |
| nest | 38 / 38 | none |

v4 → v5 through `mex graph`, with the engine flag on in both. Medians of three runs for Hono and NestJS, and one run for the others:

| Repo | Rebuild s | Peak MB | Refresh s | Graph MB |
|---|---:|---:|---:|---:|
| flask | 1.62 → 0.39 | 246 → 128 | 0.62 → 0.37 | 7.1 → 2.4 |
| hono | 5.40 → 1.30 | 425 → 252 | 2.09 → 1.40 | 64 → 17 |
| nest | 11.2 → 2.5 | 575 → 322 | 4.80 → 2.78 | 122 → 30 |
| ripgrep | 2.99 → 0.55 | 370 → 163 | 0.95 → — | 21 → 7.6 |

Against `next2`'s compiler route, Hono rebuilds in 1.3 s instead of 9.0 s and NestJS in 2.5 s instead of 21.7 s. v5 graphs are about a quarter of v4's size. For Hono, v5 takes 17 MB against v4's 64 MB:
- edges 17.7 → 2.3 MB;
- nodes 15.2 → 4.3 MB;
- unresolved references 17.5 → 1.7 MB.

The LSH table (4.1 MB) and import bindings (1.0 MB) are gone. What remains is mostly fingerprints (4.1 MB) and the two full-text indexes (3.3 MB). About a tenth of each v5 file is SQLite free space, which a final `VACUUM` would recover.

## M5 stage 1: incremental refresh

A refresh reuses each unchanged file's cached facts, re-parses only changed files, and publishes an overlay of the changed rows over the v5 base. `scripts/graph-engine-bench/refresh-replay.ts` replays 30 Hono commits and 6 Flask edits (including package additions and removals). After every step, it compares the overlay with an independent cold rebuild across 31 table and full-text digests, 864 point reads and 444 searches. There are 0 differences.

The facts cache (`facts-v2.db`) stores binary records in Zstandard blocks. Its budget is 12 KiB per source file, from 64 to 256 MiB. novu's cache takes 49.4 MB (182 MB as LZ4-compressed JSON) and is never evicted at novu's size.

Through `mex graph` with every language on the engine and v5 storage. Medians of three runs. Refresh is after appending one line to a fixed source file:

| Repo | Rebuild s | Peak MB | Refresh s (M4 → now) | Overlay | Facts cache MB |
|---|---:|---:|---:|---:|---:|
| flask | 0.32 | 147 | 0.37 → 0.19 | 446 KB | 0.6 |
| hono | 1.21 | 226 | 1.40 → 0.23 | 852 KB | 4.5 |
| nest | 2.21 | 316 | 2.78 → 0.35 | 905 KB | 7.6 |
| ripgrep | 0.48 | 161 | — → 0.19 | 442 KB | 1.0 |
| novu | 13.1 | 944 | — → 0.81 | 2.7 MB | 49.4 |

Against `next2`, novu rebuilds in 13.1 s instead of 77 s at 944 MB instead of 2.6 GB, and refreshes one file in 0.81 s instead of 23 s. Hono refreshes in 0.23 s instead of 3.3 s and NestJS in 0.35 s instead of 9.0 s. Like the `next2` baseline, these refreshes append a comment, which moves no declaration. At this stage, moving declarations still resolved the whole corpus and took 3.1 s on novu.

novu's rebuild spends about 9.8 s in the engine:
- 3.7 s extracting;
- 0.4 s resolving;
- 5.7 s in the v5 writer, including 1.8 s indexing source for search.

Node's discovery, validation and publication take the rest. In a novu refresh the engine's job takes 83 ms, and Node's checks take most of the remaining 0.7 s. Stage 2 is meant to remove those checks. Set `MEX_GRAPH_PHASE_TIMINGS` to a JSONL path to get the engine's phases beside Node's. Flask's peak, 147 MB, is 40.3% of `next2`'s 365 MB. Node's process accounts for 109 MB of it, and the engine's per-thread cache state for about 17 MB.

## M5 stage 2: warm edits and incremental resolution

Engine-owned v5 checkouts keep one `mex-graph serve` process alive. Node
verifies each candidate under a writer lease and publishes its pointer.
When filesystem identities cannot prove the unedited inputs, the same
session retries with contained discovery.

Stage 2b makes resolution incremental in `serve` and `refresh`. Position
changes move saved relationship sites and rebuild the edited file's
declarations, fingerprints and search rows. A local reference change
resolves one origin. A surface change also visits the files that read it,
including re-exports and lookups that previously failed. Unchanged results
keep their published rows. Cross-file callback ownership and changes to
call-pair fingerprint neighbours can require additional public rows.
Large deltas run in a short-lived worker. The
[incremental design](graph-engine-incremental.md) describes the dependency
rules, retained data and full-resolution cases.

The M4 MacBook Air runs used Node 22.23.2 and the same source files as
stage 2. Each mode published 24 edits after two warm-ups. MEX latency ends at
pointer publication. Engine latency includes candidate generation and
filesystem proof. Held MiB adds the resident engine's RSS to the Node RSS
delta from before the checkout opened. Each cell reports `MEX p50/p95 ·
engine p50/p95 · held MiB` and each latency is in milliseconds.

| Repository and edited file | Append | Prepend | Insert call | Change export |
|---|---:|---:|---:|---:|
| Hono `src/hono-base.ts` | 31.8/32.9 · 18.5/19.4 · 45.8 | 33.0/35.6 · 16.7/20.1 · 50.8 | 34.0/36.4 · 20.1/21.5 · 61.4 | 289.9/314.5 · 246.5/250.1 · 66.3 |
| Flask `src/flask/app.py` | 33.2/34.6 · 17.8/18.8 · 39.0 | 33.9/35.0 · 18.4/19.2 · 43.3 | 36.6/38.6 · 19.6/20.2 · 44.8 | 63.6/75.7 · 34.7/35.0 · 65.9 |
| ripgrep `crates/core/main.rs` | 24.7/25.1 · 9.8/10.3 · 36.0 | 25.9/32.0 · 10.6/11.3 · 31.6 | 25.8/26.8 · 11.2/11.5 · 35.1 | 59.8/73.8 · 31.5/31.9 · 58.6 |
| NestJS `packages/core/nest-factory.ts` | 28.0/29.8 · 15.4/16.2 · 64.1 | 32.4/33.6 · 17.9/18.9 · 67.1 | 33.8/38.3 · 20.1/23.7 · 91.2 | 970.1/1003.6 · 900.8/921.5 · 63.7 |
| novu `apps/api/src/app.module.ts` | 38.7/39.4 · 19.1/19.4 · 157.9 | 41.2/42.6 · 21.9/22.2 · 160.6 | 48.7/50.1 · 29.9/30.2 · 196.5 | 308.0/440.1 · 135.0/156.6 · 236.0 |

`MEX_WARM_EDIT=append` adds a trailing comment. `prepend` adds it before
any declarations. `call` adds a call to an existing function body.
`export` alternates adding and deleting an exported function.

Before stage 2b, prepend p50 was 325 ms on Hono, 58 ms on Flask, 81 ms
on ripgrep, 457 ms on NestJS and 2,693 ms on novu. Novu's normal
`mex graph refresh` on a prepend took 840 ms median over three runs
(831–861 ms, down from 3.1 s). The engine job took 32 ms median. Each
candidate re-extracted and rewrote one file. Node's source capture,
filesystem verification and database audit account for most of the rest.
Novu held at most 264.4 MiB across 26 mixed edits.

Novu's inserted-call medians in the two final samples were 50.2 ms and
48.7 ms. Engine medians were 30.4 ms and 29.9 ms. The append p50
comparison against the stage 2 base binary with the same Node wrapper was
30.9 → 31.8 ms on Hono, 32.1 → 33.2 ms on Flask, 24.4 → 24.7 ms on
ripgrep, 30.7 → 28.0 ms on NestJS and 43.1 → 38.7 ms on novu. The
engine jobs on Hono, Flask and ripgrep picked up a small fixed cost from
planning and writing the incremental candidate.

Large TypeScript export changes can fan out across importers, re-exports
and inherited declarations. For Hono and NestJS, the refresh worker and
its resolution work account for most of the latency. On novu, the engine
and Node's continuity scan each took about 135 ms median. The engine
is the largest component on Flask and ripgrep.

Building the private dependency and projection tables adds to cold build
cost. The novu Rust build job took about 13 s in the benchmark runs,
compared with 9.0 s on the stage 2 base. Two end-to-end cold builds took
16.0 s and 19.4 s. The 545 MB base included 898,854 recorded reads with
116 MiB of text keys before indexing.

`scripts/graph-engine-bench/refresh-replay.ts --arm=both` checks both edit
paths against an independent cold build after every step. It compares
raw rows, public reads, fingerprints, search results and the outgoing
resolution digests. The synthetic histories cover prepends, inserted and
removed calls, declaration and call-site renames, exports, file additions
and deletions, and changed re-exports. The TypeScript history also moves a
callback site that shares an outgoing edge key.

| Replay | Edits | Point probes per arm | Searches per arm | Differences |
|---|---:|---:|---:|---:|
| Hono, 30 commits and 13 synthetic edits | 43 | 1032 | 516 | 0 |
| Flask, 6 historical and 12 synthetic edits | 18 | 432 | 252 | 0 |
| ripgrep, 1 original and 12 synthetic edits | 13 | 312 | 156 | 0 |
| novu, 13 synthetic edits | 13 | 312 | 130 | 0 |
| TypeScript seeded fixture | 160 | 1120 | 1920 | 0 |
| Python seeded fixture | 160 | 800 | 1600 | 0 |

Each of the 407 steps published an overlay in both modes. Novu ran with
`--arm=warm` and `--arm=refresh` separately to keep scratch use within the
disk budget. Bulk digests use the same read SQL with temporary indexes over
the published rows. Point reads and searches use the publication directly.

Still to do on v5 is graph-03's Go reader (`native/graph/store.go`, in
the unmerged mex #398).

## M5 stage 2c — compact incremental state

Same-machine comparison on an M4 MacBook Air with Node 22.23.2.
The baseline CLI and release engine were built at `8f91b9cc`. The stage 2c
CLI and engine were built in the same checkout from the implementation.
Cold runs alternate arms on fresh shared clones of the pinned repositories
with empty graph homes. Both arms use schema v5 and the TypeScript,
JavaScript, Python, Rust and C# adapters. `measure.mjs` times the whole CLI
invocation, with additional `dbstat` queries during post-build inspection.
Process-tree RSS is sampled every 100 ms. Each cell gives the median and
[min–max] spread, from baseline to stage 2c. Disk sizes use decimal MB.
The facts cache is measured after each run's append refresh.

| Repo | Runs per arm | Cold s | Peak tree RSS MiB | Base MB | Facts cache MB |
|---|---:|---:|---:|---:|---:|
| Hono | 3 | 1.138 [1.134–1.141] → 1.180 [1.174–1.185] | 244 [243–255] → 247 [242–253] | 18.510 → 18.313 | 4.489 [4.452–4.506] → 4.493 [4.489–4.514] |
| Flask | 5 | 0.317 [0.315–0.323] → 0.318 [0.316–0.321] | 147 [146–151] → 147 [142–151] | 2.523 → 2.605 [2.605–2.607] | 0.557 [0.557–0.561] → 0.557 [0.553–0.561] |
| ripgrep | 5 | 0.463 [0.461–0.471] → 0.468 [0.466–0.469] | 166 [165–168] → 163 [160–167] | 8.069 → 7.045 | 0.963 [0.958–0.963] → 0.963 [0.958–0.967] |
| NestJS | 3 | 2.106 [2.077–2.107] → 2.122 [2.110–2.133] | 320 [317–321] → 303 [301–306] | 32.621 → 33.268 | 7.614 [7.610–7.631] → 7.614 [7.614–7.619] |
| novu | 3 | 11.860 [11.825–11.974] → 12.411 [12.335–13.423] | 945 [943–946] → 958 [950–975] | 199.619 → 214.938 [214.934–214.938] | 49.463 [49.439–49.467] → 49.476 [49.455–49.476] |

Novu's 161,688-node base takes 1,329 bytes per node. Relative to
`8f91b9cc`, its cold median is 4.6% higher, peak RSS is 1.4% higher and
base size is 7.7% higher. The 958 MiB median equals 1,004.5 MB, 4.5 MB
above the decimal 1 GB cap. The highest sample was 975 MiB (1,022.4 MB).
The build still holds extracted facts, resolver models and prepared
signatures while Node retains the source capture. Both builds use the same
facts-cache disk format. Novu's 13 KB difference in the median facts-cache
size falls within the observed variation from concurrent compression block
grouping. The largest increase among the smaller repositories was Hono's
3.7% cold wall time. Ripgrep's base shrank by 12.7%, and NestJS peak RSS
fell by 5.3%.

### Warm edits

Each case measures 24 publications after two warm-ups, using the same edit
generator for both arms. Cells give CLI p50/p95 in ms, engine p50/p95 in ms,
and held MiB. Held RSS is the resident engine plus Node's RSS growth since
opening the checkout.

| Repository and file | Append | Prepend | Insert call |
|---|---:|---:|---:|
| Hono `src/hono-base.ts` | 33.9/34.6 · 15.2/15.4 · 52.4 → 34.2/36.3 · 15.8/16.0 · 47.4 | 328.7/333.2 · 309.2/311.5 · 111.6 → 35.5/38.1 · 16.6/16.9 · 49.2 | 326.5/329.9 · 306.9/309.6 · 110.3 → 36.7/37.6 · 17.8/18.1 · 64.3 |
| Flask `src/flask/app.py` | 35.0/36.4 · 17.5/17.8 · 42.1 → 35.5/37.0 · 18.2/18.6 · 38.0 | 56.7/58.1 · 39.5/39.8 · 43.8 → 35.4/37.2 · 18.2/18.5 · 40.7 | 54.9/57.1 · 38.5/39.4 · 49.7 → 37.1/43.2 · 19.6/19.8 · 45.9 |
| ripgrep `crates/core/main.rs` | 26.6/28.6 · 9.9/11.0 · 34.5 → 26.9/28.7 · 10.1/10.4 · 36.3 | 77.5/79.0 · 61.2/61.5 · 51.7 → 28.1/29.1 · 10.7/11.1 · 35.8 | 76.4/80.9 · 60.8/61.3 · 48.0 → 27.5/28.9 · 11.1/11.3 · 38.1 |
| NestJS `packages/core/nest-factory.ts` | 30.5/31.8 · 14.5/15.0 · 66.0 → 30.8/34.7 · 14.1/14.5 · 64.8 | 453.9/457.9 · 437.4/440.5 · 202.0 → 33.3/39.2 · 15.8/18.6 · 66.0 | 449.2/453.0 · 432.4/437.0 · 203.6 → 34.7/38.0 · 18.1/18.6 · 86.0 |
| novu `apps/api/src/app.module.ts` | 44.8/46.3 · 23.2/23.9 · 159.0 → 38.7/42.2 · 18.8/19.3 · 158.6 | 2642.8/2652.3 · 2619.8/2629.7 · 818.9 → 38.5/40.1 · 19.0/19.5 · 155.1 | 2674.4/2698.1 · 2650.4/2676.3 · 817.6 → 48.3/49.7 · 27.0/28.0 · 193.2 |

Novu held 158.6 MiB after append, 155.1 after prepend and 193.2 after
inserted calls. The export-only run ended at 262.5 MiB. The mixed run
reached 254.1 MiB across 26 edits. The surface-only reverse index loaded
in 21.6 ms median (21.2–21.9 ms) across the export run.

### Novu one-shot refresh

Three fresh bases per arm and edit. Times give the median and [min–max]
end-to-end milliseconds. The app-module prepend and append each re-extracted
and rewrote one file.

| Edit | `8f91b9cc` | Stage 2c |
|---|---:|---:|
| Prepend to `apps/api/src/app.module.ts` | 2707 [2689–2842] | 805 [795–805] |
| Append to `apps/api/src/app.module.ts` | 842 [816–853] | 805 [798–805] |
| `measure.mjs` append to `apps/api/src/app/workflows-v2/workflow.controller.e2e.ts` | 837 [828–873] | 889 [847–895] |

The app-module prepend meets the 1 s target. Its append is 37 ms faster.
The append selected by `measure.mjs` misses baseline parity by 52 ms
(6.2%). The Rust refresh job in that series fell from 60.9 to 59.3 ms.
The regression is in the end-to-end overhead outside the engine.
Node's base identity hash took 82.8 ms instead of 76.0 ms as the base grew.
Source capture rose from 213.8 to 219.7 ms. The recorded phases explain
part of the wall-time difference.
Neither position-only edit needs to load the reverse dependency index.
The 6 one-shot replay steps that built it took 26.4 ms median
(21.3–31.8 ms) for the reverse index alone.

### Novu cold phases

Median milliseconds. The stage 2b column records the regression
profile. The incremental timer in stage 2c includes the streamed private
and public writes. The ECMAScript timer covers the resolver and import
binding pass.

| Phase | `8f91b9cc` | Stage 2b | Stage 2c |
|---|---:|---:|---:|
| Rust job | 8509 | 15200 | 8973 |
| `extract` | 3140 | — | 3327 |
| Resolve, baseline aggregate | 411 | — | — |
| `resolve.incremental` | — | 3500 | 1885 |
| `resolve.ecmascript` | — | 900 | 527 |
| `resolve.dependencies` | — | 1300 | 167 |
| `v5.write` | 4958 | 11900 | 5636 |
| `v5.finish` | 813 | 3500 | 934 |
| `v5.indexes` | 343 | 2190 | 420 |
| `v5.relationships` | 1370 | 1900 | 933 |
| `v5.writeOutgoing` | — | 1300 | 778 |
| `v5.resolutionDigest` | 596 | — | 144 |
| `v5.resolutionInputs` | — | — | 129 |
| `v5.optimizeFts` | 207 | 600 | 201 |
| `v5.fingerprintNeighbours` | 125 | 280 | 137 |
| `v5.reclaimPages` | — | — | 3 |

- Resolver memo reads share ordinals. The recorder interns a distinct lookup
  spelling once and writes one packed row per origin. ECMAScript keeps at
  most 3,072 derived lexical models cached, and its most common binding and
  member buckets store a single ordinal inline. Signature preparation builds
  only the binding proof it needs and overlaps declaration writes on large
  bases with a single producer.
- Public relationships stream from the in-memory projection. Only owners of
  incoming callbacks need projection readback after all their sites are
  known. Typed edge evidence borrows from facts during staging. Numeric node
  endpoints avoid reparsing public ID text while writing. The comparable digest
  uses binary public IDs and takes 144 ms, down from 596 ms in the baseline.
- Compact origin blobs replace both the per-read table entries and their
  secondary index. Heritage, callbacks and type declarations use integer keys.
  Large stores index an eight-byte body-hash prefix for continuity probes
  and check the full hash for every match. The body-hash prefix and remaining
  small private indexes are additional work in the finish phase.
- FTS optimization runs against a much smaller write working set. A probe
  with packed reads still spent 575 ms optimizing FTS while it reread every
  origin projection. The streamed build brought that phase to roughly 201 ms.
  Reclaiming the base's free pages afterward took 3.3 ms in this series.
  The fingerprint-neighbour pass reads target pairs from the covering edge
  index and inserts the two directions in primary-key order.

### Novu base allocation

One median-size stage 2c base from `dbstat`. The 2,904 projection blocks
hold 11,707,828 compressed bytes in 11,927,552 bytes of SQLite pages.
Block payloads peak at 4,032 bytes. The 8,681 read blobs hold 2,244,160
bytes and peak at 2,788 bytes. Neither table has overflow pages in this
sample. The database has zero freelist pages. SQLite's 64 pointer-map pages
account for the remaining 262,144 bytes outside the `dbstat` allocation.
The base uses its public file table for paths. Overlays add a dictionary
for paths absent from the base.

| Table or index | Bytes |
|---|---:|
| `fingerprints` | 40,742,912 |
| `nodes` | 33,443,840 |
| `source_chunks_fts_data` | 27,250,688 |
| `edges` | 26,251,264 |
| `nodes_fts_data` | 15,388,672 |
| `resolution_blocks` | 11,927,552 |
| `edges_target` | 6,905,856 |
| `unresolved_calls` | 5,578,752 |
| `sqlite_autoindex_nodes_1` | 4,493,312 |
| `nodes_name` | 4,149,248 |
| `nodes_lower_name` | 4,149,248 |
| `resolution_reads` | 2,789,376 |
| `nodes_body_hash` | 2,523,136 |
| `unresolved_calls_source` | 2,420,736 |
| `nodes_fts_docsize` | 2,269,184 |
| `unresolved_calls_name` | 2,265,088 |
| `sqlite_autoindex_unresolved_names_1` | 2,142,208 |
| `nodes_file_line` | 2,129,920 |
| `unresolved_names` | 1,888,256 |
| `nodes_parent` | 1,777,664 |
| `fingerprint_neighbours` | 1,675,264 |
| `fingerprint_neighbours_neighbour` | 1,650,688 |
| `files` | 1,646,592 |
| `source_observations` | 1,531,904 |
| `node_attributes` | 1,015,808 |
| `resolution_keys` | 860,160 |
| `sqlite_autoindex_files_1` | 815,104 |
| `unresolved_other` | 565,248 |
| `sqlite_autoindex_resolution_names_1` | 516,096 |
| `resolution_names` | 454,656 |
| `file_resolution` | 450,560 |
| `meta` | 380,928 |
| `source_chunks` | 368,640 |
| `source_chunks_fts_docsize` | 335,872 |
| `coverage_directories` | 335,872 |
| `source_chunks_file` | 299,008 |
| `unresolved_other_source` | 290,816 |
| `unresolved_other_name` | 270,336 |
| `resolution_inputs` | 233,472 |
| `resolution_callbacks` | 94,208 |
| `source_chunks_fts_idx` | 77,824 |
| `nodes_fts_idx` | 61,440 |
| `edges_site_file` | 28,672 |
| `sqlite_schema` | 24,576 |
| `resolution_heritage_origin` | 24,576 |
| `resolution_heritage` | 24,576 |
| `sqlite_autoindex_resolution_callbacks_1` | 16,384 |
| `unresolved_calls_written_name` | 12,288 |
| `resolution_callbacks_origin` | 12,288 |
| `unresolved_reasons` | 4,096 |
| `unresolved_calls_candidate` | 4,096 |
| `sqlite_autoindex_unresolved_reasons_1` | 4,096 |
| `sqlite_autoindex_resolution_methods_1` | 4,096 |
| `sqlite_autoindex_provenances_1` | 4,096 |
| `sqlite_autoindex_node_kinds_1` | 4,096 |
| `sqlite_autoindex_languages_1` | 4,096 |
| `sqlite_autoindex_edge_kinds_1` | 4,096 |
| `source_observation_gaps` | 4,096 |
| `source_chunks_fts_config` | 4,096 |
| `snapshot` | 4,096 |
| `resolution_types_origin` | 4,096 |
| `resolution_types` | 4,096 |
| `resolution_methods` | 4,096 |
| `resolution_frameworks` | 4,096 |
| `provenances` | 4,096 |
| `nodes_fts_config` | 4,096 |
| `node_kinds` | 4,096 |
| `languages` | 4,096 |
| `grounded_body_hash` | 4,096 |
| `file_diagnostics` | 4,096 |
| `edge_kinds` | 4,096 |
| `coverage_summary` | 4,096 |
| `coverage_extensions` | 4,096 |
| `coverage` | 4,096 |
| `aliases_node` | 4,096 |
| `aliases` | 4,096 |
| `_mex_grounded_source` | 4,096 |

### Stage 2c verification

Each replay compared the warm and one-shot refresh publications with an
independent cold build at every step. All 407 edits per arm published an
overlay. The two Novu arms ran serially with a 4 GiB free-space check before
each run.

| Replay | Edits per arm | Point reads per arm | Searches per arm | Warm differences | Refresh differences |
|---|---:|---:|---:|---:|---:|
| Hono | 43 | 1,032 | 516 | 0 | 0 |
| Flask | 18 | 432 | 252 | 0 | 0 |
| ripgrep | 13 | 312 | 156 | 0 | 0 |
| novu | 13 | 312 | 130 | 0 | 0 |
| TypeScript seed | 160 | 1,120 | 1,920 | 0 | 0 |
| Python seed | 160 | 800 | 1,600 | 0 | 0 |

The first changed refresh against an `8f91b9cc` base published a new full
base. Rust formatting, workspace Clippy with `-D warnings`, all 108 Rust
tests and `tsc --noEmit` passed. Vitest passed 892 graph tests. The sole
failure was the existing `storage.test.ts` network-home assertion. The
candidate-process test used a checkout-local fixture cache to preserve the
shared dependency directory.

### Independent re-check

A second set of runs on the same machine, after cherry-picking stage 2c onto
the PR branch, used the `8f91b9cc` engine and a CLI built at `8f91b9cc`.

| novu | `8f91b9cc` | Stage 2c |
|---|---:|---:|
| Cold build, three alternating pairs, median [min–max] | 12.84 s [12.81–13.36] | 14.05 s [13.07–14.86] |
| Engine `job`, two pairs, mean | 8.62 s | 9.07 s (+5.1%) |
| Peak tree RSS, median | 951 MiB | 973 MiB (1,020 MB) |
| Graph base | 199.6 MB | 214.9 MB |

Stage 2c's arm was slower in every wall-clock pair, by 0.2–1.5 s. The engine
phases put the steady difference at about 0.44 s. The new private state
costs `resolve.incremental` 2.05 s and `v5.writeOutgoing` 0.84 s. Against
that, the old `project`, `resolve` and `v5.resolutionDigest` phases, 2.4 s
together, are gone, and `v5.relationships` is 0.39 s faster. Part of
resolution now overlaps with extraction, which slows `extract` by about
0.2 s. Novu stays under the 15 s target. Peak RSS is under 1 GiB but over
the decimal 1 GB, and `8f91b9cc` was already at 997 MB.

Warm p50 on the same five files was 26–39 ms for append and prepend
and 28–47 ms for inserted calls, with novu holding at most 205 MiB.
Novu's app-module prepend refresh was 804–859 ms when the file was written
in place. **When the editor saves by writing a temporary file and renaming
it over the original** (vim's backup copy, JetBrains' safe write), the same
edit took 1.11–1.38 s. The engine `job` stayed at about 32 ms. Node recaptured
coverage instead of reusing the walk observation (282 ms), and the engine
call's wall time rose from 60 to 334 ms. This is not a stage 2c regression,
but a save by rename still misses the 1 s target on novu.

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
