# MEX Graph Eval Harness

Black-box evaluation of the `mex graph` agent surface. Every measurement shells
out to the built CLI (`dist/cli.js`) exactly as an agent would — no internals are
imported.

## Run

```bash
npm run build      # harness runs against dist/cli.js, so build first
npm run eval
```

Flags (pass after `--`, e.g. `npm run eval -- --no-rebuild`):

- `--root <dir>` — evaluate a different subject repo (default: this repo).
- `--no-rebuild` — reuse the existing `.mex/graph.db` instead of rebuilding.
- `--no-gate` — report only; don't exit non-zero on gate failure.

Results are written to `evaluate/results/` (gitignored): `efficiency.{json,csv}`
and `search-quality.{json,csv}`.

## Categories

**Category 1 — retrieval efficiency** (`efficiency.mjs`). For each task, compares
`graph scope` output size against the grep top-3 baseline and the whole source
corpus, and checks expected-symbol recall. The grep baseline, corpus enumeration,
recall rule, and `ceil(chars/4)` token count are reproduced bit-for-bit from the
prior ad-hoc benchmark so numbers stay comparable (see
`claude-talks/graph/EVAL_HARNESS_BUILD_PLAN.md` §3).

**Category 2 — search quality** (`search-quality.mjs`). `where-defined` foundRate
and rank (the committed gate); who-calls / what-calls fan-out counts for
visibility. Labeled caller/callee recall + MRR are a documented follow-up.

**Category 3 — end-to-end agent** (`agent-e2e.mjs`, `npm run eval:e2e`). Runs each
variant against the natural-language tasks and measures accumulated tokens across
ALL tool calls, follow-up `graph get` calls, Read/Grep fallbacks, and rubric
correctness. Winner = best correctness at lowest total tokens (NOT smallest first
response). Reduced from the plan's A–D: variant A (old all-source scope) was
removed in the M2 redesign, and C/D (flow-spine source, skeletonization) were
deferred — so the buildable comparison is `minimal` vs `source`, which is the
decision that actually sets the shipped default `--detail`.

Model-agnostic: the default **scripted reference driver** is a perfectly
disciplined agent (scope first; expand ids via `graph get`; never grep). It gives
an idealized token baseline but cannot reveal Read/Grep fallback — plug a real
model with `--driver <module>` (default-exports `(variant) => driver`) for a
correctness/fallback verdict.

**Real-model runner** (`agent-e2e-model.mjs`, `node evaluate/agent-e2e-model.mjs`):
drives a real headless agent (`claude -p`) per variant×task using the actual graph
CLI, and parses the stream-json transcript for tool calls, fallbacks, cost, turns,
and rubric correctness. Requires the `claude` CLI on PATH. Flags: `--root`,
`--limit <n>`, `--model <name>`.

Real-model result (opus-4-8, 5 NL tasks, this repo):

| variant | correct | mean cost | mean turns | mean get | mean Read/Grep fallback |
|---|---|---|---|---|---|
| minimal | 5/5 | $0.20 | 4.4 | 2.2 | 0.0 |
| source  | 5/5 | $0.17 | 3.0 | 0.0 | 1.0 |

Both variants answered every task correctly — the real model navigates the compact
manifest fine (the scripted driver's ~0.6 NL "recall" was a grading artifact, not a
real recall gap). `source` is answer-ready (fewer turns, marginally cheaper) but
falls back to Read/Grep ~once/task when its inline source is insufficient;
`minimal` is self-sufficient (zero fallback) at the cost of extra `get` round-trips.
Cost numbers are cache-dominated and noisy at N=5 — treat correctness/fallback as
the robust signals and re-run on a larger fixture set before freezing the default.

Findings so far (scripted driver, this repo): `minimal` mean ~1870 tok/task with
one `get` round-trip; `source` mean ~1430 tok/task in one shot — for these tasks
the one-shot `source` variant is *cheaper* because the compact manifest is nearly
as large as the source the task needs, then `get` pays again. **NL-query recall is
~0.6**, materially below the ~1.0 symbol recall: FTS-keyword selection misses
symbols whose names don't appear in the question (e.g. "how does scope decide
which nodes to return" surfaces the legacy `scopeSelect`, not `selectScope`). That
gap is a candidate for a future semantic-selection improvement, and the reason the
default-detail call should be re-run with a real model driver before it's frozen.

## Gates

`thresholds.json` holds the hard CI gates (floors, not exact-match assertions,
since numbers drift as the code evolves):

- `medianGrepTop3ToScope >= 1.0`
- `scopeExpectedRecall >= 0.85` (per task)
- `whereDefinedFoundRate >= 0.95`

Historical baseline (prior benchmark on `cg-main`): median grep-top3 ratio 1.35,
median corpus ratio 120.55, mean recall 1.0, `runDriftCheck` = 32 facts (the
known over-expansion case).

## Determinism

Graph reads are ordered deterministically (stable `ORDER BY` in
`src/graph/db/store.ts`), so a rebuilt graph yields byte-identical query output.
Unit coverage: `src/graph/__tests__/store-determinism.test.ts`.
