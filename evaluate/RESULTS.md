# Graph retrieval benchmark results

Evaluation date: 2026-08-19 to 2026-08-20

Candidate: mex 0.7.2 source-backed Scope

Harnesses: `evaluate/compare/` for headless agent comparison and `evaluate/graph/` for deterministic retrieval, source-span, flow, budget, and integrity checks.

## Headless files-baseline comparison

The pilot used 12 natural-language tasks: six against Hono and six against MEX. Each task ran once with each arm:

- **Files baseline:** ordinary Read/Grep/Glob-style repository search.
- **Candidate:** exactly one forced-first `mex graph scope` request, followed by permitted file reads when necessary.

Arm order was balanced. All 24 Claude Sonnet sessions passed execution, permission, subject-identity, command-bundle, and token-accounting checks. Answers were anonymized and graded against source before arm identity was revealed.

| Metric | Files baseline | Candidate | Candidate change |
|---|---:|---:|---:|
| Valid sessions | 12/12 | 12/12 | No invalid runs |
| Blind-correct answers | 6/12 (50.0%) | 7/12 (58.3%) | **+1 answer** |
| New tokens | 393,637 | 179,179 | **-54.5%** |
| Processed tokens | 3,348,865 | 920,544 | **-72.5%** |
| Estimated cost | $3.6973 | $1.6061 | **-56.6%** |
| Mean latency per answer | 45.62 s | 35.17 s | **-22.9%** |

`New tokens` are uncached input plus cache writes and output. `Processed tokens` additionally include cache reads. The median paired new-token change across the 12 tasks was -47.0%.

## Retrieval quality

| Measure | Combined | Hono | MEX |
|---|---:|---:|---:|
| Required-file task hits in first response | 11/12 | 6/6 | 5/6 |
| Required source spans returned | 22/23 | 14/14 | 8/9 |
| Graph evidence coverage | 12/12 | 6/6 | 6/6 |
| Required directed flows | — | 6/6 | N/A |
| Mean distinct Scope queries per candidate run | 1.0 | 1.0 | 1.0 |

Hono candidate correctness was 4/6 versus 3/6 for files. Its total new-token reduction was 7.4%, while the paired macro-median reduction was 10.0%; schema-retry-heavy tasks produced high variance. MEX correctness was tied at 3/6, with a 72.3% total new-token reduction.

## Deterministic holdouts

Fresh native suites independently checked retrieval without a model:

| Suite | Runs | File@5 | Source-span recall | Graph coverage | Budget | Other ranked metrics |
|---|---:|---:|---:|---:|---:|---|
| TypeScript `src/compiler` | 6/6 | 1.0 | 1.0 | 1.0 | 1.0 | Source-first suite; fact R@5/MRR are not applicable |
| Mixed TypeScript/Python/Rust synthetic | 9/9 | 1.0 | 1.0 | 1.0 | 1.0 | R@5 0.9167, MRR 0.875, nDCG@10 0.9095 |

Both suites produced identical normalized graph hashes across two rebuilds. Integrity gates found no extraction/storage loss, duplicate or dangling graph rows, FTS drift, invalid confidence values, or suspicious production-to-test edges.

## Limits on interpretation

- This was one repetition per task and one model. Per-task efficiency and correctness remain noisy.
- The headless pilot compares the candidate with files-only search. It does **not** include the released `main` graph implementation as an arm.
- TypeScript testing uses a sparse checkout of the real repository's complete `src/compiler` subtree, not the full TypeScript monorepo.
- Classical fact R@5/MRR/nDCG are meaningful for fact-emitting suites. Source-first holdouts instead gate the required files, exact source spans, real graph evidence, flows when declared, and output budget.
- The richer compiler-backed graph uses more disk than 0.7.1; storage and incremental/no-op build optimization are follow-up work.

These results support the release claim that source-backed Scope can reduce agent context while preserving or slightly improving answer correctness in this pilot. They do not establish a universal token-savings percentage.

## Reproduce

```bash
npm ci
npm run build
npm run eval:test
node evaluate/graph/index.mjs --help
node evaluate/compare/index.mjs --help
```

Native suites are local and deterministic. Headless comparison requires the configured model CLI, consumes model quota, and should use a fresh output directory with the exact suite and subject revisions recorded in its prepare manifest.
