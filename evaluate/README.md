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

**Category 3 — end-to-end agent (variants A–D)** is planned (`agent-e2e.mjs`,
`fixtures/nl-tasks.json`) and settles the default `--detail` level on accumulated
task cost. Not yet built.

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
